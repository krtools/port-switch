# port-switch

A small reverse proxy that puts several local HTTP servers behind one port and lets you switch which one it serves, plus `portctl`, a CLI that runs those servers in the background.

Built for a box where only one port (e.g. 3000) is reachable from outside through another HTTPS proxy, while the dev servers run on 3001, 3002, … No runtime dependencies, only Node 16+.

```
browser ──https──> outer proxy ──> :3000 port-switch ──> :3001 app-one   (active)
                                                         :3002 app-two
                                                         ...
```

- **Switch page** at `/switch`: pick the active server, start/stop/restart servers, open their logs. Password-protected.
- **Everything else** on the port goes to the active server, WebSockets included (HMR works).
- **Live log viewer** in the browser, with terminal colors, per server or all combined.
- **`portctl`**: start/stop/restart/status/logs from the command line, servers run detached and survive logout.

## Install

Build a release archive (see [Development](#development)) or grab one, then on the box:

```sh
mkdir -p ~/port-switch && tar -xzf port-switch-1.0.0.tar.gz -C ~/port-switch
cd ~/port-switch
cp servers.example.json servers.json      # then edit it
cp .env.example .env && chmod 600 .env    # then set SWITCH_PASSWORD
alias portctl='node ~/port-switch/portctl.js'   # add to your shell profile
portctl start proxy
```

To upgrade, extract a newer archive over the same folder. Archives never contain `servers.json`, `.env` or `run/`, so config and logs are left alone.

## Configuration

### servers.json

```json
{
  "proxy": { "port": 3000, "path": "/switch" },
  "logs": { "keep": 5 },
  "servers": [
    { "name": "app-one", "port": 3001, "cwd": "~/code/app-one", "cmd": "npm run dev -- --port 3001", "color": true },
    { "name": "app-two", "port": 3002, "cwd": "~/code/app-two", "cmd": "python3 -m http.server 3002" }
  ]
}
```

| Field | | |
|---|---|---|
| `proxy.port` | default `3000` | port the proxy listens on |
| `proxy.path` | default `/switch` | where the switch page and its endpoints live (change it if an app uses `/switch`) |
| `logs.keep` | default `5` | previous runs' logs to keep per server (`0` = overwrite on each start) |
| `servers[].name` | required | letters, digits, `_ . -`; `proxy`, `self` and `all` are reserved |
| `servers[].port` | required | where the server listens |
| `servers[].cmd` | optional | shell command that starts it; without it the server can be switched to but not started |
| `servers[].cwd` | optional | working directory; `~` and paths relative to `servers.json`'s folder work |
| `servers[].env` | optional | extra environment variables (`PORT` is always set to the server's port) |
| `servers[].color` | optional | `true` sets `FORCE_COLOR=1` and `CLICOLOR_FORCE=1` so tools keep colors in the log; some tools need their own flag (e.g. `--color=always`) |

The file is re-read whenever the switch page loads, so edits show up without a restart. If it's broken, the page shows the error and keeps using the last good version.

### Where files live

By default everything sits next to the code. To keep config elsewhere, use `--config <file>` (anywhere on a `portctl` or `switch.js` command line) or `PORT_SWITCH_CONFIG=<file>`; the flag wins. The rest follows the config file's folder:

```
servers.json
.env           SWITCH_PASSWORD and other settings
run/<name>.pid
run/<name>.log, <name>.log.1, .2, ...   current and previous runs
```

### .env

| Variable | |
|---|---|
| `SWITCH_PASSWORD` | required for the switch page; without it `/switch` stays locked. Use something long and random (`openssl rand -base64 24`) |
| `SWITCH_COOKIE_DAYS` | how long a login lasts (default 365) |
| `SWITCH_COOKIE_DOMAIN` | unset = only the exact host you logged in on; a domain also covers its subdomains |

Restart the proxy after changing `.env` (`portctl restart proxy`). Changing the password logs out every browser. Values from `.env` are not passed to your servers.

The proxy also reads `PORT`, `HOST` (default `0.0.0.0`) and `TARGET` (initially active port) from the environment.

## portctl

```
portctl                          status (the default)
portctl start   [name...|--all]  start servers; picker if no name
portctl stop    [name...|--all]
portctl restart [name...|--all]
portctl status  [name...]        exit code 3 if a named server isn't running
portctl logs    [name] [-n N] [--no-follow] [--strip]
portctl switch  [name|port]      point the running proxy at a server
portctl help    [command]        or: portctl <command> --help
```

- `proxy` is the proxy itself (`--self` works too): `portctl start proxy`, `portctl logs proxy`. `--all` never includes it.
- `stop` kills the whole process tree (SIGTERM to the group, SIGKILL after 3s; `taskkill /T /F` on Windows), so `npm run dev`-style wrappers don't leave the real server behind.
- `--strip` removes color codes from `logs` output, for `grep` and `less`.

```
NAME     PORT  STATE    PID    UPTIME
proxy    3000  running  4412   2d 3h    -> app-one (:3001)
app-one  3001  running  5120   3h 12m   * active
app-two  3002  stopped  -      -
```

States: `running` (ours, answering), `starting` (ours, not answering yet), `stopped`, `external` (something else holds the port).

## The switch page

Log in once at `/switch`; the cookie lasts a year (it's HttpOnly, scoped to `/switch`, and never sent to your apps). Scripts can send `Authorization: Bearer <password>` instead, which is what `portctl` does. Wrong passwords are delayed 1s and capped at 20 per 15 minutes.

| | |
|---|---|
| `GET /switch` | server list with status, start/stop/restart buttons, log links |
| `GET /switch/{port}` | make that port active, then redirect to `/` (any port, registered or not) |
| `POST /switch/{start,stop,restart}/{name}` | |
| `GET /switch/log/{name}` | live log viewer; `?lines=N` history (default 1000, max 5000), `?raw` plain text |
| `GET /switch/logs` | every server's log combined (50 lines each by default) |
| `GET /switch/api/state` | `{"target", "name", "logStreams", "websockets"}` |
| `/switch/login`, `/switch/logout` | |

The log viewer renders 16/256/true colors, collapses `\r` progress bars, reaches back into previous runs' logs, resumes after a dropped connection, and keeps the last 5000 lines on screen. It streams over SSE: if output arrives in bursts behind your outer proxy, turn off response buffering there (the proxy already sends `X-Accel-Buffering: no` for nginx).

## Notes

- All apps share one browser origin, so they share cookies, localStorage and service workers. A service worker from one app can interfere with another.
- Absolute redirects to `localhost:<port>` are rewritten to relative ones, and requests reach your servers with `Host: localhost:<port>` (the original is in `X-Forwarded-Host`), which keeps dev-server host checks happy.
- Idle client connections stay open 150s, longer than common outer proxies keep theirs, to avoid occasional 502s from connection reuse races.
- The proxy log (`portctl logs proxy`, or **Proxy log** on the switch page) timestamps every line, records requests it couldn't pass through, and records why the proxy exited. A log that just stops means it was killed with SIGKILL (e.g. the OOM killer).
- Servers started by `portctl` are not restarted if they crash or the box reboots.

## Development

```sh
yarn install
yarn build          # src/*.ts -> dist/ (plus the example files and this README)
yarn typecheck
yarn watch
yarn portctl status # runs dist/portctl.js; dist/ is the default config folder for local runs
yarn archive:sh     # build + release/port-switch-<version>.tar.gz (sh)
yarn archive:win    # same, from cmd with Windows' tar
```

`src/logClient.ts` runs in the browser: `switch.ts` inlines it into the viewer page with `toString()`, so it must stay self-contained (no imports, nothing from outside the function).
