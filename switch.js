#!/usr/bin/env node
// port-switch: a tiny zero-dependency reverse proxy that forwards everything on
// one port (default 3000) to whichever local server is currently "selected".
//
//   GET  /switch                -> page listing servers from servers.json (status, start/stop)
//   GET  /switch/{port}         -> make {port} the active target, redirect to /
//   POST /switch/{start|stop|restart}/{name}
//   GET  /switch/log/{name}     -> live log viewer (?raw: plain-text tail), /stream: SSE
//   GET  /switch/logs           -> every server's log combined, /stream: SSE
//   GET  /switch/api/state      -> {"target":3001,"name":"..."} (used by portctl)
//   GET|POST /switch/login, GET /switch/logout
//   anything else               -> proxied to the active target (incl. WebSockets)
// (/switch is proxy.path in servers.json)
//
// Everything under /switch needs SWITCH_PASSWORD (from .env): log in once in the browser
// for a long-lived cookie, or send "Authorization: Bearer <password>" (portctl does).
//
// Usage: node switch.js   or   portctl start proxy
// env: PORT HOST TARGET SWITCH_PASSWORD SWITCH_COOKIE_DAYS (default 365) SWITCH_COOKIE_DOMAIN

const http = require('http');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');
const launcher = require('./portctl');

// Timestamp every log line, and record why the process ends: the log (run/proxy.log
// under portctl) is the only trace. If it ends with none of these lines, the process
// got SIGKILL (e.g. the kernel OOM killer) or the log was cleared by a restart.
for (const level of ['log', 'error']) {
  const write = console[level].bind(console);
  console[level] = (...args) => write(new Date().toISOString(), ...args);
}
process.on('uncaughtException', (err, origin) => { // also unhandled rejections
  console.error(`[fatal] ${origin}:`, err);
  process.exit(1);
});
for (const [sig, num] of [['SIGTERM', 15], ['SIGINT', 2], ['SIGHUP', 1]]) {
  process.on(sig, () => { console.log(`[exit] received ${sig}`); process.exit(128 + num); });
}
process.on('exit', (code) => console.log(`[exit] code ${code}`));

const UPSTREAM_HOST = '127.0.0.1';
const ALLOW_UNREGISTERED = true; // allow /switch/{port} for ports not in servers.json

// servers.json is re-read on every /switch page load; keep the last good copy if it breaks.
let config;
let configError = null;
function reloadConfig() {
  try { config = launcher.loadConfig(); configError = null; } catch (err) { configError = err.message; }
  return config;
}
reloadConfig();
if (!config) {
  console.error(`[port-switch] ${configError}`);
  process.exit(1);
}

const SWITCH_PATH = config.proxy.path;
const LISTEN_PORT = Number(process.env.PORT) || config.proxy.port;
const LISTEN_HOST = process.env.HOST || '0.0.0.0';

let target = Number(process.env.TARGET) || config.servers[0]?.port || 3001;

// Open WebSocket tunnels, killed on switch so clients (e.g. HMR) reconnect to the new target.
const tunnels = new Set();

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const entryOf = (port) => config.servers.find((s) => s.port === port);
const nameOf = (port) => entryOf(port)?.name || `port ${port}`;

// ---- auth ------------------------------------------------------------------
// Cookie = "<expiry>.<HMAC(password, expiry)>": nothing stored server-side, and
// changing the password logs every browser out.
const PASSWORD = process.env.SWITCH_PASSWORD || '';
const COOKIE = 'port_switch_auth';
const COOKIE_MAX_AGE = (Number(process.env.SWITCH_COOKIE_DAYS) || 365) * 86400;
// Unset = host-only (just the exact host). A domain also covers all its subdomains.
const COOKIE_DOMAIN = process.env.SWITCH_COOKIE_DOMAIN || '';
if (COOKIE_DOMAIN && !/^\.?[a-z0-9-]+(\.[a-z0-9-]+)*$/i.test(COOKIE_DOMAIN)) {
  console.error(`[port-switch] bad SWITCH_COOKIE_DOMAIN: ${COOKIE_DOMAIN}`);
  process.exit(1);
}
const MAX_FAILURES = 20; // per 15 minutes, across all clients
const failures = [];

const sign = (exp) => crypto.createHmac('sha256', PASSWORD).update(`port-switch:${exp}`).digest('base64url');
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

function getCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return '';
}

