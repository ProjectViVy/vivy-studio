# dsh-vivy-console

First-party **Vivy Studio console** bundle: the Vivy development loop from
inside the Studio UI. Supersedes `dsh-vivy-debugger` (the floating
bottom-right ◈ button is retired; the console lives in the conversation view
ring beside Trajectory / Context as a **「Vivy 控制台」** tab).

## One dev model only

The console manages exactly the split pair from AGENTS.md — there is **no
embedded-UI / standalone-UI split** and **no separate VIVY WEB debugging**:

| Process | What it is | Notes |
| --- | --- | --- |
| 后端 Backend | **Pure-API** vivy binary (`go build -tags vivy_headless ./cmd/vivy`), auto-compiled from workspace source into Studio scratch; serves only the `/rpc` control plane — **no embedded frontend** | real OpenAI-compatible provider path (no product mock); data isolated under `data/studio-home/vivy-console/` via `VIVY_CONFIG` + `VIVY_USER_HOME`; status / start / stop / restart / EXE override |
| 前端 Frontend | **The DEV dev server**: `pnpm dev` in `ui/`, `http://127.0.0.1:3015` — the single user-facing app | its `/rpc` proxy is pointed at the managed backend's live port (`VIVY_BACKEND_ADDR`); status / start / stop / restart / open |
| 日志 Logs | **One structured console** over the four raw streams: backend (`gateway.out.log`/`gateway.err.log`, slog JSON) and frontend (`frontend.out.log`/`frontend.err.log`, ANSI text) | level + source + text filters, follow/pause, row detail, copy; fed incrementally by a byte cursor (`logs.js`) |

The console does **not** open or debug a "VIVY WEB page" of its own: you use
the dev server at `http://127.0.0.1:3015` in the normal browser. The
retired `/vivy-web/` same-origin proxy, `hook.js` frontend-debug bridge, and
Studio-origin `/vivy-config.json` route are deleted — there is no embedded UI
to proxy (the `vivy_headless` backend carries none), and nothing else needs
the bridge.

Scope (2026-08-27): the console is two clearly separated concerns —
see the 「打包与版本」 page below for the distribution half. Distribution
(`pack` / `eval` / `release` / `install` / `rollback`) is a **separate page**,
never mixed into the dev loop; release keeps the human gate (NG-25).

**Vivy Code (2026-08-29)** is a **third** operator surface on the 总控台 card
grid: it opens a dedicated OS console for `vivy tui --demo` (Crush-style TUI
skeleton) or `--plain`. It is **not** part of 一键启动/停止/重启, does not
share the backend/frontend process tree, and never writes gateway or Vite
logs. Source root: `VIVY_CODE_ROOT` → this workspace → sibling
`../agent-vivy-tui-crush` (when that worktree has `internal/tui`).

## Host half (`index.js`)

Real Node plugin (no vm sandbox) that registers on the Studio `webServer`:

| Route | Purpose |
| --- | --- |
| `/vivy-console/api/status` `logs` `resolve` | Status (backend + frontend) / structured log timeline / path resolution; `GET /logs?cursor=<4 byte offsets>` returns only what was appended since that cursor |
| `/vivy-console/api/start` `stop` `restart` `setExe` | Backend lifecycle. **Start on the managed path first runs `go build -tags vivy_headless -o <scratch>/vivy-backend.exe ./cmd/vivy`** (incremental, output streamed into the backend log), then spawns it with the generated real-provider overlay (`VIVY_CONFIG` + `VIVY_USER_HOME` under Studio scratch) — every start reflects current workspace source; `runtime.mock` is not written (removed from product Config 2026-08-29) |
| `/vivy-console/api/frontend/status` `start` `stop` `restart` | Vite dev server lifecycle; the child gets `VIVY_BACKEND_ADDR=http://127.0.0.1:<gateway-port>` so `ui/vite.config.ts` proxies `/rpc` to the live backend port |
| `/vivy-console/api/code/status` `open` | **Vivy Code** TUI panel: status + open a dedicated console window (`go run ./cmd/vivy tui --demo` / `--plain`). Not part of backend/frontend lifecycle |
| `/vivy-console/api/lifecycle/list?kind=` `run` `jobs/<id>` | **Packaging & version management** (separate from the dev loop): reads the ledger (`generations/evals/releases/installs/events/worktrees`) and runs `pack/eval/release/reject/install/rollback/inspect` through `vivy-studio.exe` on the pinned worktree, one concurrent job with streamed output. Release forwards `--actor human --yes` only after the UI confirmation (NG-25); this surface never starts/stops the dev processes |

