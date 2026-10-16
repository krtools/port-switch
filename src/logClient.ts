// Runs in the browser, not in Node: switch.ts inlines it into the log viewer page with
// logClient.toString(). So it must stay self-contained -- no imports, no references to
// anything outside the function.

export interface LogClientOptions {
  streamUrl: string;
  combined: boolean; // tag each line with its server's name
  tagWidth: number;
  names: string[]; // servers in this view (chips in the combined view)
}

interface Sgr {
  fg?: string | null;
  bg?: string | null;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
}

interface LineState {
  line: HTMLElement | null; // the line being written to, if it isn't finished
  lineStart: number; // child index after the name tag
  sgr: Sgr;
  carry: string; // an escape sequence or \r cut off at the end of the last chunk
  cr: boolean; // a \r is pending: the next text overwrites the line
}

type LogEvent =
  | { type: 'message'; data: { n: string; t: string } }
  | { type: 'reset'; data: { n: string; startedAt?: string | null } }
  | { type: 'run'; data: { n: string; label: string; startedAt?: string | null; endedAt?: string | null } }
  | { type: 'notice'; data: { n: string; text: string } };

type Mode = 'filter' | 'highlight';
interface Flags { case: boolean; word: boolean; re: boolean; inv: boolean }

/** Renders the SSE log stream (ANSI colors included) and the filter bar. */
export function logClient(opts: LogClientOptions): void {
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const out = $('out');
  const MAX_LINES = 5000;
  // xterm-ish palette, readable on the dark log background
  const PALETTE = ['#3b3f45', '#e06c6c', '#7fbf6a', '#d9b25c', '#6b9fe0', '#c67dd6', '#4fbfbf', '#cfd3d8',
    '#80868e', '#ff8a8a', '#a3e08f', '#f2d27a', '#8fbaff', '#e09ef0', '#7fe0e0', '#ffffff'];
  const ESC_AT_START = /^\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()#][0-9A-Za-z]|[@-Z\\-_])/;
  const TOKEN = /\x1b(?:\[([0-?]*)[ -/]*([@-~])|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()#][0-9A-Za-z]|[@-Z\\-_])|\r\n|\r|\n|[^\x1b\r\n]+/g;
  const streams: Record<string, LineState> = {};
  let paused = false;
  let queue: LogEvent[] = [];

  // ---- rendering ---------------------------------------------------------
  const color256 = (n: number): string => {
    if (n < 16) return PALETTE[n];
    if (n >= 232) { const v = 8 + (n - 232) * 10; return `rgb(${v},${v},${v})`; }
    n -= 16;
    const c = (x: number) => (x ? 55 + x * 40 : 0);
    return `rgb(${c(Math.floor(n / 36))},${c(Math.floor(n / 6) % 6)},${c(n % 6)})`;
  };

  function applySgr(st: Sgr, params: string): void {
    const p = params === '' ? [0] : params.split(';').map((x) => Number(x) || 0);
    for (let i = 0; i < p.length; i++) {
      const c = p[i];
      if (c === 0) Object.assign(st, { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false });
      else if (c === 1) st.bold = true;
      else if (c === 2) st.dim = true;
      else if (c === 3) st.italic = true;
      else if (c === 4) st.underline = true;
      else if (c === 7) st.inverse = true;
      else if (c === 22) st.bold = st.dim = false;
      else if (c === 23) st.italic = false;
      else if (c === 24) st.underline = false;
      else if (c === 27) st.inverse = false;
      else if (c >= 30 && c <= 37) st.fg = PALETTE[c - 30];
      else if (c >= 90 && c <= 97) st.fg = PALETTE[c - 82];
      else if (c >= 40 && c <= 47) st.bg = PALETTE[c - 40];
      else if (c >= 100 && c <= 107) st.bg = PALETTE[c - 92];
      else if (c === 39) st.fg = null;
      else if (c === 49) st.bg = null;
      else if (c === 38 || c === 48) {
        let col: string | null = null;
        if (p[i + 1] === 5) { col = color256(p[i + 2] || 0); i += 2; }
        else if (p[i + 1] === 2) { col = `rgb(${p[i + 2] || 0},${p[i + 3] || 0},${p[i + 4] || 0})`; i += 4; }
        if (c === 38) st.fg = col; else st.bg = col;
      }
    }
  }

  function styled(st: Sgr, text: string): Node {
    if (!st.fg && !st.bg && !st.bold && !st.dim && !st.italic && !st.underline && !st.inverse) return document.createTextNode(text);
    const el = document.createElement('span');
    el.textContent = text;
    let fg = st.fg;
    let bg = st.bg;
    if (st.inverse) [fg, bg] = [bg || '#111214', fg || '#d6d6d6'];
    if (fg) el.style.color = fg;
    if (bg) el.style.background = bg;
    if (st.bold) el.style.fontWeight = 'bold';
    if (st.dim) el.style.opacity = '0.6';
    if (st.italic) el.style.fontStyle = 'italic';
    if (st.underline) el.style.textDecoration = 'underline';
    return el;
  }

  const tagColor = (name: string): string => {
    let h = 0;
    for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return `hsl(${h},65%,68%)`;
  };

  function trim(): void {
    while (out.childElementCount > MAX_LINES) {
      const first = out.firstElementChild as HTMLElement;
      for (const st of Object.values(streams)) if (st.line === first) st.line = null;
      first.remove();
    }
  }

  function newLine(name: string, st: LineState): HTMLElement {
    const el = document.createElement('div');
    el.className = 'ln new'; // "new" = not checked against the filter yet
    el.dataset.n = name;
    if (opts.combined) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = name.padEnd(opts.tagWidth);
      tag.style.color = tagColor(name);
      el.append(tag);
    }
    st.lineStart = el.childNodes.length;
    out.append(el);
    st.line = el;
    trim();
    return el;
  }

  function sysLine(name: string, text: string, title = ''): void {
    const el = document.createElement('div');
    el.className = 'ln sys';
    el.dataset.n = name;
    el.textContent = text;
    if (title) el.title = title;
    out.append(el);
    for (const st of Object.values(streams)) st.line = null;
  }

  const stateFor = (name: string): LineState =>
    (streams[name] ||= { line: null, lineStart: 0, sgr: {}, carry: '', cr: false });

  function write(name: string, chunk: string): void {
    const st = stateFor(name);
    let text = st.carry + chunk;
    st.carry = '';
    // Hold back an escape sequence or \r cut off at the end of this chunk.
    const esc = text.lastIndexOf('\x1b');
    if (esc !== -1 && text.length - esc < 256 && !ESC_AT_START.test(text.slice(esc))) { st.carry = text.slice(esc); text = text.slice(0, esc); }
    if (text.endsWith('\r')) { st.carry = '\r' + st.carry; text = text.slice(0, -1); }

    for (const m of text.matchAll(TOKEN)) {
      const tok = m[0];
      if (tok === '\n' || tok === '\r\n') {
        if (!st.line) newLine(name, st);
        st.line = null;
        st.cr = false;
      } else if (tok === '\r') {
        st.cr = true; // like a terminal: what follows overwrites the line (progress bars)
      } else if (tok[0] === '\x1b') {
        if (m[2] === 'm') applySgr(st.sgr, m[1]);
        else if (m[2] === 'G') st.cr = true;
      } else {
        const line = st.line || newLine(name, st);
        if (st.cr) { while (line.childNodes.length > st.lineStart) (line.lastChild as ChildNode).remove(); st.cr = false; }
        line.append(styled(st.sgr, tok));
      }
    }
  }

  // ---- run markers ---------------------------------------------------------
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  const when = (iso: string, ref?: Date): string => {
    const d = new Date(iso);
    const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
    return ref && sameDay(d, ref) ? time : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
  };
  const duration = (ms: number): string => {
    const s = Math.max(0, Math.round(ms / 1000));
    const [d, h, m] = [Math.floor(s / 86400), Math.floor((s % 86400) / 3600), Math.floor((s % 3600) / 60)];
    return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`;
  };
  /** " · Oct 14, 5:02:11 PM → 6:40:05 PM (1h 38m)", or " · started …" for a run still going. */
  const span = (startedAt?: string | null, endedAt?: string | null): string => {
    if (!startedAt) return '';
    if (!endedAt) return ` · started ${when(startedAt)}`;
    return ` · ${when(startedAt)} → ${when(endedAt, new Date(startedAt))} (${duration(Date.parse(endedAt) - Date.parse(startedAt))})`;
  };

  function handle(ev: LogEvent): void {
    if (ev.type === 'notice') {
      sysLine(ev.data.n, `— ${ev.data.n}: ${ev.data.text} —`);
    } else if (ev.type === 'reset') {
      delete streams[ev.data.n]; // colors don't carry over between runs
      const at = ev.data.startedAt;
      sysLine(ev.data.n, `— ${ev.data.n}: server restarted${at ? ` · ${when(at)}` : ''} —`, at || '');
    } else if (ev.type === 'run') {
      delete streams[ev.data.n];
      const { startedAt, endedAt } = ev.data;
      sysLine(ev.data.n, `— ${ev.data.n}: ${ev.data.label}${span(startedAt, endedAt)} —`, [startedAt, endedAt].filter(Boolean).join(' → '));
    } else {
      write(ev.data.n, ev.data.t);
    }
  }

  // ---- filter --------------------------------------------------------------
  const q = $<HTMLInputElement>('q');
  const searchBox = $('search');
  const errEl = $('q-err');
  const countEl = $('count');
  const navEl = $('nav');
  const ctxSel = $<HTMLSelectElement>('ctx');
  const jumpBtn = $<HTMLButtonElement>('jump');
  const toggles: Record<keyof Flags, HTMLButtonElement> = {
    case: $('t-case'), word: $('t-word'), re: $('t-re'), inv: $('t-inv'),
  };
  const modeBtns: Record<Mode, HTMLButtonElement> = { filter: $('m-filter'), highlight: $('m-hl') };

  // State: the URL wins (so a filtered view can be bookmarked), then what this browser used last.
  const params = new URLSearchParams(location.search);
  let saved: Partial<Flags & { mode: Mode; ctx: number }> = {};
  try { saved = JSON.parse(localStorage.getItem('port-switch-filter') || '{}'); } catch {}
  const flag = (k: keyof Flags) => (params.has(k) ? params.get(k) === '1' : !!saved[k]);
  const flags: Flags = { case: flag('case'), word: flag('word'), re: flag('re'), inv: flag('inv') };
  let mode: Mode = (params.get('mode') || saved.mode) === 'highlight' ? 'highlight' : 'filter';
  let ctx = Math.min(10, Math.max(0, Number(params.get('ctx') ?? saved.ctx ?? 0) || 0));
  const hidden = new Set((params.get('hide') || '').split(',').filter((n) => opts.names.includes(n)));
  q.value = params.get('q') || '';

  let matcher: RegExp | null = null; // tests a line
  let finder: RegExp | null = null; // same, global: finds each match to highlight
  let hits: HTMLElement[] = []; // lines that match (in invert mode: that don't)
  let cur = -1; // the hit being looked at (Enter / arrows), -1 = none yet
  const canHighlight = typeof CSS !== 'undefined' && 'highlights' in CSS;

  function compile(): void {
    errEl.textContent = '';
    searchBox.classList.remove('bad');
    if (!q.value) { matcher = finder = null; return; }
    let src = flags.re ? q.value : q.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (flags.word) src = `\\b(?:${src})\\b`;
    try {
      const f = flags.case ? '' : 'i';
      const m = new RegExp(src, f);
      finder = new RegExp(src, `${f}g`);
      matcher = m;
    } catch (err) {
      // Keep the last good filter applied while the regex is half-typed.
      searchBox.classList.add('bad');
      errEl.textContent = String((err as Error).message).split(': ').pop() || 'Invalid regular expression';
    }
  }

  const filtering = () => !!matcher || hidden.size > 0;
  const isSys = (el: Element) => el.classList.contains('sys');
  /** A line's text without its server tag (what the filter searches). */
  const textNodes = (el: HTMLElement): Text[] => {
    const nodes: Text[] = [];
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) if (!n.parentElement?.classList.contains('tag')) nodes.push(n as Text);
    return nodes;
  };
  const lineText = (el: HTMLElement) => (opts.combined ? (el.textContent || '').slice(opts.tagWidth) : el.textContent || '');

  function rangesIn(el: HTMLElement, max: number): Range[] {
    if (!finder) return [];
    const nodes = textNodes(el);
    const text = nodes.map((n) => n.data).join('');
    const at = (pos: number): [Text, number] => {
      let acc = 0;
      for (const n of nodes) {
        if (pos <= acc + n.data.length) return [n, pos - acc];
        acc += n.data.length;
      }
      const last = nodes[nodes.length - 1];
      return [last, last.data.length];
    };
    const ranges: Range[] = [];
    finder.lastIndex = 0;
    for (let m = finder.exec(text); m && ranges.length < max; m = finder.exec(text)) {
      if (!m[0]) { finder.lastIndex++; continue; } // zero-width match (e.g. ^): nothing to mark
      const r = document.createRange();
      r.setStart(...at(m.index));
      r.setEnd(...at(m.index + m[0].length));
      ranges.push(r);
    }
    return ranges;
  }

  function paintHighlights(): void {
    if (!canHighlight) return;
    const reg = (CSS as unknown as { highlights: Map<string, unknown> }).highlights;
    reg.delete('ps-match');
    reg.delete('ps-current');
    if (!finder || flags.inv) return;
    const H = (window as unknown as { Highlight: new (...r: Range[]) => unknown }).Highlight;
    const all: Range[] = [];
    // Visible lines only, and a cap so a match-everything regex can't stall the page.
    for (const el of hits) {
      if (all.length > 4000) break;
      if (el.offsetParent !== null) all.push(...rangesIn(el, 50));
    }
    reg.set('ps-match', new H(...all));
    if (hits[cur]) reg.set('ps-current', new H(...rangesIn(hits[cur], 50)));
  }

  function updateCount(total: number): void {
    if (!matcher) { countEl.textContent = hidden.size ? `${total.toLocaleString()} lines` : ''; return; }
    countEl.innerHTML = mode === 'highlight' && cur >= 0
      ? `<b>${cur + 1}</b> of ${hits.length.toLocaleString()}`
      : `<b>${hits.length.toLocaleString()}</b> of ${total.toLocaleString()} lines`;
  }

  /** Re-check every line against the filter (cheap enough for 5000 lines, throttled while streaming). */
  function apply(): void {
    const stick = atBottom();
    const lines: HTMLElement[] = [];
    for (const el of Array.from(out.children) as HTMLElement[]) {
      el.classList.remove('new', 'ctx', 'gap');
      const serverHidden = hidden.has(el.dataset.n || '');
      el.classList.toggle('hide', serverHidden);
      if (!serverHidden && !isSys(el)) lines.push(el);
    }
    const prevCur = hits[cur];
    hits = [];
    if (matcher) {
      const m = matcher;
      const match = lines.map((el) => m.test(lineText(el)) !== flags.inv);
      lines.forEach((el, i) => { if (match[i]) hits.push(el); });
      if (mode === 'filter') {
        // Show matches plus `ctx` lines either side; mark where a gap was cut out.
        const show = match.slice();
        if (ctx) {
          // Context comes from the same server's lines (in the combined view, the
          // neighbouring line is often another server's, which says nothing about the match).
          const byServer: Record<string, number[]> = {};
          lines.forEach((el, i) => { (byServer[el.dataset.n || ''] ||= []).push(i); });
          for (const idx of Object.values(byServer)) {
            idx.forEach((i, k) => {
              if (!match[i]) return;
              for (let j = Math.max(0, k - ctx); j <= Math.min(idx.length - 1, k + ctx); j++) show[idx[j]] = true;
            });
          }
        }
        let shownBefore = false;
        lines.forEach((el, i) => {
          if (!show[i]) { el.classList.add('hide'); return; }
          if (!match[i]) el.classList.add('ctx');
          if (ctx && shownBefore && !show[i - 1]) el.classList.add('gap'); // like grep's "--", only with context
          shownBefore = true;
        });
        // A run divider stays only if some of its run's lines are shown (so matches keep
        // their "which run, when" context without a pile of empty dividers).
        const pending: Record<string, HTMLElement | undefined> = {};
        for (const el of Array.from(out.children) as HTMLElement[]) {
          const n = el.dataset.n || '';
          if (isSys(el)) { if (!el.classList.contains('hide')) { el.classList.add('hide'); pending[n] = el; } }
          else if (!el.classList.contains('hide') && pending[n]) { pending[n]!.classList.remove('hide'); pending[n] = undefined; }
        }
      }
    }
    cur = prevCur ? hits.indexOf(prevCur) : -1;
    out.classList.toggle('filtering', mode === 'filter' && !!matcher);
    updateCount(lines.length);
    paintHighlights();
    if (stick) out.scrollTop = out.scrollHeight;
  }

  let applyTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleApply = (ms = 150) => { if (applyTimer === undefined) applyTimer = setTimeout(() => { applyTimer = undefined; apply(); }, ms); };

  function saveState(): void {
    const p = new URLSearchParams(location.search);
    const set = (k: string, v: string | false) => { if (v) p.set(k, v); else p.delete(k); };
    set('q', q.value);
    (Object.keys(flags) as (keyof Flags)[]).forEach((k) => set(k, flags[k] && '1'));
    set('mode', mode === 'highlight' && 'highlight');
    set('ctx', ctx > 0 && String(ctx));
    set('hide', [...hidden].join(','));
    const s = p.toString();
    history.replaceState(null, '', s ? `?${s}` : location.pathname);
    try { localStorage.setItem('port-switch-filter', JSON.stringify({ ...flags, mode, ctx })); } catch {}
  }

  function refresh(): void {
    compile();
    cur = -1;
    apply();
    saveState();
  }

  /** Enter / Shift+Enter / arrows: step through the hits, starting from what's on screen. */
  function step(dir: 1 | -1): void {
    if (!hits.length) return;
    if (cur < 0) {
      const top = out.scrollTop;
      const bottom = top + out.clientHeight;
      const idx = dir === 1 ? hits.findIndex((el) => el.offsetTop >= top) : findLastIndex(hits, (el) => el.offsetTop <= bottom);
      cur = idx >= 0 ? idx : dir === 1 ? 0 : hits.length - 1;
    } else {
      cur = (cur + dir + hits.length) % hits.length;
    }
    hits[cur].scrollIntoView({ block: 'center' });
    updateCount(Array.from(out.children).filter((el) => !isSys(el) && !el.classList.contains('hide')).length);
    paintHighlights();
  }
  const findLastIndex = <T>(arr: T[], fn: (x: T) => boolean) => { for (let i = arr.length - 1; i >= 0; i--) if (fn(arr[i])) return i; return -1; };

  function setMode(m: Mode): void {
    mode = m;
    for (const k of Object.keys(modeBtns) as Mode[]) modeBtns[k].setAttribute('aria-pressed', String(k === m));
    ctxSel.hidden = m !== 'filter';
    navEl.hidden = m !== 'highlight';
  }

  let qTimer: ReturnType<typeof setTimeout> | undefined;
  q.addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(refresh, 80); });
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
    else if (e.key === 'Escape') { if (q.value) { q.value = ''; refresh(); } else q.blur(); }
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); q.focus(); q.select(); }
  });
  (Object.keys(toggles) as (keyof Flags)[]).forEach((k) => {
    toggles[k].setAttribute('aria-pressed', String(flags[k]));
    toggles[k].onclick = () => { flags[k] = !flags[k]; toggles[k].setAttribute('aria-pressed', String(flags[k])); refresh(); };
  });
  $<HTMLButtonElement>('q-clear').onclick = () => { q.value = ''; refresh(); q.focus(); };
  (Object.keys(modeBtns) as Mode[]).forEach((k) => { modeBtns[k].onclick = () => { setMode(k); refresh(); }; });
  ctxSel.value = String(ctx);
  ctxSel.onchange = () => { ctx = Number(ctxSel.value) || 0; refresh(); };
  $<HTMLButtonElement>('nav-prev').onclick = () => step(-1);
  $<HTMLButtonElement>('nav-next').onclick = () => step(1);
  setMode(mode);

  // Server chips (combined view): click hides/shows a server, Alt+click shows only it.
  const chipBox = document.getElementById('servers');
  if (chipBox && opts.combined) {
    for (const name of opts.names) {
      const b = document.createElement('button');
      b.className = 'schip';
      b.textContent = name;
      b.style.color = tagColor(name);
      b.title = 'Click to hide or show · Alt+click to show only this one';
      b.setAttribute('aria-pressed', String(!hidden.has(name)));
      b.onclick = (e) => {
        if (e.altKey) {
          const solo = hidden.size === opts.names.length - 1 && !hidden.has(name);
          hidden.clear();
          if (!solo) for (const n of opts.names) if (n !== name) hidden.add(n);
        } else if (hidden.has(name)) hidden.delete(name);
        else hidden.add(name);
        for (const c of Array.from(chipBox.querySelectorAll<HTMLButtonElement>('.schip'))) c.setAttribute('aria-pressed', String(!hidden.has(c.textContent || '')));
        refresh();
      };
      chipBox.append(b);
    }
  }

  // "Jump to": from a filtered line back to the same spot in the full log.
  let hovered: HTMLElement | null = null;
  const hideJump = () => { jumpBtn.style.display = 'none'; hovered = null; };
  out.addEventListener('mouseover', (e) => {
    const el = (e.target as Element).closest('.ln') as HTMLElement | null;
    if (!el || isSys(el) || !(mode === 'filter' && matcher) || el === hovered) return;
    hovered = el;
    const r = el.getBoundingClientRect();
    const o = out.getBoundingClientRect();
    jumpBtn.style.display = 'inline-flex';
    jumpBtn.style.top = `${r.top + (r.height - jumpBtn.offsetHeight) / 2}px`;
    jumpBtn.style.left = `${o.left + out.clientWidth - jumpBtn.offsetWidth - 10}px`;
  });
  out.addEventListener('mouseleave', (e) => { if (e.relatedTarget !== jumpBtn) hideJump(); });
  out.addEventListener('scroll', hideJump);
  jumpBtn.addEventListener('mouseleave', (e) => { if (!out.contains(e.relatedTarget as Node)) hideJump(); });
  jumpBtn.onclick = () => {
    const el = hovered;
    hideJump();
    if (!el) return;
    q.value = '';
    refresh();
    el.scrollIntoView({ block: 'center' });
    el.classList.remove('flash');
    void el.offsetWidth; // restart the animation
    el.classList.add('flash');
  };

  // ---- stream, scrolling, toolbar ------------------------------------------------
  const atBottom = () => out.scrollHeight - out.scrollTop - out.clientHeight < 40;
  const bottomBtn = $<HTMLButtonElement>('bottom');
  function render(events: LogEvent[]): void {
    const stick = atBottom();
    events.forEach(handle);
    if (stick) out.scrollTop = out.scrollHeight;
    bottomBtn.style.display = atBottom() ? 'none' : 'block';
    if (filtering()) scheduleApply();
  }
  out.addEventListener('scroll', () => { bottomBtn.style.display = atBottom() ? 'none' : 'block'; });
  bottomBtn.onclick = () => { out.scrollTop = out.scrollHeight; };

  function receive(type: LogEvent['type'], e: MessageEvent<string>): void {
    const ev = { type, data: JSON.parse(e.data) } as LogEvent;
    if (paused) queue.push(ev); else render([ev]);
  }

  const conn = $('conn');
  const connText = $('conn-text');
  const setConn = (cls: string, text: string) => { conn.className = `pill ${cls}`; connText.textContent = text; };
  const source = new EventSource(opts.streamUrl);
  source.onmessage = (e) => receive('message', e);
  for (const type of ['reset', 'run', 'notice'] as const) {
    source.addEventListener(type, (e) => receive(type, e as MessageEvent<string>));
  }
  source.onopen = () => setConn('ok', 'Live');
  source.onerror = () => {
    if (source.readyState === EventSource.CLOSED) setConn('danger', 'Disconnected: reload, or log in again');
    else setConn('warn', 'Reconnecting');
  };

  const pauseBtn = $<HTMLButtonElement>('pause');
  pauseBtn.onclick = () => {
    paused = !paused;
    pauseBtn.setAttribute('aria-pressed', String(paused));
    pauseBtn.textContent = paused ? 'Resume' : 'Pause';
    if (!paused) { const pending = queue; queue = []; render(pending); }
  };
  const wrapBtn = $<HTMLButtonElement>('wrap');
  const setWrap = (on: boolean) => {
    out.classList.toggle('wrap', on);
    wrapBtn.setAttribute('aria-pressed', String(on));
    try { localStorage.setItem('port-switch-wrap', on ? '1' : ''); } catch {}
  };
  wrapBtn.onclick = () => setWrap(!out.classList.contains('wrap'));
  try { setWrap(!!localStorage.getItem('port-switch-wrap')); } catch {}
  $<HTMLButtonElement>('clear').onclick = () => {
    out.textContent = '';
    for (const st of Object.values(streams)) st.line = null;
    apply();
  };

  compile();
  apply();
}