function isAuthed(req) {
  if (!PASSWORD) return false;
  const bearer = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
  if (bearer) return safeEqual(bearer, PASSWORD);
  const [exp, sig] = getCookie(req, COOKIE).split('.');
  return Number(exp) > Date.now() / 1000 && !!sig && safeEqual(sig, sign(exp));
}

function authCookie(req, maxAge) {
  const exp = Math.floor(Date.now() / 1000) + maxAge;
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  const domain = COOKIE_DOMAIN ? `; Domain=${COOKIE_DOMAIN}` : '';
  return `${COOKIE}=${maxAge ? `${exp}.${sign(exp)}` : ''}; Path=${SWITCH_PATH}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${domain}${secure}`;
}

function tooManyFailures() {
  const cutoff = Date.now() - 15 * 60e3;
  while (failures.length && failures[0] < cutoff) failures.shift();
  return failures.length >= MAX_FAILURES;
}

// Only redirect back into /switch after logging in.
const safeNext = (next) => (typeof next === 'string' && (next === SWITCH_PATH || next.startsWith(SWITCH_PATH + '/') || next.startsWith(SWITCH_PATH + '?')) ? next : SWITCH_PATH);

function renderLogin(res, status, next, msg) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(page('Log in', `
<h1>Switch server</h1>
<p>Password required.</p>
${msg ? `<p class="msg">${esc(msg)}</p>` : ''}
<form class="custom" method="post" action="${SWITCH_PATH}/login">
  <input type="hidden" name="next" value="${esc(next)}">
  <input type="password" name="password" autocomplete="current-password" placeholder="password" autofocus required>
  <button>Log in</button>
</form>`));
}

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { body += c; if (body.length > limit) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function doLogin(req, res) {
  let form;
  try { form = new URLSearchParams(await readBody(req)); } catch { return; }
  const next = safeNext(form.get('next'));
  if (tooManyFailures()) return renderLogin(res, 429, next, 'Too many failed attempts. Try again in a few minutes.');
  if (!safeEqual(form.get('password') || '', PASSWORD)) {
    failures.push(Date.now());
    console.log(`[auth] failed login from ${req.headers['x-forwarded-for'] || req.socket.remoteAddress}`);
    await new Promise((r) => setTimeout(r, 1000));
    return renderLogin(res, 401, next, 'Wrong password.');
  }
  res.writeHead(303, { location: next, 'set-cookie': authCookie(req, COOKIE_MAX_AGE), 'cache-control': 'no-store' });
  res.end();
}

// Handles login/logout and rejects unauthenticated requests. Returns true if it responded.
async function guard(req, res, path) {
  if (!PASSWORD) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end('The switch page is locked: set SWITCH_PASSWORD in .env next to switch.js, then restart the proxy.\n');
    return true;
  }
  if (path === `${SWITCH_PATH}/login`) {
    if (req.method === 'POST') await doLogin(req, res);
    else renderLogin(res, 200, safeNext(new URLSearchParams(req.url.split('?')[1] || '').get('next')));
    return true;
  }
  if (path === `${SWITCH_PATH}/logout`) {
    res.writeHead(303, { location: SWITCH_PATH, 'set-cookie': authCookie(req, 0), 'cache-control': 'no-store' });
    res.end();
    return true;
  }
  if (isAuthed(req)) return false;
  // Browsers get the login form (then come back here); scripts get a plain 401.
  if (req.method === 'GET' && /text\/html/.test(req.headers.accept || '')) renderLogin(res, 401, safeNext(req.url));
  else { res.writeHead(401, { 'content-type': 'text/plain' }); res.end('unauthorized\n'); }
  return true;
}

