#!/usr/bin/env node
// port-switch: a tiny zero-dependency reverse proxy that forwards everything on
// one port (default 3000) to whichever local server is currently "selected".
//
//   GET  /switch                -> page listing servers from servers.json (status, start/stop)
//   GET  /switch/{port}         -> make {port} the active target, redirect to /
//   GET  /switch/none           -> proxy nothing: visitors get a placeholder page (503)
//   POST /switch/{start|stop|restart}/{name}
//   GET  /switch/log/{name}     -> live log viewer (?raw: plain-text tail), /stream: SSE
//   GET  /switch/logs           -> every server's log combined, /stream: SSE
//   GET  /switch/api/state      -> {"target":3001 or null,"name":"..."} (used by portctl)
//   GET|POST /switch/login, GET /switch/logout
//   anything else               -> proxied to the active target (incl. WebSockets)
// (/switch is proxy.path in servers.json)
//
// Everything under /switch needs SWITCH_PASSWORD (from .env): log in once in the browser
// for a long-lived cookie, or send "Authorization: Bearer <password>" (portctl does).
//
// Usage: node switch.js [--config servers.json]   or   portctl start proxy
// env: PORT_SWITCH_CONFIG PORT HOST TARGET (a port or "none") SWITCH_PASSWORD SWITCH_COOKIE_DAYS (default 365) SWITCH_COOKIE_DOMAIN

import * as http from 'http';
import * as net from 'net';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { Duplex } from 'stream';
import { StringDecoder } from 'string_decoder';
import * as launcher from './portctl';
import type { Config, ServerEntry, State } from './portctl';
import { logClient, type LogClientOptions } from './logClient';
import { errCode, errMsg, errText } from './util';

type Req = http.IncomingMessage;
type Res = http.ServerResponse;

// Timestamp every log line, and record why the process ends: the log (run/proxy.log
// under portctl) is the only trace. If it ends with none of these lines, the process
// got SIGKILL (e.g. the kernel OOM killer) or the log was cleared by a restart.
for (const level of ['log', 'error'] as const) {
  const write = console[level].bind(console);
  console[level] = (...args: unknown[]) => write(new Date().toISOString(), ...args);
}
process.on('uncaughtException', (err, origin) => { // also unhandled rejections
  console.error(`[fatal] ${origin}:`, err);
  process.exit(1);
});
for (const [sig, num] of [['SIGTERM', 15], ['SIGINT', 2], ['SIGHUP', 1]] as const) {
  process.on(sig, () => { console.log(`[exit] received ${sig}`); process.exit(128 + num); });
}
process.on('exit', (code) => console.log(`[exit] code ${code}`));

const UPSTREAM_HOST = '127.0.0.1';
const ALLOW_UNREGISTERED = true; // allow /switch/{port} for ports not in servers.json

// servers.json is re-read on every /switch page load; keep the last good copy if it breaks.
let config: Config;
let configError: string | null = null;
function reloadConfig(): Config {
  try { config = launcher.loadConfig(); configError = null; } catch (err) { configError = errMsg(err); }
  return config;
}
try {
  config = launcher.loadConfig();
} catch (err) {
  console.error(`[port-switch] ${errMsg(err)}`);
  process.exit(1);
}

const SWITCH_PATH = config.proxy.path;
const LISTEN_PORT = Number(process.env.PORT) || config.proxy.port;
const LISTEN_HOST = process.env.HOST || '0.0.0.0';

// The port being proxied to, or null for "None": every request gets the idle page.
let target: number | null = process.env.TARGET === 'none' ? null : Number(process.env.TARGET) || config.servers[0]?.port || 3001;

// Open WebSocket tunnels, killed on switch so clients (e.g. HMR) reconnect to the new target.
const tunnels = new Set<Duplex>();

const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const entryOf = (port: number) => config.servers.find((s) => s.port === port);
const nameOf = (port: number | null) => (port === null ? 'none' : entryOf(port)?.name || `port ${port}`);
const describe = (port: number | null) => (port === null ? 'none' : `:${port} (${nameOf(port)})`);

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
const failures: number[] = [];

const sign = (exp: string | number) => crypto.createHmac('sha256', PASSWORD).update(`port-switch:${exp}`).digest('base64url');
const sha = (s: string) => crypto.createHash('sha256').update(s).digest();
const safeEqual = (a: string, b: string) => crypto.timingSafeEqual(sha(a), sha(b));

function getCookie(req: Req, name: string): string {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return '';
}

function isAuthed(req: Req): boolean {
  if (!PASSWORD) return false;
  const bearer = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
  if (bearer) return safeEqual(bearer, PASSWORD);
  const [exp, sig] = getCookie(req, COOKIE).split('.');
  return Number(exp) > Date.now() / 1000 && !!sig && safeEqual(sig, sign(exp));
}

function authCookie(req: Req, maxAge: number): string {
  const exp = Math.floor(Date.now() / 1000) + maxAge;
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  const domain = COOKIE_DOMAIN ? `; Domain=${COOKIE_DOMAIN}` : '';
  return `${COOKIE}=${maxAge ? `${exp}.${sign(exp)}` : ''}; Path=${SWITCH_PATH}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${domain}${secure}`;
}

function tooManyFailures(): boolean {
  const cutoff = Date.now() - 15 * 60e3;
  while (failures.length && failures[0] < cutoff) failures.shift();
  return failures.length >= MAX_FAILURES;
}

// Only redirect back into /switch after logging in.
const safeNext = (next: string | null | undefined): string =>
  typeof next === 'string' && (next === SWITCH_PATH || next.startsWith(SWITCH_PATH + '/') || next.startsWith(SWITCH_PATH + '?'))
    ? next : SWITCH_PATH;

function renderLogin(res: Res, status: number, next: string, msg?: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(page('Log in', `<div class="card">
  <div style="margin-bottom:20px">${brand()}</div>
  ${msg ? `<p class="msg">${esc(msg)}</p>` : ''}
  <form method="post" action="${SWITCH_PATH}/login">
    <input type="hidden" name="next" value="${esc(next)}">
    <label class="label" for="password">Password</label>
    <input id="password" type="password" name="password" autocomplete="current-password" style="width:100%" autofocus required>
    <button class="btn primary wide" style="margin-top:14px">Log in</button>
  </form>
</div>`));
}