Backend binary resolution order: explicit EXE override (panel `setExe`) →
`VIVY_HEADLESS_EXE` env → auto-compiled `<scratch>/vivy-backend.exe`. The
first two skip the auto-compile. An override is expected to be a headless
(pure-API) build — the console no longer runs the embedded-UI binary.

Air gap: backend data lives only under `data/studio-home/vivy-console/`
(Studio's own scratch); the production Journal (`data/vivy.db`,
`data/demo/`, `data/workspaces/`) is never touched.

## Managed backend config (`backendConfig`)

总控台 writes the managed backend's `config.yaml` on every start
(`backendConfig(port, dir)` in `index.js`). The kernel decodes that file
strictly, so a key the config struct does not declare aborts startup before
the listener opens — the console then reports a start that never happened,
with only the gateway log to explain it. Provider metadata (endpoints,
protocols, models, credential variable names) has been embedded in the
backend since PROV-P1/P3, so `providers` carries `active` alone: no bundle
directory and no per-vendor block.

`tools` carries `approval` alone. `tools.enabled` is deliberately **not**
written: since the two-tier tool work (2026-08-31) that key is the sole
admission gate for the whole surface, so the template's old
`enabled: [echo_info]` left the managed model without a single T1 tool —
`ask_user`, `list_dir`, `read_file`, `search_files`, `write_file`, `patch`,
`multiedit`, `execute`, `bash`, `skills_list`, `skill_view` were all filtered
out before the engine built them, and the Eino `tool_search` catalog (which
only spans active tools) could find nothing but `echo_info`. Omitting the key
preserves the kernel's code default (`internal/config` `Tools.UnmarshalYAML`),
which is the surface the dev loop exists to exercise. Unit tests:

```text
node --test studio/dsh-vivy-console/config.test.mjs
```

## Client half (`client.js`)

Hand-authored client module in the DSH client-modules handoff format
(`window.__ModuleLoader__.load({id, factory})`, React via the injected
`require`) — no build step. It registers `conversation.view` id
`vivy-console` order 30 label 「Vivy 控制台」 with three sections, in order:
**总控台 / 日志 / 打包与版本**:

- **总控台** — one consolidated screen: an overall state line (全部运行中 /
  后端运行中 · 前端未运行 / …), and **▶ 一键启动 / ■ 一键停止 / ⟳ 一键重启**
  (orchestrates backend + frontend sequentially), and two side-by-side
  status cards:
  - **后端状态**: 状态 / PID / 监听 / 启动于 / EXE / 形态（纯 API …
    vivy_headless）/ 编译方式, plus individual 启动/停止/重启 and the EXE
    override input (留空自动编译).
  - **前端状态**: 状态 / PID / 入口（127.0.0.1:3015 Vite DEV 开发服务器，
    唯一前端）/ 启动于 / 命令 / 代理（/rpc → 后端）, plus individual
    启动/停止/重启 and a「打开」button that opens
    `http://127.0.0.1:3015` in a new tab (the dev server is the app).
  - **Vivy Code（TUI 开发面板）**: independent third card — opens
    `vivy tui --demo` (or `--plain`) in a dedicated OS console; **not**
    driven by 一键启动/停止/重启. Source via `VIVY_CODE_ROOT` or sibling
    TUI worktree.
- **打包与版本** — packaging & version management, **deliberately separate
  from the dev loop** (it never starts/stops the backend/frontend): page
  header states the separation; ledger chips (generations / evals /
  releases / installs / events / worktrees) with `vivy-studio.exe` reads, a
  JSON table per ledger, the action form (pack/eval/release/reject/install/
  rollback/inspect inputs), the release human-confirmation checkbox, and a
  live job-output viewer (one concurrent job). Pack speaks the v1 recipe
  contract: a recipe file (`--recipe`, required) plus optional `--source`
  module dirs; the v0 `--with` plugin list is rejected by vivy-sdk.