// ---- switch UI -------------------------------------------------------------
const STYLE = `
  :root { color-scheme: light dark; --bg:#f6f6f4; --card:#fff; --fg:#1b1b1b; --mute:#777; --line:#e2e2de; --acc:#2a6ef0; --err:#c0392b; }
  @media (prefers-color-scheme: dark) { :root { --bg:#151515; --card:#1f1f1f; --fg:#eee; --mute:#999; --line:#333; --acc:#6d9cff; --err:#ff7b6b; } }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.4 system-ui,sans-serif; }
  main { max-width:520px; margin:48px auto; padding:0 16px; }
  h1 { font-size:18px; margin:0 0 4px; } p { color:var(--mute); margin:0 0 16px; }
  .msg { color:var(--err); background:var(--card); border:1px solid var(--err); border-radius:8px; padding:10px 14px; white-space:pre-wrap; }
  .row { display:flex; align-items:center; gap:10px; padding:0 10px 0 0; background:var(--card);
         border:1px solid var(--line); border-radius:8px; margin-bottom:8px; }
  .row:hover { border-color:var(--acc); } .row.active { border-color:var(--acc); box-shadow:0 0 0 1px var(--acc); }
  .main { flex:1; display:flex; align-items:center; gap:10px; padding:12px 0 12px 14px; color:inherit; text-decoration:none; min-width:0; }
  .dot { width:9px; height:9px; border-radius:50%; flex:none; }
  .running, .external { background:#2bb24c; } .starting { background:#e0a020; } .stopped { background:#888; }
  .name { flex:1; font-weight:500; overflow:hidden; text-overflow:ellipsis; } .port { color:var(--mute); font-family:ui-monospace,monospace; }
  .tag { font-size:12px; color:var(--acc); } .state { font-size:12px; color:var(--mute); }
  .row form { margin:0; } .row a.log { font-size:12px; color:var(--mute); }
  form.custom { display:flex; gap:8px; margin-top:16px; }
  input, button { font:inherit; padding:6px 10px; border-radius:6px; border:1px solid var(--line); background:var(--card); color:inherit; }
  input { flex:1; } button { cursor:pointer; } button:hover { border-color:var(--acc); }`;

const page = (title, body, head = '') => `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">${head}
<title>${esc(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;

const actionButton = (action, name) =>
  `<form method="post" action="${SWITCH_PATH}/${action}/${encodeURIComponent(name)}"><button>${action[0].toUpperCase() + action.slice(1)}</button></form>`;

async function renderSwitchPage(res, msg) {
  reloadConfig();
  const ports = [...new Set([...config.servers.map((s) => s.port), target])];
  const entries = ports.map((port) => entryOf(port) || { name: `port ${port}`, port, unregistered: true });
  const states = await Promise.all(entries.map((e) =>
    e.unregistered ? launcher.probe(e.port).then((up) => ({ state: up ? 'external' : 'stopped' })) : launcher.getState(e)));

  const rows = entries.map((e, i) => {
    const { state } = states[i];
    const active = e.port === target;
    const buttons = e.unregistered || !e.cmd ? '' : state === 'running' || state === 'starting'
      ? actionButton('restart', e.name) + actionButton('stop', e.name)
      : state === 'stopped' ? actionButton('start', e.name) : '';
    const log = e.unregistered || !e.cmd ? '' : `<a class="log" href="${SWITCH_PATH}/log/${encodeURIComponent(e.name)}">log</a>`;
    return `<div class="row${active ? ' active' : ''}">
      <a class="main" href="${SWITCH_PATH}/${e.port}">
        <span class="dot ${state}" title="${state}"></span>
        <span class="name">${esc(e.name)}</span>
        <span class="port">:${e.port}</span>
        ${active ? '<span class="tag">active</span>' : ''}
      </a>
      <span class="state">${state}</span>${log}${buttons}
    </div>`;
  }).join('');

  const custom = ALLOW_UNREGISTERED ? `
    <form class="custom" onsubmit="location.href='${SWITCH_PATH}/'+this.p.value;return false">
      <input name="p" type="number" min="1" max="65535" placeholder="other port" required>
      <button>Go</button>
    </form>` : '';

  const errors = [configError && `servers.json: ${configError}`, msg].filter(Boolean);
  // Keep refreshing while something is booting so the dot turns green on its own.
  const head = states.some((s) => s.state === 'starting') ? `<meta http-equiv="refresh" content="2;url=${SWITCH_PATH}">` : '';
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(page('Switch server', `
<h1>Switch server</h1>
<p>Currently proxying to <b>${esc(nameOf(target))}</b> (:${target})</p>
${errors.map((m) => `<p class="msg">${esc(m)}</p>`).join('')}
${rows}${custom}
<p style="margin-top:24px;font-size:13px">
  <a href="${SWITCH_PATH}/logs" style="color:inherit">All logs</a> &middot;
  <a href="${SWITCH_PATH}/log/${launcher.PROXY}" style="color:inherit">Proxy log</a> &middot;
  <a href="${SWITCH_PATH}/logout" style="color:inherit">Log out</a>