function readBody(req: Req, limit = 4096): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => { body += c; if (body.length > limit) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function doLogin(req: Req, res: Res): Promise<void> {
  let form: URLSearchParams;
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

/** Handles login/logout and rejects unauthenticated requests. Returns true if it responded. */
async function guard(req: Req, res: Res, urlPath: string): Promise<boolean> {
  if (!PASSWORD) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end('The switch page is locked: set SWITCH_PASSWORD in the .env next to servers.json, then restart the proxy.\n');
    return true;
  }
  if (urlPath === `${SWITCH_PATH}/login`) {
    if (req.method === 'POST') await doLogin(req, res);
    else renderLogin(res, 200, safeNext(new URLSearchParams((req.url ?? '').split('?')[1] || '').get('next')));
    return true;
  }
  if (urlPath === `${SWITCH_PATH}/logout`) {
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
  :root { color-scheme: light dark;
    --bg:#f4f5f7; --card:#fff; --hover:#f8f9fb; --line:#e3e5e8; --line-strong:#cdd1d8; --fg:#111827; --mute:#6b7280; --chip:#eef0f3;
    --acc:#4f6ef7; --acc-hover:#3f5ce0; --acc-tint:#eef1ff; --ring:0 0 0 3px rgba(79,110,247,.28);
    --danger:#c93c37; --danger-tint:#fdecec;
    --ok-bg:#e3f6ea; --ok-fg:#17703b; --ok-dot:#22a55a; --warn-bg:#fdf3dc; --warn-fg:#8a5a00; --warn-dot:#d99a14;
    --off-bg:#eef0f3; --off-fg:#4b5563; --off-dot:#9aa1ab; --ext-bg:#e8f0fe; --ext-fg:#1d4fb8; --ext-dot:#3b7be8; }
  @media (prefers-color-scheme: dark) { :root {
    --bg:#0f1115; --card:#171a20; --hover:#1b1f26; --line:#262a33; --line-strong:#363b46; --fg:#e6e8eb; --mute:#8b919c; --chip:#262a33;
    --acc:#6d86ff; --acc-hover:#8398ff; --acc-tint:#1c2340; --ring:0 0 0 3px rgba(109,134,255,.35);
    --danger:#ff7a72; --danger-tint:#3a1d1f;
    --ok-bg:#14301f; --ok-fg:#7ee2a1; --ok-dot:#3ccf74; --warn-bg:#33270c; --warn-fg:#f2c45a; --warn-dot:#e0a52a;
    --off-bg:#23272f; --off-fg:#a3a9b3; --off-dot:#6b7280; --ext-bg:#162845; --ext-fg:#8db4ff; --ext-dot:#5b93f5; } }
  * { box-sizing:border-box; }
  [hidden] { display:none !important; } /* .btn's display would otherwise win */
  body { margin:0; background:var(--bg); color:var(--fg); -webkit-font-smoothing:antialiased;
         font:14px/1.45 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; font-variant-numeric:tabular-nums; }
  a { color:var(--acc); text-decoration:none; } a:hover { text-decoration:underline; }
  .mono { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
  .ic { flex:none; }
  :focus-visible { outline:none; box-shadow:var(--ring); }
  h1 { font-size:20px; font-weight:600; letter-spacing:-.01em; margin:0 0 2px; }
  .sub { color:var(--mute); font-size:13px; margin:0 0 18px; } .sub b { color:var(--fg); font-weight:500; }
  .topbar { display:flex; flex-wrap:wrap; align-items:center; gap:6px 8px; padding:10px 16px; background:var(--card); border-bottom:1px solid var(--line); }
  .topbar nav { margin-left:auto; display:flex; flex-wrap:wrap; gap:2px; }
  .brand { display:inline-flex; align-items:center; gap:10px; color:var(--fg); font-weight:600; } .brand:hover { text-decoration:none; }
  .mark { width:24px; height:24px; border-radius:6px; background:var(--acc); color:#fff; display:inline-flex; align-items:center; justify-content:center; }
  main { max-width:600px; margin:0 auto; padding:28px 16px 48px; }
  .btn { display:inline-flex; align-items:center; justify-content:center; gap:6px; height:30px; padding:0 12px; border-radius:6px;
         border:1px solid var(--line); background:var(--card); color:var(--fg); font-family:inherit; font-size:13px; font-weight:500; line-height:1; cursor:pointer; white-space:nowrap; }
  .btn:hover { border-color:var(--line-strong); background:var(--hover); text-decoration:none; }
  .btn.primary { background:var(--acc); border-color:var(--acc); color:#fff; } .btn.primary:hover { background:var(--acc-hover); border-color:var(--acc-hover); }
  .btn.danger { color:var(--danger); } .btn.danger:hover { background:var(--danger-tint); border-color:var(--danger); }
  .btn.ghost { background:transparent; border-color:transparent; color:var(--mute); } .btn.ghost:hover { background:var(--chip); color:var(--fg); }
  .btn.icon { padding:0 7px; } .btn.wide { width:100%; height:34px; }
  .btn.sm { height:26px; padding:0 9px; gap:5px; font-size:12px; } .btn.sm.icon { padding:0 5px; }
  .btn:disabled { opacity:.4; cursor:default; pointer-events:none; }
  .swap { display:inline-grid; } .swap > * { grid-area:1/1; } .swap > .reserve { visibility:hidden; } /* width of the wider label, so Start/Restart don't shift the row */
  .btn[aria-pressed=true] { color:var(--acc); border-color:var(--acc); background:var(--acc-tint); }
  .pill { display:inline-flex; align-items:center; gap:6px; height:22px; padding:0 9px; border-radius:999px; font-size:12px; font-weight:500; white-space:nowrap; }
  .pill i { width:6px; height:6px; border-radius:50%; background:currentColor; }
  .pill.ok { background:var(--ok-bg); color:var(--ok-fg); } .pill.ok i { background:var(--ok-dot); }
  .pill.warn { background:var(--warn-bg); color:var(--warn-fg); } .pill.warn i { background:var(--warn-dot); }
  .pill.off { background:var(--off-bg); color:var(--off-fg); } .pill.off i { background:var(--off-dot); }
  .pill.ext { background:var(--ext-bg); color:var(--ext-fg); } .pill.ext i { background:var(--ext-dot); }
  .pill.danger { background:var(--danger-tint); color:var(--danger); }
  .list { background:var(--card); border:1px solid var(--line); border-radius:10px; overflow:hidden; }
  .row { position:relative; display:flex; align-items:center; gap:8px; padding:10px 12px 10px 14px; border-top:1px solid var(--line); }
  .row:first-child { border-top:0; } .row:not(.active):hover { background:var(--hover); }
  .row.active { background:var(--acc-tint); box-shadow:inset 3px 0 0 var(--acc); }
  .row .main { flex:1; min-width:0; display:flex; flex-direction:column; color:inherit; }
  .row .main::after { content:""; position:absolute; inset:0; } /* the whole row switches */
  .row .main:hover { text-decoration:none; } .row:hover .name { color:var(--acc); }
  /* The dot sits in a line box like the name's, so vertical-align:middle centers it on the
     name's lowercase letters (baseline + half the x-height) in whatever font is in use. */
  .dot { flex:none; align-self:flex-start; margin-right:2px; }
  .dot::before { content:""; display:inline-block; width:8px; height:8px; border-radius:50%; background:currentColor; vertical-align:middle; }
  .dot.ok { color:var(--ok-dot); } .dot.warn { color:var(--warn-dot); animation:pulse 1.2s ease-in-out infinite; }
  .dot.off { color:var(--off-dot); } .dot.ext { color:var(--ext-dot); } .dot.none { visibility:hidden; }
  @keyframes pulse { 50% { opacity:.35; } } @media (prefers-reduced-motion:reduce) { .dot.warn { animation:none; } }
  .name { font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; } .port { font-size:12px; color:var(--mute); }
  .actions { position:relative; z-index:1; display:flex; flex-wrap:wrap; justify-content:flex-end; align-items:center; gap:6px; pointer-events:none; }
  .actions a, .actions form { pointer-events:auto; } /* pills and gaps click through to the row */
  form { margin:0; }
  input { font:inherit; height:30px; padding:0 10px; border:1px solid var(--line); border-radius:6px; background:var(--card); color:var(--fg); min-width:0; }
  input:focus { outline:none; border-color:var(--acc); box-shadow:var(--ring); }
  .other { display:flex; align-items:center; gap:8px; margin-top:14px; } .other label { color:var(--mute); font-size:13px; } .other input { flex:1; }
  .msg { background:var(--danger-tint); color:var(--danger); border-radius:8px; padding:10px 12px; margin:0 0 14px; font-size:13px; white-space:pre-wrap; }
  .card { max-width:380px; margin:72px auto 0; background:var(--card); border:1px solid var(--line); border-radius:12px; padding:24px; }
  .card h1 { font-size:17px; margin:12px 0 4px; }
  .badge { width:34px; height:34px; border-radius:8px; display:inline-flex; align-items:center; justify-content:center; background:var(--danger-tint); color:var(--danger); }
  .chip { background:var(--chip); border-radius:4px; padding:1px 6px; font-size:12px; }
  .label { display:block; font-size:12px; color:var(--mute); margin:0 0 6px; }
  .buttons { display:flex; flex-wrap:wrap; gap:8px; }
  @media (max-width:520px) { .row { flex-wrap:wrap; } .actions { width:100%; } }`;

// Icons: inline SVG (no icon font or CDN), stroke paths on a 24x24 grid.
const ICONS = {
  mark: '<path d="M7 10h14l-4-4"/><path d="M17 14H3l4 4"/>',
  logs: '<path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z"/><path d="M9 13h6M9 17h6"/>',
  server: '<rect x="3" y="4" width="18" height="8" rx="3"/><rect x="3" y="12" width="18" height="8" rx="3"/><path d="M7 8v.01M7 16v.01"/>',
  logout: '<path d="M14 8V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2v-2"/><path d="M9 12h12l-3-3m0 6 3-3"/>',
  start: '<path d="M7 4v16l13-8z"/>',
  restart: '<path d="M20 11A8.1 8.1 0 0 0 4.5 9M4 5v4h4"/><path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  back: '<path d="M5 12h14M5 12l6 6M5 12l6-6"/>',
  search: '<circle cx="10" cy="10" r="7"/><path d="M21 21l-6-6"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  up: '<path d="M6 15l6-6 6 6"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  jump: '<path d="M9 6l6 6-6 6"/>',
  power: '<path d="M7 6a7.75 7.75 0 1 0 10 0"/><path d="M12 4v8"/>',
  unplug: '<path d="M7 12l5 5-1.5 1.5a3.5 3.5 0 1 1-5-5L7 12zM17 12l-5-5 1.5-1.5a3.5 3.5 0 1 1 5 5L17 12zM3 21l2.5-2.5M18.5 5.5 21 3M10 11l-2 2M13 14l-2 2"/>',
};
type IconName = keyof typeof ICONS;
const icon = (name: IconName, size = 16) =>
  `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
const FAVICON = 'data:image/svg+xml,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#4f6ef7"/>` +
  `<g transform="translate(4 4) scale(.667)" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">${ICONS.mark}</g></svg>`);
const brand = (href?: string) => {
  const inner = `<span class="mark">${icon('mark', 15)}</span>port-switch`;
  return href ? `<a class="brand" href="${href}">${inner}</a>` : `<span class="brand">${inner}</span>`;
};

const htmlHead = (title: string, extra = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">${extra}
<link rel="icon" href="${FAVICON}"><title>${esc(title)} · port-switch</title><style>${STYLE}</style>`;

/** A page with the top bar (brand + nav) for signed-in pages, or bare for login and error pages. */
function page(title: string, body: string, { head = '', nav = false }: { head?: string; nav?: boolean } = {}): string {
  const topbar = nav ? `<header class="topbar">${brand(SWITCH_PATH)}<nav>
  <a class="btn ghost" href="${SWITCH_PATH}/logs">${icon('logs')}All logs</a>
  <a class="btn ghost" href="${SWITCH_PATH}/log/${launcher.PROXY}">${icon('server')}Proxy log</a>
  <a class="btn ghost" href="${SWITCH_PATH}/logout">${icon('logout')}Log out</a></nav></header>` : '';
  return `${htmlHead(title, head)}</head><body>${topbar}<main>${body}</main></body></html>`;
}

type Action = 'start' | 'stop' | 'restart';
const ACTIONS: readonly Action[] = ['start', 'stop', 'restart'];
const ACTION_STYLE: Record<Action, string> = { start: 'primary', restart: '', stop: 'danger' };

const actionLabel = (action: Action) => action[0].toUpperCase() + action.slice(1);
const actionButton = (action: Action, name: string, label = actionLabel(action)) =>
  `<form method="post" action="${SWITCH_PATH}/${action}/${encodeURIComponent(name)}"><button class="btn ${ACTION_STYLE[action]}">${icon(action, 14)}${esc(label)}</button></form>`;

/** Compact row button. `reserve` sizes it to fit another action's label too, so swapping
 *  Start <-> Restart keeps the width; `disabled` keeps the slot when the action doesn't apply. */
const rowButton = (action: Action, name: string, { reserve, disabled = false }: { reserve?: Action; disabled?: boolean } = {}) => {
  const label = (a: Action, cls = '') => `<span${cls ? ` class="${cls}" aria-hidden="true"` : ''}>${actionLabel(a)}</span>`;
  const text = reserve ? `<span class="swap">${label(action)}${label(reserve, 'reserve')}</span>` : actionLabel(action);
  return `<form method="post" action="${SWITCH_PATH}/${action}/${encodeURIComponent(name)}">` +
    `<button class="btn sm ${ACTION_STYLE[action]}"${disabled ? ' disabled' : ''}>${icon(action, 13)}${text}</button></form>`;
};

const STATE_DOT: Record<State, [string, string]> = {
  running: ['ok', 'Running'], starting: ['warn', 'Starting'], stopped: ['off', 'Stopped'], external: ['ext', 'Running outside portctl'],
};
const stateDot = (state: State) => `<span class="dot ${STATE_DOT[state][0]}" role="img" title="${STATE_DOT[state][1]}" aria-label="${STATE_DOT[state][1]}"></span>`;

async function renderSwitchPage(res: Res, msg: string | null): Promise<void> {
  reloadConfig();
  const ports = [...new Set([...config.servers.map((s) => s.port), ...(target === null ? [] : [target])])];
  const entries = ports.map((port): ServerEntry & { unregistered?: boolean } =>
    entryOf(port) || { name: `port ${port}`, port, unregistered: true });
  const states = await Promise.all(entries.map((e): Promise<{ state: State }> =>
    e.unregistered ? launcher.probe(e.port).then((up) => ({ state: up ? 'external' : 'stopped' })) : launcher.getState(e)));

  const rows = entries.map((e, i) => {
    const { state } = states[i];
    const active = e.port === target;
    // Same controls in every state, so the row never reflows: [logs] [Start|Restart] [Stop].
    // External servers weren't started by portctl, so neither button applies to them.
    const up = state === 'running' || state === 'starting';
    const buttons = e.unregistered || !e.cmd ? ''
      : rowButton(up ? 'restart' : 'start', e.name, { reserve: up ? 'start' : 'restart', disabled: state === 'external' })
        + rowButton('stop', e.name, { disabled: !up });
    const log = e.unregistered || !e.cmd ? ''
      : `<a class="btn sm ghost" href="${SWITCH_PATH}/log/${encodeURIComponent(e.name)}" aria-label="${esc(e.name)} logs">${icon('logs', 13)}Logs</a>`;
    return `<div class="row${active ? ' active' : ''}">
      ${stateDot(state)}
      <a class="main" href="${SWITCH_PATH}/${e.port}" title="Switch to ${esc(e.name)}"${active ? ' aria-current="true"' : ''}>
        <span class="name">${esc(e.name)}</span><span class="port mono">:${e.port}</span>
      </a>
      <div class="actions">${log}${buttons}</div>
    </div>`;
  }).join('');
  const noneRow = `<div class="row${target === null ? ' active' : ''}">
      <span class="dot none"></span>
      <a class="main" href="${SWITCH_PATH}/none" title="Stop proxying, show visitors a placeholder page"${target === null ? ' aria-current="true"' : ''}>
        <span class="name">None</span><span class="port">Nothing served</span>
      </a>
    </div>`;

  const custom = ALLOW_UNREGISTERED ? `
    <form class="other" onsubmit="location.href='${SWITCH_PATH}/'+this.p.value;return false">
      <label for="p">Other port</label>
      <input id="p" name="p" class="mono" type="number" min="1" max="65535" placeholder="4000" required>
      <button class="btn">Switch</button>
    </form>` : '';

  const errors = [configError && `servers.json: ${configError}`, msg].filter(Boolean);
  // Keep refreshing while something is booting so its status turns green on its own.
  const head = states.some((s) => s.state === 'starting') ? `<meta http-equiv="refresh" content="2;url=${SWITCH_PATH}">` : '';
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(page('Servers', `
<h1>Servers</h1>
<p class="sub">${target === null ? 'Not proxying anything: visitors see a placeholder page'
    : `Proxying to <b>${esc(nameOf(target))}</b> <span class="mono">:${target}</span>`}</p>
${errors.map((m) => `<p class="msg">${esc(m)}</p>`).join('')}
<div class="list">${noneRow}${rows}</div>${custom}`, { head, nav: true }));
}

/** Switch to a port, or to null ("None"). Responds with a redirect: to the site for a port,
 *  back to the switch page for None. */
function doSwitch(port: number | null, res: Res): void {
  if (port !== null) {
    const known = config.servers.some((s) => s.port === port);
    if (!(port > 0 && port < 65536) || port === LISTEN_PORT || (!known && !ALLOW_UNREGISTERED)) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end(`Not allowed: ${port}\n`);
      return;
    }
  }
  if (port !== target) {
    console.log(`[switch] ${describe(target)} -> ${describe(port)}`);
    target = port;
    for (const s of tunnels) s.destroy();
    tunnels.clear();
  }
  res.writeHead(302, { location: port === null ? SWITCH_PATH : '/', 'cache-control': 'no-store' });
  res.end();
}

// What visitors get while "None" is selected.
function renderIdle(res: Res): void {
  res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(page('Nothing served', `<div class="card">
  <span class="badge" style="background:var(--chip);color:var(--mute)">${icon('power', 18)}</span>
  <h1>Nothing is being served right now</h1>
  <p class="sub" style="margin:0">This address isn't pointed at a server at the moment.</p>
</div>`));
}

async function doAction(action: Action, name: string, res: Res): Promise<void> {
  const entry = reloadConfig().servers.find((s) => s.name === name);
  let msg = '';
  try {
    if (!entry) throw new Error(`unknown server "${name}"`);
    if (action !== 'start') await launcher.stop(entry);
    if (action !== 'stop') await launcher.start(entry);
    console.log(`[switch] ${action} ${name}`);
  } catch (err) {
    msg = `${action} ${name}: ${errMsg(err)}`;
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
const clampLines = (query: string, dflt: number) =>
  Math.min(5000, Math.max(0, Number(new URLSearchParams(query).get('lines') ?? dflt) || 0));
const linesParam = (query: string) => (new URLSearchParams(query).has('lines') ? `?lines=${clampLines(query, 0)}` : '');

function fileSize(file: string): number {
  try { return fs.statSync(file).size; } catch { return 0; }
}

function readRange(file: string, start: number, end: number): Buffer {
  if (end <= start) return Buffer.alloc(0);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(end - start);
    return buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, start));
  } finally { fs.closeSync(fd); }
}

/** A log's first line (portctl writes a timestamp there), hashed: when it changes, the file
 *  was rewritten by a restart even if it has already grown past our read position.
 *  null if the file doesn't exist; throws if it exists but can't be read. */
function logSignature(file: string): string | null {
  let head: Buffer;
  try { head = readRange(file, 0, 256); } catch (err) {
    if (errCode(err) === 'ENOENT') return null; // not there (yet), e.g. mid-restart
    throw err; // there but unreadable: the caller reports it
  }
  const nl = head.indexOf(10);
  return crypto.createHash('sha1').update(nl === -1 ? head : head.subarray(0, nl)).digest('hex').slice(0, 8);
}

/** Where the last `lines` lines of a file start (looking back at most 1MB), and how many
 *  lines that actually is (fewer if the file is shorter). */
function tailOffset(file: string, lines: number): { offset: number; count: number } {
  const size = fileSize(file);
  if (!lines) return { offset: size, count: 0 };
  const from = Math.max(0, size - 1024 * 1024);
  let buf: Buffer;
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

interface HistoryPart {
  file: string;
  label: string;
  start: number; // byte range to send
  end: number;
  startedAt: string | null; // when that run started / ended (ISO); endedAt is null for the current run
  endedAt: string | null;
}

/** When a log's run started: portctl writes "# <ISO time>  (cwd ...)" as its first line. */
function runStartedAt(file: string): string | null {
  let head = '';
  try { head = readRange(file, 0, 64).toString('latin1'); } catch { return null; }
  return /^# (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)/.exec(head)?.[1] ?? null;
}

/** When a previous run ended: the last write to its log. */
function runEndedAt(file: string): string | null {
  try { return fs.statSync(file).mtime.toISOString(); } catch { return null; }
}

/** The last `lines` lines of a server's log, reaching back into previous runs
 *  (<name>.log.1, .2, ... kept by portctl) when the current run is shorter.
 *  Oldest first; the last part is always the current log. */
function logHistory(name: string, lines: number): HistoryPart[] {
  const file = launcher.logFile(name);
  const parts: HistoryPart[] = [];
  let need = lines;
  for (let run = 0; run === 0 || (need > 0 && run <= 100); run++) {
    const f = run ? `${file}.${run}` : file;
    if (run && !fs.existsSync(f)) break;
    const { offset, count } = tailOffset(f, need);
    parts.unshift({
      file: f,
      label: run ? `previous run (${path.basename(f)})` : 'current run',
      start: offset,
      end: fileSize(f),
      startedAt: runStartedAt(f),
      endedAt: run ? runEndedAt(f) : null,
    });
    need -= count;
  }
  return parts;
}

// One fs.watchFile per log, shared by every open stream. (Works before the file exists.)
const logWatchers = new Map<string, Set<() => void>>();
function watchLog(file: string, onChange: () => void): () => void {
  let subs = logWatchers.get(file);
  if (!subs) {
    const created = new Set<() => void>();
    subs = created;
    logWatchers.set(file, created);
    fs.watchFile(file, { interval: 300 }, () => { for (const fn of created) fn(); });
  }
  const mine = subs;
  mine.add(onChange);
  return () => {
    mine.delete(onChange);
    if (!mine.size) { fs.unwatchFile(file); logWatchers.delete(file); }
  };
}

function parseLastEventId(header: string | undefined): Record<string, { offset: number; sig: string }> {
  const resume: Record<string, { offset: number; sig: string }> = {};
  for (const part of (header || '').split(';')) {
    const m = /^([\w.-]+)=(\d+)\.(\w+)$/.exec(part);
    if (m) resume[m[1]] = { offset: Number(m[2]), sig: m[3] };
  }
  return resume;
}

interface LogStream {
  name: string;
  file: string;
  sig: string | null;
  offset: number;
  older: HistoryPart[];
  decoder: StringDecoder;
  error?: string;
}

const MAX_STREAMS = 64; // open log streams; past this the oldest is closed (its viewer reconnects)
const MAX_BUFFERED = 8 * 1024 * 1024; // a client this far behind is dropped; it resumes on reconnect
const openStreams = new Set<(why?: string) => void>();

function streamLogs(req: Req, res: Res, names: string[], lines: number): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    'x-accel-buffering': 'no', // nginx: don't buffer the stream
  });
  // Notice clients that vanish without closing the connection (sleep, network drop).
  req.socket.setKeepAlive(true, 30000);
  req.socket.setNoDelay(true);

  let closed = false;
  let unwatch: (() => void)[] = [];
  let ping: ReturnType<typeof setInterval> | undefined;
  const close = (why?: string) => {
    if (closed) return;
    closed = true;
    clearInterval(ping);
    unwatch.forEach((fn) => fn());
    openStreams.delete(close);
    if (why) console.log(`[logs] closed a stream (${names.join(', ')}): ${why}`);
    res.destroy();
  };
  res.on('close', () => close());
  res.on('error', (err) => close(errText(err)));
  openStreams.add(close);
  if (openStreams.size > MAX_STREAMS) openStreams.values().next().value?.('too many open log streams');
  res.write('retry: 2000\n\n');

  const resume = parseLastEventId(req.headers['last-event-id'] as string | undefined);
  const streams = names.map((name): LogStream => {
    const file = launcher.logFile(name);
    let sig: string | null = null;
    try { sig = logSignature(file); } catch {}
    const prev = resume[name];
    if (prev && sig !== null && prev.sig === sig && prev.offset <= fileSize(file)) {
      return { name, file, sig, offset: prev.offset, older: [], decoder: new StringDecoder('utf8') };
    }
    const parts = logHistory(name, lines);
    const current = parts.pop() as HistoryPart;
    return { name, file, sig, offset: current.start, older: parts, decoder: new StringDecoder('utf8') };
  });
  const id = () => streams.map((s) => `${s.name}=${s.offset}.${s.sig}`).join(';');
  const send = (event: string, data: object) => {
    if (closed) return;
    res.write(`${event ? `event: ${event}\n` : ''}id: ${id()}\ndata: ${JSON.stringify(data)}\n\n`);
    if (res.writableLength > MAX_BUFFERED) close('client too slow');
  };

  // Tell the viewer once when a log can't be read (e.g. permissions), and again when it can.
  const readError = (s: LogStream, err: unknown) => {
    const msg = err ? `can't read ${path.basename(s.file)}: ${errText(err)}` : '';
    if (msg === (s.error || '')) return;
    s.error = msg;
    send('notice', { n: s.name, text: msg || `${path.basename(s.file)} is readable again` });
  };

  const pump = (s: LogStream) => {
    if (closed) return;
    try {
      let sig: string | null;
      try { sig = logSignature(s.file); } catch (err) { return readError(s, err); }
      if (sig === null) return; // gone for the moment (a restart renames it, then writes the new one)
      if (s.error) readError(s, null);
      const size = fileSize(s.file);
      if (sig !== s.sig || size < s.offset) {
        Object.assign(s, { sig, offset: 0, decoder: new StringDecoder('utf8') });
        send('reset', { n: s.name, startedAt: runStartedAt(s.file) });
      }
      while (s.offset < size && !closed) {
        const end = Math.min(size, s.offset + 256 * 1024);
        let chunk: Buffer;
        try { chunk = readRange(s.file, s.offset, end); } catch (err) { return readError(s, err); }
        s.offset += chunk.length;
        const text = s.decoder.write(chunk); // holds back a multi-byte character cut in half
        if (text) send('', { n: s.name, t: text });
        if (!chunk.length) return;
      }
    } catch (err) {
      console.error(`[logs] ${s.name}:`, err);
      close('error');
    }
  };

  // History from previous runs first (those files don't change), then the live log.
  const sendOlder = (s: LogStream) => {
    if (!s.older.length) return;
    for (const part of s.older) {
      send('run', { n: s.name, label: part.label, startedAt: part.startedAt, endedAt: part.endedAt });
      const decoder = new StringDecoder('utf8');
      for (let pos = part.start; pos < part.end;) {
        let chunk: Buffer;
        try { chunk = readRange(part.file, pos, Math.min(part.end, pos + 256 * 1024)); } catch (err) {
          send('notice', { n: s.name, text: `can't read ${path.basename(part.file)}: ${errText(err)}` });
          break;
        }
        if (!chunk.length) break;
        pos += chunk.length;
        const text = decoder.write(chunk);
        if (text) send('', { n: s.name, t: text });
      }
    }
    send('run', { n: s.name, label: 'current run', startedAt: runStartedAt(s.file), endedAt: null });
  };
  try {
    streams.forEach((s) => { sendOlder(s); pump(s); });
  } catch (err) {
    console.error('[logs] sending history:', err);
    return close('error');
  }
  if (closed) return;
  unwatch = streams.map((s) => watchLog(s.file, () => pump(s)));
  ping = setInterval(() => { if (!closed) res.write(': ping\n\n'); }, 20000); // keeps idle proxies from dropping it
}

const fmtDuration = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  const [d, h, m] = [Math.floor(s / 86400), Math.floor((s % 86400) / 3600), Math.floor((s % 3600) / 60)];
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`;
};

/** " · 2026-10-14 17:02:11Z -> 18:40:05Z (1h 38m)" for the plain-text dividers (UTC). */
function runSpan(startedAt: string | null, endedAt: string | null): string {
  const t = (iso: string) => iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z');
  if (!startedAt) return '';
  if (!endedAt) return ` · started ${t(startedAt)}`;
  const end = startedAt.slice(0, 10) === endedAt.slice(0, 10) ? t(endedAt).slice(11) : t(endedAt);
  return ` · ${t(startedAt)} -> ${end} (${fmtDuration(Date.parse(endedAt) - Date.parse(startedAt))})`;
}

function showLogText(res: Res, name: string, query: string): void {
  const parts = logHistory(name, clampLines(query, LOG_LINES));
  const text = parts.map((p) => {
    let body = '';
    try { body = readRange(p.file, p.start, p.end).toString('utf8'); } catch {}
    if (parts.length > 1) body = `----- ${name}: ${p.label}${runSpan(p.startedAt, p.endedAt)} -----\n${body}${body && !body.endsWith('\n') ? '\n' : ''}`;
    return body;
  }).join('');
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text || '(no log yet)\n');
}

const LOG_STYLE = `
  html, body { height:100%; }
  body { display:flex; flex-direction:column; }
  .topbar h1 { font-size:15px; margin:0 4px; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .topbar .tools { margin-left:auto; display:flex; gap:6px; }
  #out { flex:1; overflow:auto; margin:0; padding:10px 16px 28px; background:#0b0c0f; color:#d6d6d6;
         font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; white-space:pre; }
  #out.wrap { white-space:pre-wrap; overflow-wrap:anywhere; }
  .ln { min-height:1.5em; }
  .sys { color:#7d838d; font-style:italic; }
  .tag { display:inline-block; margin-right:1ch; font-weight:600; }
  #bottom { position:fixed; right:20px; bottom:20px; display:none; box-shadow:0 4px 14px rgba(0,0,0,.35); }
  .filterbar { flex:none; display:flex; flex-wrap:wrap; align-items:center; gap:8px; padding:8px 16px; background:var(--card); border-bottom:1px solid var(--line); }
  .search { flex:1; min-width:240px; display:flex; align-items:center; gap:2px; height:32px; padding:0 4px 0 10px;
            border:1px solid var(--line); border-radius:7px; background:var(--bg); color:var(--mute); }
  .search:focus-within { border-color:var(--acc); box-shadow:var(--ring); }
  .search.bad, .search.bad:focus-within { border-color:var(--danger); box-shadow:none; }
  .search input { flex:1; height:28px; border:0; background:transparent; box-shadow:none; padding:0 6px; font-size:13px; }
  .search input:focus { box-shadow:none; }
  .tog { width:28px; height:24px; flex:none; display:inline-flex; align-items:center; justify-content:center; border:1px solid transparent; border-radius:5px;
         background:transparent; color:var(--mute); cursor:pointer; font:12px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
  .tog:hover { background:var(--chip); color:var(--fg); }
  .tog[aria-pressed=true] { color:var(--acc); background:var(--acc-tint); border-color:var(--acc); }
  .tog.word { text-decoration:underline; text-underline-offset:3px; }
  .seg { display:inline-flex; border:1px solid var(--line); border-radius:7px; overflow:hidden; }
  .seg button { height:30px; padding:0 12px; border:0; background:transparent; color:var(--mute); font-family:inherit; font-size:13px; font-weight:500; cursor:pointer; }
  .seg button:hover { color:var(--fg); }
  .seg button[aria-pressed=true] { background:var(--acc-tint); color:var(--acc); }
  select.btn { padding:0 8px; }
  #nav { display:inline-flex; gap:2px; }
  .count { font-size:12px; color:var(--mute); white-space:nowrap; } .count b { color:var(--fg); font-weight:500; }
  .qerr { font-size:12px; color:var(--danger); }
  .servers { gap:6px; padding:7px 16px; } .servers .lbl { font-size:12px; color:var(--mute); margin-right:2px; }
  .schip { height:24px; padding:0 10px; border-radius:999px; border:1px solid var(--line); background:var(--bg); cursor:pointer;
           font:600 12px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
  .schip[aria-pressed=false] { opacity:.45; text-decoration:line-through; }
  #out .ln.hide, #out.filtering .ln.new { display:none; }
  #out .ln.ctx { opacity:.5; }
  #out .ln.gap { margin-top:5px; padding-top:5px; border-top:1px dashed #2c313b; }
  #out .ln.flash { animation:flash 1.8s ease-out; }
  @keyframes flash { from { background:#2b3a72; } to { background:transparent; } }
  ::highlight(ps-match) { background-color:#5c4a12; color:#ffe08a; }
  ::highlight(ps-current) { background-color:#d9a514; color:#111; }
  #jump { position:fixed; z-index:5; display:none; height:22px; padding:0 8px; font-size:11px; box-shadow:0 2px 8px rgba(0,0,0,.35); }`;

function renderLogViewer(res: Res, { title, streamUrl, combined, names }: { title: string; streamUrl: string; combined: boolean; names: string[] }): void {
  const opts: LogClientOptions = { streamUrl, combined, names, tagWidth: Math.max(...names.map((n) => n.length)) };
  const ctxOptions = [0, 1, 2, 3, 5, 10].map((n) => `<option value="${n}">${n ? `±${n} line${n > 1 ? 's' : ''}` : 'No context'}</option>`).join('');
  const json = JSON.stringify(opts).replace(/</g, '\\u003c');
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(`${htmlHead(title, `<style>${LOG_STYLE}</style>`)}</head><body>
<header class="topbar">
  <a class="btn ghost icon" href="${SWITCH_PATH}" title="All servers" aria-label="Back to servers">${icon('back')}</a>
  <h1>${esc(title)}</h1>
  <span class="pill warn" id="conn"><i></i><span id="conn-text">Connecting</span></span>
  <div class="tools">
    <button class="btn" id="pause" aria-pressed="false">Pause</button>
    <button class="btn" id="wrap" aria-pressed="false">Wrap</button>
    <button class="btn" id="clear">Clear</button>
  </div>
</header>
<div class="filterbar">
  <div class="search" id="search">
    ${icon('search', 15)}
    <input id="q" class="mono" placeholder="Filter lines  (Ctrl+F)" spellcheck="false" autocomplete="off" aria-label="Filter lines">
    <button class="tog" id="t-case" aria-pressed="false" title="Match case">Aa</button>
    <button class="tog word" id="t-word" aria-pressed="false" title="Whole word">ab</button>
    <button class="tog" id="t-re" aria-pressed="false" title="Regular expression">.*</button>
    <button class="tog" id="t-inv" aria-pressed="false" title="Invert: show lines that don't match">!</button>
    <button class="tog" id="q-clear" title="Clear (Esc)" aria-label="Clear filter">${icon('x', 14)}</button>
  </div>
  <div class="seg" role="group" aria-label="Mode">
    <button id="m-filter" aria-pressed="true" title="Show only matching lines">Filter</button>
    <button id="m-hl" aria-pressed="false" title="Show every line, mark the matches">Highlight</button>
  </div>
  <select class="btn" id="ctx" title="Lines of context around each match">${ctxOptions}</select>
  <span id="nav" hidden>
    <button class="btn ghost icon" id="nav-prev" title="Previous match (Shift+Enter)" aria-label="Previous match">${icon('up')}</button>
    <button class="btn ghost icon" id="nav-next" title="Next match (Enter)" aria-label="Next match">${icon('down')}</button>
  </span>
  <span class="count" id="count"></span>
  <span class="qerr" id="q-err"></span>
</div>
${combined ? '<div class="filterbar servers" id="servers"><span class="lbl">Servers</span></div>' : ''}
<pre id="out"></pre>
<button class="btn primary" id="bottom">Latest &darr;</button>
<button class="btn" id="jump" title="Show this line in the full log">Jump to ${icon('jump', 12)}</button>
<script>(${logClient.toString()})(${json});</script>
</body></html>`);
}

// ---- proxy -----------------------------------------------------------------
// Rewrite absolute redirects to localhost (e.g. http://localhost:3001/login) into
// relative ones so they survive the outer HTTPS proxy.
function fixLocation(loc: string): string {
  return loc.replace(/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(?=\/|$)/i, '') || '/';
}

function upstreamHeaders(req: Req, port: number): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = { ...req.headers, host: `localhost:${port}` };
  headers['x-forwarded-host'] ??= req.headers.host;
  headers['x-forwarded-proto'] ??= 'http';
  headers['x-forwarded-for'] ??= req.socket.remoteAddress;
  return headers;
}

function badGateway(res: Res, port: number, err: unknown): void {
  if (res.headersSent) { res.destroy(); return; }
  const entry = entryOf(port);
  let running = true;
  try { running = !!entry && !!launcher.getPid(entry.name); } catch {}
  const startBtn = entry?.cmd && !running ? actionButton('start', entry.name, `Start ${entry.name}`) : '';
  res.writeHead(502, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(page('Not responding', `<div class="card">
  <span class="badge">${icon('unplug', 18)}</span>
  <h1>${esc(nameOf(port))} isn't responding</h1>
  <p class="sub"><span class="mono">:${port}</span> &middot; <span class="chip mono">${esc(errText(err))}</span></p>
  <div class="buttons">${startBtn}<a class="btn" href="${SWITCH_PATH}">All servers</a></div>
</div>`));
}

const hasBody = (req: Req) => !!req.headers['transfer-encoding'] || Number(req.headers['content-length']) > 0;

function proxy(req: Req, res: Res, retry = true): void {
  const port = target;
  if (port === null) { req.resume(); renderIdle(res); return; }
  const headers = upstreamHeaders(req, port);
  // A plain request never asks the server to switch protocols (see the 'upgrade' handler).
  delete headers.upgrade;
  delete headers['http2-settings'];
  if (/upgrade/i.test(String(headers.connection ?? ''))) delete headers.connection;
  const up = http.request({ host: UPSTREAM_HOST, port, method: req.method, path: req.url, headers }, (pres) => {
    const headers = { ...pres.headers };
    if (headers.location) headers.location = fixLocation(headers.location);
    res.writeHead(pres.statusCode ?? 502, pres.statusMessage, headers);
    pres.pipe(res);
    // The server went away mid-response: end the client's response too instead of leaving it hanging.
    pres.on('aborted', () => res.destroy());
    pres.on('error', () => res.destroy());
  });
  up.on('error', (err) => {
    // A reused keep-alive connection that the server closed just as we sent on it. Nothing
    // reached the server, so a request without a body is safe to send again.
    if (retry && up.reusedSocket && ['ECONNRESET', 'EPIPE'].includes(errCode(err) ?? '') && !res.headersSent && !hasBody(req)) {
      proxy(req, res, false);
      return;
    }
    if (res.destroyed) return; // the client already left; nothing to report to
    console.log(`[proxy] ${req.method} ${req.url} -> :${port}: ${errText(err)}${res.headersSent ? ' (mid-response)' : ''}`);
    badGateway(res, port, err);
  });
  // The client went away first: drop the upstream request.
  res.on('close', () => { if (!res.writableFinished) up.destroy(); });
  if (hasBody(req)) req.pipe(up);
  else { req.resume(); up.end(); }
}

async function handleSwitch(req: Req, res: Res, urlPath: string, query: string): Promise<void> {
  if (await guard(req, res, urlPath)) return;
  if (urlPath === SWITCH_PATH || urlPath === SWITCH_PATH + '/') {
    return renderSwitchPage(res, new URLSearchParams(query).get('msg'));
  }
  let parts: string[] = [];
  try { parts = urlPath.slice(SWITCH_PATH.length + 1).split('/').filter(Boolean).map(decodeURIComponent); } catch {}
  if (parts.length === 1 && /^\d+$/.test(parts[0])) return doSwitch(Number(parts[0]), res);
  if (parts.length === 1 && parts[0] === 'none') return doSwitch(null, res);
  if (parts.length === 2 && req.method === 'POST' && (ACTIONS as readonly string[]).includes(parts[0])) {
    req.resume();
    return doAction(parts[0] as Action, parts[1], res);
  }
  if (parts[0] === 'log' && parts.length <= 3 && req.method === 'GET') {
    const name = parts[1];
    if (!logNames().includes(name)) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('unknown server\n'); return; }
    if (parts[2] === 'stream') return streamLogs(req, res, [name], clampLines(query, LOG_LINES));
    if (parts.length === 3) { res.writeHead(404); res.end(); return; }
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
    res.end(JSON.stringify({ target, name: nameOf(target), logStreams: openStreams.size, websockets: tunnels.size }));
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found\n');
}

function route(req: Req, res: Res): void {
  const [urlPath, query = ''] = (req.url ?? '/').split('?');
  if (urlPath === SWITCH_PATH || urlPath.startsWith(SWITCH_PATH + '/')) {
    handleSwitch(req, res, urlPath, query).catch((err) => {
      console.error('[switch]', err);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
    return;
  }
  proxy(req, res);
}

const server = http.createServer(route);

const closeWith = (socket: Duplex, status: number) => {
  if (!socket.writable) { socket.destroy(); return; }
  socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
};

// Requests with an Upgrade header. Node hands these over as a bare socket, and whatever we
// do with it decides what *later* requests on the same connection reach. The rule: a
// connection becomes a tunnel to the server only once the server has answered 101. Before
// that it's still ordinary HTTP to the client (and to an outer proxy pooling connections),
// so if it were piped to the server early, the next requests on it -- /switch pages
// included -- would skip this proxy and land on the server ("Cannot GET /switch/...").
server.on('upgrade', (req: Req, socket: Duplex, head: Buffer) => {
  socket.on('error', () => {});
  const urlPath = (req.url ?? '/').split('?')[0];
  const ours = urlPath === SWITCH_PATH || urlPath.startsWith(SWITCH_PATH + '/');
  if (ours || !/^websocket$/i.test(String(req.headers.upgrade ?? ''))) answerPlainly(req, socket);
  else tunnelWebSocket(req, socket, head);
});

/** Serve an upgrade request that isn't an app WebSocket (anything under /switch, h2c, ...)
 *  as a normal request, then close the connection. */
function answerPlainly(req: Req, socket: Duplex): void {
  if (hasBody(req)) { closeWith(socket, 400); return; } // its body is no longer parsed for us
  const res = new http.ServerResponse(req);
  res.shouldKeepAlive = false;
  res.assignSocket(socket as net.Socket);
  res.on('finish', () => socket.end());
  route(req, res);
}

function tunnelWebSocket(req: Req, socket: Duplex, head: Buffer): void {
  const port = target;
  if (port === null) { closeWith(socket, 503); return; } // "None": nothing to connect to
  let settled = false;
  const up = http.request({
    host: UPSTREAM_HOST, port, method: req.method, path: req.url,
    headers: upstreamHeaders(req, port), agent: false, timeout: 5000,
  });
  const decline = (status: number, why: string) => {
    if (settled) return;
    settled = true;
    console.log(`[proxy] websocket ${req.url} -> :${port}: ${why}`);
    closeWith(socket, status);
  };
  up.on('timeout', () => up.destroy(new Error('no answer within 5s')));
  up.on('error', (err) => decline(502, errText(err)));
  // Answered without switching protocols (e.g. 404 from an app with no WebSocket there):
  // pass the status on and close the connection; never tunnel it.
  up.on('response', (pres) => { pres.resume(); decline(pres.statusCode ?? 502, `declined (${pres.statusCode})`); });
  up.on('upgrade', (pres, upSocket, upHead) => {
    settled = true;
    upSocket.setTimeout(0);
    let raw = `HTTP/1.1 101 ${pres.statusMessage || 'Switching Protocols'}\r\n`;
    for (let i = 0; i < pres.rawHeaders.length; i += 2) raw += `${pres.rawHeaders[i]}: ${pres.rawHeaders[i + 1]}\r\n`;
    socket.write(raw + '\r\n');
    if (upHead.length) socket.write(upHead);
    if (head.length) upSocket.write(head);
    // Small messages (HMR updates) go out at once; dead peers on either side get noticed.
    for (const s of [socket as net.Socket, upSocket]) { s.setNoDelay(true); s.setKeepAlive(true, 30000); }
    const close = () => { upSocket.destroy(); socket.destroy(); tunnels.delete(socket); };
    tunnels.add(socket);
    upSocket.on('error', close);
    upSocket.on('close', close);
    socket.on('close', close);
    socket.pipe(upSocket).pipe(socket);
  });
  socket.on('close', () => { if (!settled) up.destroy(); });
  up.end();
}

// Keep idle client connections open longer than the outer proxy does (nginx 60s, Traefik
// 90s, Cloudflare 90s, ...). If we closed first, it could send a request on a connection
// just as we close it, and that request fails with a brief 502.
server.keepAliveTimeout = 150 * 1000;
server.headersTimeout = 155 * 1000; // must exceed keepAliveTimeout on older Node

// Malformed requests and clients that drop mid-request: answer if possible, never throw.
server.on('clientError', (err: NodeJS.ErrnoException, socket: Duplex) => {
  if (err.code !== 'ECONNRESET' && socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  else socket.destroy();
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(`[port-switch] listening on ${LISTEN_HOST}:${LISTEN_PORT} -> ${describe(target)}`);
  console.log(`[port-switch] switch page: http://localhost:${LISTEN_PORT}${SWITCH_PATH}`);
});
