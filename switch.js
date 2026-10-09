#!/usr/bin/env node
// port-switch: a tiny zero-dependency reverse proxy that forwards everything on
// one port (default 3000) to whichever local server is currently "selected".
//
//   GET  /switch                -> page listing servers from servers.json (status, start/stop)
//   GET  /switch/{port}         -> make {port} the active target, redirect to /
//   POST /switch/{start|stop|restart}/{name}
//   GET  /switch/log/{name}     -> tail of run/{name}.log
//   GET  /switch/api/state      -> {"target":3001,"name":"..."} (used by portctl)
//   GET|POST /switch/login, GET /switch/logout
//   anything else               -> proxied to the active target (incl. WebSockets)
// (/switch is proxy.path in servers.json)
//
// Everything under /switch needs SWITCH_PASSWORD (from .env): log in once in the browser
// for a long-lived cookie, or send "Authorization: Bearer <password>" (portctl does).
//
// Usage: node switch.js   or   portctl start proxy
// env: PORT HOST TARGET SWITCH_PASSWORD SWITCH_COOKIE_DAYS (default 365)

const http = require('http');
const net = require('net');
const crypto = require('crypto');
const launcher = require('./portctl');

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
  return `${COOKIE}=${maxAge ? `${exp}.${sign(exp)}` : ''}; Path=${SWITCH_PATH}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
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
<p style="margin-top:24px;font-size:13px"><a href="${SWITCH_PATH}/logout" style="color:inherit">Log out</a></p>`, head));
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

function showLog(name, res) {
  const entry = config.servers.find((s) => s.name === name);
  res.writeHead(entry ? 200 : 404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(entry ? launcher.tail(name, 200) || '(no log yet)\n' : 'unknown server\n');
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
  if (parts.length === 2 && parts[0] === 'log') return showLog(parts[1], res);
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