</p>`, head));
}

function doSwitch(port, res) {
  const known = config.servers.some((s) => s.port === port);
  if (!(port > 0 && port < 65536) || port === LISTEN_PORT || (!known && !ALLOW_UNREGISTERED)) {
    res.writeHead(400, { 'content-type': 'text/plain' });
    return res.end(`Not allowed: ${port}\n`);
  }
  if (port !== target) {
    console.log(`[switch] ${target} -> ${port} (${nameOf(port)})`);
    target = port;
    for (const s of tunnels) s.destroy();
    tunnels.clear();
  }
  res.writeHead(302, { location: '/', 'cache-control': 'no-store' });
  res.end();
}

async function doAction(action, name, res) {
  const entry = reloadConfig().servers.find((s) => s.name === name);
  let msg = '';
  try {
    if (!entry) throw new Error(`unknown server "${name}"`);
    if (action !== 'start') await launcher.stop(entry);
    if (action !== 'stop') await launcher.start(entry);
    console.log(`[switch] ${action} ${name}`);
  } catch (err) {
    msg = `${action} ${name}: ${err.message}`;
  }
  res.writeHead(303, { location: SWITCH_PATH + (msg ? `?msg=${encodeURIComponent(msg)}` : ''), 'cache-control': 'no-store' });
  res.end();
}

// ---- logs ------------------------------------------------------------------
//   GET /switch/log/{name}          viewer page (?raw or a non-browser client: plain text);
//                                   ?lines=N history to load (default 1000, max 5000)
//   GET /switch/log/{name}/stream   SSE: the last ?lines=N lines, then new output live
//   GET /switch/logs[/stream]       the same for every server (plus the proxy), combined
// Each SSE message is {n: name, t: text}; its id holds every file's read position so a
// reconnect (EventSource sends Last-Event-ID) resumes where it left off. A "reset" event
// means the log was started over (server restarted). History reaches back into previous
// runs' logs (<name>.log.1, ...), each preceded by a "run" event that labels it.

const logNames = () => [...config.servers.filter((s) => s.cmd).map((s) => s.name), launcher.PROXY];
const LOG_LINES = 1000; // default history for one server's log (the combined view: 50 per server)
const linesParam = (query) => (new URLSearchParams(query).has('lines') ? `?lines=${clampLines(query, 0)}` : '');
const clampLines = (query, dflt) => Math.min(5000, Math.max(0, Number(new URLSearchParams(query).get('lines') ?? dflt) || 0));

function fileSize(file) {
  try { return fs.statSync(file).size; } catch { return 0; }
}

function readRange(file, start, end) {
  if (end <= start) return Buffer.alloc(0);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(end - start);
    return buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, start));
  } finally { fs.closeSync(fd); }
}

// A log's first line (portctl writes a timestamp there), hashed: when it changes, the file
// was rewritten by a restart even if it has already grown past our read position.
function logSignature(file) {
  let head;
  try { head = readRange(file, 0, 256); } catch { return '-'; }
  const nl = head.indexOf(10);
  return crypto.createHash('sha1').update(nl === -1 ? head : head.subarray(0, nl)).digest('hex').slice(0, 8);
}

// Where the last `lines` lines of a file start (looking back at most 1MB), and how many
// lines that actually is (fewer if the file is shorter).
function tailOffset(file, lines) {
  const size = fileSize(file);
  if (!lines) return { offset: size, count: 0 };
  const from = Math.max(0, size - 1024 * 1024);
  let buf;
  try { buf = readRange(file, from, size); } catch { return { offset: size, count: 0 }; }
  let i = buf.length - (buf[buf.length - 1] === 10 ? 1 : 0);
  for (let count = 0; i > 0; i--) if (buf[i - 1] === 10 && ++count === lines) break;
  if (i === 0 && from > 0) i = buf.indexOf(10) + 1; // don't start mid-line
  const picked = buf.subarray(i);
  let count = 0;
  for (const b of picked) if (b === 10) count++;
  if (picked.length && picked[picked.length - 1] !== 10) count++;
  return { offset: from + i, count };
}

// The last `lines` lines of a server's log, reaching back into previous runs
// (<name>.log.1, .2, ... kept by portctl) when the current run is shorter.
// Oldest first; the last part is always the current log.
function logHistory(name, lines) {
  const file = launcher.logFile(name);
  const parts = [];
  let need = lines;
  for (let run = 0; run === 0 || (need > 0 && run <= 100); run++) {
    const f = run ? `${file}.${run}` : file;
    if (run && !fs.existsSync(f)) break;
    const { offset, count } = tailOffset(f, need);
    parts.unshift({ file: f, label: run ? `previous run (${path.basename(f)})` : 'current run', start: offset, end: fileSize(f) });
    need -= count;
  }
  return parts;
}

// One fs.watchFile per log, shared by every open stream. (Works before the file exists.)
const logWatchers = new Map();
function watchLog(file, onChange) {
  let subs = logWatchers.get(file);
  if (!subs) {
    subs = new Set();
    logWatchers.set(file, subs);
    fs.watchFile(file, { interval: 300 }, () => { for (const fn of subs) fn(); });
  }
  subs.add(onChange);
  return () => {
    subs.delete(onChange);
    if (!subs.size) { fs.unwatchFile(file); logWatchers.delete(file); }
  };
}

function parseLastEventId(header) {
  const resume = {};
  for (const part of (header || '').split(';')) {
    const m = /^([\w.-]+)=(\d+)\.(\w+)$/.exec(part);
    if (m) resume[m[1]] = { offset: Number(m[2]), sig: m[3] };
  }
  return resume;
}

function streamLogs(req, res, names, lines) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    'x-accel-buffering': 'no', // nginx: don't buffer the stream
  });
  res.on('error', () => {});
  res.write('retry: 2000\n\n');

  const resume = parseLastEventId(req.headers['last-event-id']);
  const streams = names.map((name) => {
    const file = launcher.logFile(name);
    const sig = logSignature(file);
    const prev = resume[name];
    if (prev && prev.sig === sig && prev.offset <= fileSize(file)) {
      return { name, file, sig, offset: prev.offset, older: [], decoder: new StringDecoder('utf8') };
    }
    const parts = logHistory(name, lines);
    const current = parts.pop();
    return { name, file, sig, offset: current.start, older: parts, decoder: new StringDecoder('utf8') };
  });
  const id = () => streams.map((s) => `${s.name}=${s.offset}.${s.sig}`).join(';');
  const send = (event, data) => res.write(`${event ? `event: ${event}\n` : ''}id: ${id()}\ndata: ${JSON.stringify(data)}\n\n`);

  const pump = (s) => {
    const sig = logSignature(s.file);
    const size = fileSize(s.file);
    if (sig !== s.sig || size < s.offset) {
      Object.assign(s, { sig, offset: 0, decoder: new StringDecoder('utf8') });
      send('reset', { n: s.name });
    }
    while (s.offset < size) {
      const end = Math.min(size, s.offset + 256 * 1024);
      let chunk;
      try { chunk = readRange(s.file, s.offset, end); } catch { return; }
      s.offset += chunk.length;
      const text = s.decoder.write(chunk); // holds back a multi-byte character cut in half
      if (text) send('', { n: s.name, t: text });
      if (!chunk.length) return;
    }
  };

  // History from previous runs first (those files don't change), then the live log.
  const sendOlder = (s) => {
    if (!s.older.length) return;
    for (const part of s.older) {
      send('run', { n: s.name, label: part.label });
      const decoder = new StringDecoder('utf8');
      for (let pos = part.start; pos < part.end;) {
        let chunk;
        try { chunk = readRange(part.file, pos, Math.min(part.end, pos + 256 * 1024)); } catch { break; }
        if (!chunk.length) break;
        pos += chunk.length;
        const text = decoder.write(chunk);
        if (text) send('', { n: s.name, t: text });
      }
    }
    send('run', { n: s.name, label: 'current run' });
  };
  streams.forEach((s) => { sendOlder(s); pump(s); });
  const unwatch = streams.map((s) => watchLog(s.file, () => pump(s)));
  const ping = setInterval(() => res.write(': ping\n\n'), 20000); // keeps idle proxies from dropping it
  req.on('close', () => { clearInterval(ping); unwatch.forEach((fn) => fn()); });
}

function showLogText(res, name, query) {
  const parts = logHistory(name, clampLines(query, LOG_LINES));
  const text = parts.map((p) => {
    let body = '';
    try { body = readRange(p.file, p.start, p.end).toString('utf8'); } catch {}
    if (parts.length > 1) body = `----- ${name}: ${p.label} -----\n${body}${body && !body.endsWith('\n') ? '\n' : ''}`;
    return body;
  }).join('');
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text || '(no log yet)\n');
}

const LOG_STYLE = `
  html, body { height:100%; }
  body { display:flex; flex-direction:column; }
  header { display:flex; flex-wrap:wrap; align-items:center; gap:8px 12px; padding:10px 16px; border-bottom:1px solid var(--line); background:var(--card); }
  header h1 { margin:0; font-size:16px; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  header a { color:var(--mute); font-size:13px; }
  .conn { font-size:12px; color:var(--mute); display:flex; align-items:center; gap:6px; }
  .conn .dot { background:#888; } .conn.live .dot { background:#2bb24c; } .conn.wait .dot { background:#e0a020; } .conn.dead .dot { background:#d0473b; }
  header button { font-size:13px; padding:4px 10px; } header button[aria-pressed=true] { border-color:var(--acc); color:var(--acc); }
  #out { flex:1; overflow:auto; margin:0; padding:8px 12px 24px; background:#111214; color:#d6d6d6;
         font:12.5px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; white-space:pre; }
  #out.wrap { white-space:pre-wrap; overflow-wrap:anywhere; }
  .ln { min-height:1.45em; }
  .sys { color:#8a8f98; font-style:italic; }
  .tag { display:inline-block; margin-right:1ch; font-weight:600; }
  #bottom { position:fixed; right:20px; bottom:20px; display:none; box-shadow:0 2px 8px rgba(0,0,0,.4); }`;

function renderLogViewer(res, { title, streamUrl, combined, names }) {
  const opts = { streamUrl, combined, tagWidth: Math.max(...names.map((n) => n.length)) };
  const json = JSON.stringify(opts).replace(/</g, '\\u003c');
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(`<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${STYLE}${LOG_STYLE}</style></head><body>
<header>
  <a href="${SWITCH_PATH}">&larr; servers</a>
  <h1>${esc(title)}</h1>
  <span class="conn wait" id="conn"><span class="dot"></span><span id="conn-text">connecting</span></span>
  <button id="pause" aria-pressed="false">Pause</button>
  <button id="wrap" aria-pressed="false">Wrap</button>
  <button id="clear">Clear</button>
</header>
<pre id="out"></pre>
<button id="bottom">&darr; Latest</button>
<script>(${logClient.toString()})(${json});</script>
</body></html>`);
}

// Runs in the browser (inlined via toString): renders the SSE stream, including ANSI colors.
function logClient(opts) {
  const out = document.getElementById('out');
  const MAX_LINES = 5000;
  // xterm-ish palette, readable on the dark log background
  const PALETTE = ['#3b3f45', '#e06c6c', '#7fbf6a', '#d9b25c', '#6b9fe0', '#c67dd6', '#4fbfbf', '#cfd3d8',
    '#80868e', '#ff8a8a', '#a3e08f', '#f2d27a', '#8fbaff', '#e09ef0', '#7fe0e0', '#ffffff'];
  const ESC_AT_START = /^\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()#][0-9A-Za-z]|[@-Z\\-_])/;
  const TOKEN = /\x1b(?:\[([0-?]*)[ -/]*([@-~])|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()#][0-9A-Za-z]|[@-Z\\-_])|\r\n|\r|\n|[^\x1b\r\n]+/g;
  const streams = {};
  let paused = false;
  let queue = [];

  const color256 = (n) => {
    if (n < 16) return PALETTE[n];
    if (n >= 232) { const v = 8 + (n - 232) * 10; return `rgb(${v},${v},${v})`; }
    n -= 16;
    const c = (x) => (x ? 55 + x * 40 : 0);
    return `rgb(${c(Math.floor(n / 36))},${c(Math.floor(n / 6) % 6)},${c(n % 6)})`;
  };

  function applySgr(st, params) {
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
        let col = null;
        if (p[i + 1] === 5) { col = color256(p[i + 2] || 0); i += 2; }
        else if (p[i + 1] === 2) { col = `rgb(${p[i + 2] || 0},${p[i + 3] || 0},${p[i + 4] || 0})`; i += 4; }
        if (c === 38) st.fg = col; else st.bg = col;
      }
    }
  }

  function styled(st, text) {
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

  const tagColor = (name) => {
    let h = 0;
    for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return `hsl(${h},65%,68%)`;
  };

  function trim() {
    while (out.childElementCount > MAX_LINES) {
      const first = out.firstElementChild;
      for (const st of Object.values(streams)) if (st.line === first) st.line = null;
      first.remove();
    }
  }

  function newLine(name, st) {
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
  }

  function sysLine(text) {
    const el = document.createElement('div');
    el.className = 'ln sys';
    el.textContent = text;
    out.append(el);
    for (const st of Object.values(streams)) st.line = null;
  }

  const stateFor = (name) => (streams[name] ||= { line: null, lineStart: 0, sgr: {}, carry: '', cr: false });

  function write(name, chunk) {
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
        if (!st.line) newLine(name, st);
        if (st.cr) { while (st.line.childNodes.length > st.lineStart) st.line.lastChild.remove(); st.cr = false; }
        st.line.append(styled(st.sgr, tok));
      }
    }
  }

  function handle(ev) {
    if (ev.type === 'reset' || ev.type === 'run') {
      const name = ev.data.n;
      delete streams[name]; // colors don't carry over between runs
      sysLine(ev.type === 'reset' ? `— ${name}: server restarted —` : `— ${name}: ${ev.data.label} —`);
    } else {
      write(ev.data.n, ev.data.t);
    }
  }

  const atBottom = () => out.scrollHeight - out.scrollTop - out.clientHeight < 40;
  const bottomBtn = document.getElementById('bottom');
  function render(events) {
    const stick = atBottom();
    events.forEach(handle);
    if (stick) out.scrollTop = out.scrollHeight;
    bottomBtn.style.display = atBottom() ? 'none' : 'block';
  }
  out.addEventListener('scroll', () => { bottomBtn.style.display = atBottom() ? 'none' : 'block'; });
  bottomBtn.onclick = () => { out.scrollTop = out.scrollHeight; };

  function receive(type, e) {
    const ev = { type, data: JSON.parse(e.data) };
    if (paused) queue.push(ev); else render([ev]);
  }

  const conn = document.getElementById('conn');
  const connText = document.getElementById('conn-text');
  const setConn = (cls, text) => { conn.className = `conn ${cls}`; connText.textContent = text; };
  const source = new EventSource(opts.streamUrl);
  source.onmessage = (e) => receive('message', e);
  source.addEventListener('reset', (e) => receive('reset', e));
  source.addEventListener('run', (e) => receive('run', e));
  source.onopen = () => setConn('live', 'live');
  source.onerror = () => {
    if (source.readyState === EventSource.CLOSED) setConn('dead', 'disconnected (reload, or log in again)');
    else setConn('wait', 'reconnecting');
  };

  const pauseBtn = document.getElementById('pause');
  pauseBtn.onclick = () => {
    paused = !paused;
    pauseBtn.setAttribute('aria-pressed', paused);
    pauseBtn.textContent = paused ? 'Resume' : 'Pause';
    if (!paused) { const q = queue; queue = []; render(q); }
  };
  const wrapBtn = document.getElementById('wrap');
  const setWrap = (on) => {
    out.classList.toggle('wrap', on);
    wrapBtn.setAttribute('aria-pressed', on);
    try { localStorage.setItem('port-switch-wrap', on ? '1' : ''); } catch {}
  };
  wrapBtn.onclick = () => setWrap(!out.classList.contains('wrap'));
  try { setWrap(!!localStorage.getItem('port-switch-wrap')); } catch {}
  document.getElementById('clear').onclick = () => {
    out.textContent = '';
    for (const st of Object.values(streams)) if (st) st.line = null;
  };
}

// ---- proxy -----------------------------------------------------------------
// Rewrite absolute redirects to localhost (e.g. http://localhost:3001/login) into
// relative ones so they survive the outer HTTPS proxy.
function fixLocation(loc) {
  return loc && loc.replace(/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(?=\/|$)/i, '') || '/';
}

function upstreamHeaders(req, port) {
  const headers = { ...req.headers, host: `localhost:${port}` };
  headers['x-forwarded-host'] ??= req.headers.host;
  headers['x-forwarded-proto'] ??= 'http';
  headers['x-forwarded-for'] ??= req.socket.remoteAddress;
  return headers;
}

function badGateway(res, port, err) {
  if (res.headersSent) return res.destroy();
  const entry = entryOf(port);
  const startBtn = entry?.cmd && !launcher.getPid(entry.name)
    ? `<form method="post" action="${SWITCH_PATH}/start/${encodeURIComponent(entry.name)}"><button>Start ${esc(entry.name)}</button></form>` : '';
  res.writeHead(502, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(page('502', `
<h1>${esc(nameOf(port))} (:${port}) isn't responding</h1>
<p>${esc(err.code || err.message)}</p>${startBtn}
<p><a href="${SWITCH_PATH}">Switch server &rarr;</a></p>`));
}

function proxy(req, res) {
  const port = target;
  const up = http.request({
    host: UPSTREAM_HOST, port, method: req.method, path: req.url,
    headers: upstreamHeaders(req, port),
  }, (pres) => {
    const headers = { ...pres.headers };
    if (headers.location) headers.location = fixLocation(headers.location);
    res.writeHead(pres.statusCode, pres.statusMessage, headers);
    pres.pipe(res);
  });
  up.on('error', (err) => badGateway(res, port, err));
  req.on('aborted', () => up.destroy());
  req.pipe(up);
}

async function handleSwitch(req, res, path, query) {
  if (await guard(req, res, path)) return;
  if (path === SWITCH_PATH || path === SWITCH_PATH + '/') {
    return renderSwitchPage(res, new URLSearchParams(query).get('msg'));
  }
  let parts = [];
  try { parts = path.slice(SWITCH_PATH.length + 1).split('/').filter(Boolean).map(decodeURIComponent); } catch {}
  if (parts.length === 1 && /^\d+$/.test(parts[0])) return doSwitch(Number(parts[0]), res);
  if (parts.length === 2 && req.method === 'POST' && ['start', 'stop', 'restart'].includes(parts[0])) {
    req.resume();
    return doAction(parts[0], parts[1], res);
  }
  if (parts[0] === 'log' && parts.length <= 3 && req.method === 'GET') {
    const name = parts[1];
    if (!logNames().includes(name)) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('unknown server\n'); }
    if (parts[2] === 'stream') return streamLogs(req, res, [name], clampLines(query, LOG_LINES));
    if (parts.length === 3) { res.writeHead(404); return res.end(); }
    const browser = /text\/html/.test(req.headers.accept || '');
    if (!browser || new URLSearchParams(query).has('raw')) return showLogText(res, name, query);
    const base = `${SWITCH_PATH}/log/${encodeURIComponent(name)}`;
    return renderLogViewer(res, { title: `${name} log`, streamUrl: `${base}/stream${linesParam(query)}`, combined: false, names: [name] });
  }
  if (parts[0] === 'logs' && req.method === 'GET') {
    const names = logNames();
    if (parts[1] === 'stream' && parts.length === 2) return streamLogs(req, res, names, clampLines(query, 50));
    if (parts.length === 1) return renderLogViewer(res, { title: 'All logs', streamUrl: `${SWITCH_PATH}/logs/stream${linesParam(query)}`, combined: true, names });
  }
  if (parts.join('/') === 'api/state') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ target, name: nameOf(target) }));
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found\n');
}

