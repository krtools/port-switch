# port-switch

A small reverse proxy that puts several local HTTP servers behind one port and lets you switch which one it serves, plus `portctl`, a CLI that runs those servers in the background.

Built for a box where only one port (e.g. 3000) is reachable from outside through another HTTPS proxy, while the dev servers run on 3001, 3002, … No runtime dependencies, only Node 16+.

```
browser ──https──> outer proxy ──> :3000 port-switch ──> :3001 app-one   (active)
                                                         :3002 app-two
                                                         ...
```

- **Switch page** at `/switch`: pick the active server, start/stop/restart servers, open their logs. Password-protected.
- **None**: switch to nothing without stopping the proxy; visitors get a "nothing is being served" page. It's also where a fresh install starts, so nothing is exposed until you pick a server.
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
| `logs.keep` | default `5` | previous runs' logs to keep per server (`0` = overwrite on each start); `PORT_SWITCH_LOG_KEEP` overrides it |
| `servers[].name` | required | letters, digits, `_ . -`; `proxy`, `self`, `all` and `none` are reserved |
| `servers[].port` | required | where the server listens |
| `servers[].cmd` | optional | shell command that starts it; without it the server can be switched to but not started |
| `servers[].cwd` | optional | working directory; `~` and paths relative to `servers.json`'s folder work |
| `servers[].env` | optional | extra environment variables (`PORT` is always set to the server's port) |
| `defaults.portEnv` | default `"PORT"` | environment variable each server gets its port in; `false` for none |
| `defaults.color` | default `false` | `color` for every server that doesn't set its own |
| `servers[].portEnv` | optional | this server's port variable instead of `defaults.portEnv` (e.g. `"VITE_PORT"`), or `false` |
| `servers[].color` | optional | `true` sets `FORCE_COLOR=1` and `CLICOLOR_FORCE=1` so tools keep colors in the log; some tools need their own flag (e.g. `--color=always`) |

The file is re-read whenever the switch page loads, so edits show up without a restart. If it's broken, the page shows the error and keeps using the last good version.

### Where files live

By default everything sits next to the code. To keep config elsewhere, use `--config <file>` (anywhere on a `portctl` or `switch.js` command line) or `PORT_SWITCH_CONFIG=<file>`; the flag wins. The rest follows the config file's folder:

```
servers.json
.env           SWITCH_PASSWORD and other settings
run/<name>.pid
run/<name>.log, <name>.log.1, .2, ...   current and previous runs
run/proxy.json  the selected server and the request-log setting, restored when the proxy restarts
                (no selection saved yet: None)
```

### .env

| Variable | |
|---|---|
| `SWITCH_PASSWORD` | required for the switch page; without it `/switch` stays locked. Use something long and random (`openssl rand -base64 24`) |
| `SWITCH_COOKIE_DAYS` | how long a login lasts (default 365) |
| `SWITCH_COOKIE_DOMAIN` | unset = only the exact host you logged in on; a domain also covers its subdomains |
| `PORT_SWITCH_LOG_KEEP` | previous runs' logs to keep per server (0 to 100); overrides `logs.keep` in servers.json |

Restart the proxy after changing `.env` (`portctl restart proxy`). Changing the password logs out every browser. Values from `.env` are not passed to your servers.

The proxy also reads `PORT`, `HOST` (default `0.0.0.0`) and `TARGET` (a port, or `none`, to start on instead of the saved selection) from the environment.

## portctl

```
portctl                          status (the default)
portctl start   [name...|--all]  start servers; picker if no name
portctl stop    [name...|--all]
portctl shutdown                 stop every server, then the proxy (= stop --all --self)
portctl requests [on|off]        log every request, with the client's IP, to the proxy log
portctl restart [name...|--all]
portctl status  [name...]        exit code 3 if a named server isn't running
portctl logs    [name] [-n N] [--no-follow] [--strip]
portctl switch  [name|port|none] point the running proxy at a server (none: serve nothing)
portctl help    [command]        or: portctl <command> --help
```

- `proxy` is the proxy itself (`--self` works too): `portctl start proxy`, `portctl logs proxy`. `--all` leaves it out unless you add `--self`: `start --all --self` starts the proxy first, `stop --all --self` (or `portctl shutdown`) stops it last.
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
| `GET /switch/none` | serve nothing: every request gets a placeholder page (503), WebSockets a 503 |
| `POST /switch/{start,stop,restart}/{name}` | |
| `GET /switch/log/{name}` | live log viewer; `?lines=N` history (default 1000, max 5000), `?raw` plain text |
| `GET /switch/logs` | every server's log combined (50 lines each by default) |
| `GET /switch/api/state` | `{"target", "name", "logStreams", "websockets"}` |
| `/switch/login`, `/switch/logout` | |

The log viewer renders 16/256/true colors, collapses `\r` progress bars, reaches back into previous runs' logs (each marked with when that run started and stopped), resumes after a dropped connection, and keeps the last 5000 lines on screen.

The filter bar (`Ctrl+F`) searches the lines on screen as they stream in:

- toggles for match case (`Aa`), whole word (`ab`), regular expression (`.*`) and invert (`!`, show lines that *don't* match)
- **Filter** mode shows only matching lines, optionally with ±N lines of context from the same server; hover a line and use **Jump to** to clear the filter and land on it in the full log
- **Highlight** mode keeps every line and marks the matches; `Enter` / `Shift+Enter` (or the arrows) step through them
- on **All logs**, the **Servers** dropdown left of the field picks which servers' lines to show (or **Only** one)
- the filter lives in the URL (`?q=error&re=1&ctx=2`), so reloads keep it and filtered views can be bookmarked It streams over SSE: if output arrives in bursts behind your outer proxy, turn off response buffering there (the proxy already sends `X-Accel-Buffering: no` for nginx).

## Notes

- All apps share one browser origin, so they share cookies, localStorage and service workers. A service worker from one app can interfere with another.
- Absolute redirects to `localhost:<port>` are rewritten to relative ones, and requests reach your servers with `Host: localhost:<port>` (the original is in `X-Forwarded-Host`), which keeps dev-server host checks happy.
- Idle client connections stay open 150s, longer than common outer proxies keep theirs, to avoid occasional 502s from connection reuse races.
- **Request log** (the switch page's *Log requests* toggle, or `portctl requests on`): one line per request in the proxy log, written when it ends: `[req] GET /main.js -> :3001 200 12ms from 203.0.113.7 (x-forwarded-for: 203.0.113.7, peer 127.0.0.1)`. Behind a reverse proxy the client is the first `X-Forwarded-For` hop, shown with the raw headers and the real peer since a client can set that header itself. WebSockets get a line when they close; the log pages' own status polling is left out. WebSockets the app turns down, and requests that fail, are logged with who sent them (and the User-Agent) either way.
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

### Trying things out: `yarn dev`

`yarn dev` builds and runs port-switch against a sandbox in `.dev/` (its own `servers.json`, `.env` and `run/`, gitignored) with a set of demo servers from `scripts/dev-apps/`, then rebuilds and restarts the proxy whenever `src/` changes, keeping whichever server was selected. Open `http://localhost:4100/switch` (password `dev`). Ctrl+C stops everything.

| Demo server | For trying |
|---|---|
| `site` | an app page with a live WebSocket, a 404 for unknown paths (`/missing`), and a redirect to `localhost:<port>` (`/redirect`) |
| `chatty` | a steady colored log: levels, 256/true colors, `\r` progress bars, stack traces |
| `slow-start` | takes 6s to listen: the "starting" state |
| `crashy` | crashes after 8s: the exited state, restart markers, previous-run dividers |
| `no-cmd` | an entry with no command: switchable, not startable |

```sh
yarn dev --detach    # start it all and return (for scripted checks)
yarn dev:ctl status  # portctl against the dev setup (start crashy, switch none, logs chatty, ...)
yarn dev:stop        # stop everything the dev setup started
```

`DEV_PORT` moves it off 4100 (the demo servers use the next five ports).

`src/logClient.ts` runs in the browser: `switch.ts` inlines it into the viewer page with `toString()`, so it must stay self-contained (no imports, nothing from outside the function).

## License

MIT, see [LICENSE](LICENSE).
