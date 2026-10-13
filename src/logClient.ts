// Runs in the browser, not in Node: switch.ts inlines it into the log viewer page with
// logClient.toString(). So it must stay self-contained -- no imports, no references to
// anything outside the function.

export interface LogClientOptions {
  streamUrl: string;
  combined: boolean; // tag each line with its server's name
  tagWidth: number;
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
  | { type: 'reset'; data: { n: string } }
  | { type: 'run'; data: { n: string; label: string } }
  | { type: 'notice'; data: { n: string; text: string } };

/** Renders the SSE log stream, including ANSI colors. */
export function logClient(opts: LogClientOptions): void {
  const out = document.getElementById('out') as HTMLElement;
  const MAX_LINES = 5000;
  // xterm-ish palette, readable on the dark log background
  const PALETTE = ['#3b3f45', '#e06c6c', '#7fbf6a', '#d9b25c', '#6b9fe0', '#c67dd6', '#4fbfbf', '#cfd3d8',
    '#80868e', '#ff8a8a', '#a3e08f', '#f2d27a', '#8fbaff', '#e09ef0', '#7fe0e0', '#ffffff'];
  const ESC_AT_START = /^\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()#][0-9A-Za-z]|[@-Z\\-_])/;
  const TOKEN = /\x1b(?:\[([0-?]*)[ -/]*([@-~])|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()#][0-9A-Za-z]|[@-Z\\-_])|\r\n|\r|\n|[^\x1b\r\n]+/g;
  const streams: Record<string, LineState> = {};
  let paused = false;
  let queue: LogEvent[] = [];

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
    el.className = 'ln';
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

  function sysLine(text: string): void {
    const el = document.createElement('div');
    el.className = 'ln sys';
    el.textContent = text;
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

  function handle(ev: LogEvent): void {
    if (ev.type === 'notice') {
      sysLine(`— ${ev.data.n}: ${ev.data.text} —`);
    } else if (ev.type === 'reset' || ev.type === 'run') {
      const name = ev.data.n;
      delete streams[name]; // colors don't carry over between runs
      sysLine(ev.type === 'reset' ? `— ${name}: server restarted —` : `— ${name}: ${ev.data.label} —`);
    } else {
      write(ev.data.n, ev.data.t);
    }
  }

  const atBottom = () => out.scrollHeight - out.scrollTop - out.clientHeight < 40;
  const bottomBtn = document.getElementById('bottom') as HTMLButtonElement;
  function render(events: LogEvent[]): void {
    const stick = atBottom();
    events.forEach(handle);
    if (stick) out.scrollTop = out.scrollHeight;
    bottomBtn.style.display = atBottom() ? 'none' : 'block';
  }
  out.addEventListener('scroll', () => { bottomBtn.style.display = atBottom() ? 'none' : 'block'; });
  bottomBtn.onclick = () => { out.scrollTop = out.scrollHeight; };

  function receive(type: LogEvent['type'], e: MessageEvent<string>): void {
    const ev = { type, data: JSON.parse(e.data) } as LogEvent;
    if (paused) queue.push(ev); else render([ev]);
  }

  const conn = document.getElementById('conn') as HTMLElement;
  const connText = document.getElementById('conn-text') as HTMLElement;
  const setConn = (cls: string, text: string) => { conn.className = `conn ${cls}`; connText.textContent = text; };
  const source = new EventSource(opts.streamUrl);
  source.onmessage = (e) => receive('message', e);
  for (const type of ['reset', 'run', 'notice'] as const) {
    source.addEventListener(type, (e) => receive(type, e as MessageEvent<string>));
  }
  source.onopen = () => setConn('live', 'live');
  source.onerror = () => {
    if (source.readyState === EventSource.CLOSED) setConn('dead', 'disconnected (reload, or log in again)');
    else setConn('wait', 'reconnecting');
  };

  const pauseBtn = document.getElementById('pause') as HTMLButtonElement;
  pauseBtn.onclick = () => {
    paused = !paused;
    pauseBtn.setAttribute('aria-pressed', String(paused));
    pauseBtn.textContent = paused ? 'Resume' : 'Pause';
    if (!paused) { const q = queue; queue = []; render(q); }
  };
  const wrapBtn = document.getElementById('wrap') as HTMLButtonElement;
  const setWrap = (on: boolean) => {
    out.classList.toggle('wrap', on);
    wrapBtn.setAttribute('aria-pressed', String(on));
    try { localStorage.setItem('port-switch-wrap', on ? '1' : ''); } catch {}
  };
  wrapBtn.onclick = () => setWrap(!out.classList.contains('wrap'));
  try { setWrap(!!localStorage.getItem('port-switch-wrap')); } catch {}
  (document.getElementById('clear') as HTMLButtonElement).onclick = () => {
    out.textContent = '';
    for (const st of Object.values(streams)) st.line = null;
  };
}