const server = http.createServer((req, res) => {
  const [path, query = ''] = req.url.split('?');
  if (path === SWITCH_PATH || path.startsWith(SWITCH_PATH + '/')) {
    return handleSwitch(req, res, path, query).catch((err) => {
      console.error('[switch]', err);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  }
  proxy(req, res);
});

// WebSocket / any Upgrade: raw TCP tunnel to the active target.
server.on('upgrade', (req, socket, head) => {
  const port = target;
  const up = net.connect(port, UPSTREAM_HOST, () => {
    const headers = upstreamHeaders(req, port);
    let raw = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
    for (const [k, v] of Object.entries(headers)) {
      for (const val of [].concat(v)) raw += `${k}: ${val}\r\n`;
    }
    up.write(raw + '\r\n');
    if (head?.length) up.write(head);
    socket.pipe(up).pipe(socket);
  });
  const close = () => { up.destroy(); socket.destroy(); tunnels.delete(socket); };
  tunnels.add(socket);
  up.on('error', close); up.on('close', close);
  socket.on('error', close); socket.on('close', close);
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(`[port-switch] listening on ${LISTEN_HOST}:${LISTEN_PORT} -> :${target} (${nameOf(target)})`);
  console.log(`[port-switch] switch page: http://localhost:${LISTEN_PORT}${SWITCH_PATH}`);
});
