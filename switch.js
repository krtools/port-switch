#!/usr/bin/env node
// port-switch: a tiny zero-dependency reverse proxy that forwards everything on
// one port (default 3000) to whichever local server is currently "selected".
//
//   GET  /switch                -> page listing servers from servers.json (status, start/stop)
//   GET  /switch/{port}         -> make {port} the active target, redirect to /
//   POST /switch/{start|stop|restart}/{name}
//   GET  /switch/log/{name}     -> tail of run/{name}.log
//   anything else               -> proxied to the active target (incl. WebSockets)
//
// Usage: node switch.js   or   node launch.js --self      (env: PORT HOST TARGET)

const http = require('http');
const net = require('net');
const launcher = require('./launch');

const UPSTREAM_HOST = '127.0.0.1';
const ALLOW_UNREGISTERED = true; // allow /switch/{port} for ports not in servers.json
const SWITCH_PATH = '/switch';

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

const LISTEN_PORT = Number(process.env.PORT) || config.proxy.port;
const LISTEN_HOST = process.env.HOST || '0.0.0.0';

let target = Number(process.env.TARGET) || config.servers[0]?.port || 3001;

// Open WebSocket tunnels, killed on switch so clients (e.g. HMR) reconnect to the new target.
const tunnels = new Set();

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const entryOf = (port) => config.servers.find((s) => s.port === port);
const nameOf = (port) => entryOf(port)?.name || `port ${port}`;

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
${rows}${custom}`, head));
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

const server = http.createServer((req, res) => {
  const [path, query = ''] = req.url.split('?');
  if (path === SWITCH_PATH || path === SWITCH_PATH + '/') {
    return renderSwitchPage(res, new URLSearchParams(query).get('msg'));
  }
  if (path.startsWith(SWITCH_PATH + '/')) {
    const parts = path.slice(SWITCH_PATH.length + 1).split('/').filter(Boolean).map(decodeURIComponent);
    if (parts.length === 1 && /^\d+$/.test(parts[0])) return doSwitch(Number(parts[0]), res);
    if (parts.length === 2 && req.method === 'POST' && ['start', 'stop', 'restart'].includes(parts[0])) {
      req.resume();
      return doAction(parts[0], parts[1], res);
    }
    if (parts.length === 2 && parts[0] === 'log') return showLog(parts[1], res);
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