- **日志** — one structured console for 后端 + 前端: a mono code surface at
  13/14/16px (小/中/大), a fixed `时间 · 级别 · 来源 · 消息` grid, severity
  colour (error red / warn amber / info neutral / debug dimmed) plus a row
  marker, level + source + free-text filters with counts, follow/pause,
  wrap toggle, 复制 (view or single raw line), and click a row to expand its
  raw text, caller, file:line and fields. 清空 clears the view without
  reintroducing old lines.

## Log model (`logs.js`)

The host half reads each stream as a **byte window** and hands it to the pure
module `logs.js`, which is the single place a level, timestamp or caller is
derived (the client never re-infers one). Unit tests:

```text
node --test studio/dsh-vivy-console/logs.test.mjs
```

`GET /vivy-console/api/logs` answers:

```json
{
  "ok": true, "atMs": 0, "mode": "tail", "cursor": "0.0.0.0",
  "reset": false, "omitted": false,
  "lines": [{
    "id": "b:out:42010", "src": "backend", "stream": "out", "kind": "json",
    "level": "info", "ts": 0, "msg": "", "caller": "", "file": "", "line": 0,
    "fields": {}, "text": "…", "partial": false
  }],
  "backend": { "logPath": "…", "errPath": "…", "running": false },
  "frontend": { "logPath": "…", "errPath": "…", "running": false }
}
```

- `cursor` is four byte offsets (`backend.out.backend.err.frontend.out.frontend.err`).
  A poll that sends it back gets `mode:"delta"` and only newly appended records;
  an idle poll returns an empty list. A malformed cursor is ignored (fresh tail).
- `id` is stable per raw line (`<b|f>:<out|err>:<line byte offset>`), so a line
  still being written (`partial:true`, cursor held at its start) returns again
  complete under the same id and the client upserts it.
- `reset` means the file was rotated/truncated (the read restarted as a tail);
  `omitted` means the returned window skips earlier content (tail clipping or a
  backlog larger than the delta cap).
- `kind:"cont"` is a continuation of the previous structured line (indented Go
  stack frames, pnpm/tool error blocks); it inherits that line's level. A plain
  line that does not look like a continuation is its own `text` record with a
  level inferred from wording, ANSI colour (red/amber SGR) and stream (stderr
  counts as at least a warning). ANSI escapes are stripped from `text`.
- Ordering merges all four streams by timestamp; a record without a timestamp
  inherits the last timestamp of its own source, and a source with no
  timestamps at all (today: Vite) sorts after the timestamped records in read
  order.
- The response keeps `lines[].src`/`lines[].text`, so an older client still
  renders the feed; a client that sees no `cursor` falls back to whole-tail
  refresh and labels itself 「主机未重启：整段刷新」.

## Install

Composed into the `vivy-studio` profile by `launch-vivy-studio.ps1`
(dependency + `dsh.profile.bundles` entry), so a normal
`.\launch-vivy-studio.ps1` boots with the console enabled. To apply an
edited source to the installed profile(s): copy every file of this directory
(including `logs.js` — the host half imports it) over
`data/studio-home/profiles/vivy-studio/node_modules/dsh-vivy-console/`
and, when present, the same path under `profiles/vivy-studio-next/`, then
restart Studio (skin-style injection — no hot reload). The client bundle is
served fresh per request (tab changes appear after a browser refresh); the
host-half routes need the restart.

## Requirements

- **Go toolchain** reachable from the Studio process (it compiles the
  headless backend on start; `launch-vivy-studio.ps1` already puts Go on
  `PATH`). Alternatively pin a prebuilt headless binary via the panel EXE
  override or `VIVY_HEADLESS_EXE`.
- `ui/` with `package.json` and installed `node_modules` for the frontend
  dev server (`pnpm dev`).
- `data/studio-home/` is Studio scratch (ST-2).