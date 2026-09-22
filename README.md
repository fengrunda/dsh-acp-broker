# dsh-acp-broker

A long-lived **ACP multi-session broker** for DeepSeek Harness.

`dsh --profile acp` already supports several independent sessions on one
connection. What is missing is a process that *holds that connection open* and
lets an external CLI address sessions by name. `dsh-acp-broker` is that process:
it spawns one `dsh --profile acp` child, keeps a **ticket map** of
`ticket -> sessionId + cwd + meta`, and routes prompts from a thin CLI to
co-resident sessions.

Because the sessions stay loaded in a single process, `dsh-team-rooms` live
`agent.followup(...)` can wake a member that is still resident. A one-shot ACP
client (prompt, then exit) cannot do this — every peer goes offline between
ticks.

- **Wire**: ACP v1 over stdio only. No `dsh web`, no Host API, no HTTP server.
- **Target**: dsh `0.1.5-rc.2` ACP surface
  (`session/new | session/list | session/resume | session/close | session/prompt`).
- **Default behavior**: prompts **never** close a session. `close` is explicit.
- **Control plane**: Unix-domain socket + thin CLI (see [Why a Unix socket](#why-a-unix-domain-socket)).

## Requirements

- Node.js >= 20.11
- `dsh` `0.1.5-rc.2` on `PATH` (or `DSH_BIN` / `DSH_ACP_BROKER_DSH_BIN`)
- An `acp` profile that can create sessions. For live team-rooms wake, that
  profile must also mount `dsh-team-rooms`.

## Install

```bash
npm install -g dsh-acp-broker
dsh-acp-broker --help
```

From a checkout:

```bash
npm install
npm run build
node dist/cli.js --help
# or link the bin: npm link
```

## Quickstart: open 2–3 tickets

```bash
# 1. start the long-lived broker (detached; state in ./.dsh-broker)
dsh-acp-broker start

# 2. open tickets by prompting them the first time (--cwd is required then)
dsh-acp-broker prompt --ticket supervisor  --cwd "$PWD" "You are the supervisor. Reply READY."
dsh-acp-broker prompt --ticket foreman-a   --cwd "$PWD" "You are foreman A. Reply READY."
dsh-acp-broker prompt --ticket foreman-b   --cwd "$PWD" "You are foreman B. Reply READY."

# 3. followups reuse the same live session (no session/resume, no close)
dsh-acp-broker prompt --ticket supervisor "List the tickets you know about."

# 4. inspect
dsh-acp-broker status
dsh-acp-broker list
dsh-acp-broker list --json

# 5. resume a persisted ticket after a broker restart
dsh-acp-broker resume --ticket supervisor

# 6. explicit teardown
dsh-acp-broker close --ticket supervisor   # session/close for that one ticket
dsh-acp-broker stop                         # stops the broker + ACP child
```

`prompt` writes the assistant text to **stdout** and ticket/session metadata to
**stderr**, so it is safe to pipe:

```bash
answer=$(dsh-acp-broker prompt --ticket supervisor "ping")
```

## Commands

| Command | What it does |
|---|---|
| `start [--dir DIR]` | Spawn the detached broker if not already running. |
| `status [--dir DIR] [--json]` | Broker pid/uptime, ACP child pid, live tickets, ticket map. Exits `1` when not running. |
| `stop [--dir DIR]` | Ask the broker to shut down and wait for the socket to disappear. |
| `prompt --ticket NAME [--cwd ABS] [--keep-open] [--dir DIR] TEXT...` | Route a prompt to a ticket, creating or resuming its session. Never closes. |
| `resume --ticket NAME [--cwd ABS] [--dir DIR]` | Load a ticket's session without prompting it. |
| `list [--cwd ABS] [--dir DIR] [--json]` | ACP `session/list` plus the persisted ticket map. |
| `close --ticket NAME [--dir DIR]` | Explicit `session/close` and remove the ticket file. |

`--keep-open` is accepted and is the default (and currently the only) prompt
behavior. `close` is the sole way to end a session.

## Live followup needs co-resident sessions

A ticket is "live" once it has been prompted or resumed: its ACP session is
loaded in the broker's single `dsh --profile acp` child. Only then can
`dsh-team-rooms` deliver a live `agent.followup` to that member.

For peer-to-peer live wake:

1. The `acp` profile must mount `dsh-team-rooms` (e.g.
   `dsh plugin --profile acp add dsh-team-rooms`).
2. All peers must be opened as tickets on the **same broker** (one connection,
   one process) so their sessions are co-resident.
3. Keep the broker running. Between prompts the sessions stay loaded — that is
   the whole point of the broker. Do not `close` a peer you still need.
4. After a broker restart, `resume --ticket NAME` (or the next `prompt`) brings
   the persisted session back; team-rooms then injects backlog on
   `session-start` and live followup works again.

If each peer is driven by a one-shot ACP client instead, all peers are offline
between ticks and live followup cannot fire. That is the gap this package fills.

## State layout and configuration

Default root is `./.dsh-broker` (relative to the working directory). Override
with `--dir <path>` or `DSH_BROKER_DIR`.

```
<DIR>/
  tickets/<name>.json   ticket -> sessionId + cwd + meta (mode 0600)
  broker.sock           Unix-domain control socket (mode 0600)
  broker.pid            daemon pid file
  broker.log            detached daemon stdout/stderr
```

| Env var | Default | Meaning |
|---|---|---|
| `DSH_BROKER_DIR` | `./.dsh-broker` | Broker state directory. |
| `DSH_ACP_BROKER_DSH_BIN` | `$DSH_BIN` or `dsh` | Binary to spawn. |
| `DSH_ACP_BROKER_DSH_ARGS` | `--profile acp` | ACP child args (shell-like quoting). |
| `DSH_HOME` | `~/.dsh` | Forwarded to the ACP child. |
| `DSH_PERMISSION_MODE` | `danger-full-access` | Forwarded if unset. |
| `DSH_ACP_PROMPT_TIMEOUT` | `900` | Seconds the broker waits for one `session/prompt`. |
| `DSH_ACP_BROKER_CLIENT_TIMEOUT` | `1800` | Seconds the CLI waits for a prompt response over the socket. |

A ticket name is sanitized for its filename (`team/room alpha` ->
`team_room_alpha.json`) but the logical name is preserved in the JSON.

## Why a Unix-domain socket

The control plane is a Unix-domain socket carrying one newline-delimited JSON
request/response per connection, with a thin CLI client.

- No TCP port to choose, bind, or accidentally expose on the LAN.
- Filesystem mode (`0600`) is the access boundary.
- Keeps the "ACP stdio only" constraint: no web server, no Host API, no HTTP
  framework dependency.
- The client is small enough to stay a thin CLI instead of a second daemon.

A loopback HTTP control plane would add a port, CORS/auth questions, and a
framework dependency for no benefit here. If you need remote control later, put
a proxy in front of the socket rather than changing the broker.

## Placeholder `dsh.bundle`

`package.json` carries an **optional placeholder** `dsh.bundle` block with fake
names (`example_broker_ping`, `example-broker-hello`). Nothing implements them in
this slice; they exist only to reserve the manifest shape for a future plugin
bundle. The broker itself is a plain CLI/daemon and does not require any dsh
plugin to be installed.

## Development

```bash
npm run build   # tsc -> dist/
npm test        # build + node --test test/*.test.mjs
```

Tests use a mock ACP child (`test/mock-acp-child.mjs`) that speaks the same
stdio JSON-RPC surface and journals every method call, so ticket routing and
keep-open behavior are asserted without a real model call:

- `test/acp.test.mjs` — connection/session/prompt/update/close mechanics
- `test/broker.test.mjs` — ticket routing, co-residency, explicit close, resume
- `test/cli.test.mjs` — daemon + socket end-to-end through the CLI
- `test/helpers.mjs` — temp dirs and journal readers

## License

MIT — see [LICENSE](./LICENSE).
