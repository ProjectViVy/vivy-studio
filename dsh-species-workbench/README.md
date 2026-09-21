# dsh-species-workbench

First-party **Vivy Studio 物种工作台** bundle: species management from
inside the Studio UI, registered in the conversation view ring beside the
console (id `species-workbench`, order 40). A species is a compiled, sealed
`Generation` body — there is no runtime form hot-swap (face-pack §11). This
plugin therefore does three honest things:

1. **当前形态** — read-only `species/inspect` over the live backend's `/rpc`
   WebSocket control plane (GET `/rpc/bootstrap` → `ws://…/rpc?token=…` →
   one JSON frame per message). NG-23: the species side is never written
   from here; `promotions/promote` and `evals/start` are never called.
2. **候选与生命周期** — the Studio ledger (`vivy-studio.exe list …`) with a
   per-candidate next-step chip (`缺评测 → 缺发布 → 缺安装 → 已安装`) and
   the pack/eval/release/reject/install/rollback chain driven through
   `vivy-studio.exe` on the pinned worktree. Release/install/rollback
   require an explicit UI confirmation and only then forward
   `--actor human --yes` (NG-25, enforced in `jobs.js` before any spawn).
   A switch lands on the **next launch** of the daily location.
3. **Recipe 编辑器** — draft recipes in Studio scratch
   (`data/studio-home/species-workbench/recipes/`), repo recipes read-only
   via 「复制为草稿」. Structural validation is advisory; the authoritative
   check is `vivy-sdk pack` itself (strict validate runs a real pack into a
   throwaway dir). Promoting a draft into `recipes/` is a human copy — the
   repository stays under review, not the editor.

Pack speaks the v1 contract only: `--recipe <file.vivy.yml>` (required),
optional `--source <module-dir>`, `--out <fresh dir>`. The v0 `--with`
plugin list is rejected by the sdk; the recipe is the sole selection
authority.

## Host half (`index.js`)

Node plugin on the Studio `webServer`, all routes under
`/dsh-species-workbench/api`:

| Route | Purpose |
| --- | --- |
| `GET /state` | worktree root, scratch dir, resolved `vivy-studio.exe`, backend addr, WS availability |
| `GET /species?addr=` · `POST /species/probe` | read-only species inspect (`species.js`) |
| `GET /ledger?kind=` | `generations/evals/releases/installs/events/worktrees` via `vivy-studio.exe list` / `workspace list` |
| `GET /catalog` | repo `recipes/*.vivy.yml` + drafts + `plugins/`/`faces/` module dirs (anything with `vivy-module.yaml`) |
| `GET /repo-recipes/<name>` | read-only repo recipe text (name allowlisted) |
| `GET\|PUT\|DELETE /recipes/<name>` | draft CRUD, scratch dir only, name-allowlisted |
| `POST /recipes/<name>/validate` | structural (`recipe.js`); `{strict:true}` starts a real pack job into a throwaway dir |
| `POST /jobs` · `GET /jobs/<id>` | lifecycle jobs, one concurrent, streamed output tail (500 lines) |

The browser sends recipe **names**, never paths: `resolveRecipeArg` expands
a bare name to the draft dir, `recipes/<name>` to the repo, and accepts
only absolute paths already inside the draft dir (issued by strict
validate). Everything else is refused before `vivy-studio.exe` sees it.

## Client half (`client.js`)

Hand-authored module in the client-modules handoff format
(`window.__ModuleLoader__.load({id, factory})`), no build step. Tabs:
当前形态 / 候选与生命周期 / Recipe 编辑器. Job output streams through a 1s
poll viewer; the pack button warns it is a minutes-scale `go build`.

## Air gap and limits (ST-2)

Reads the ledger; writes only under `data/studio-home/species-workbench/`.
`data/vivy.db`, `data/demo/`, `data/workspaces/` are the tenant Journal and
are never touched. No generated Assembly is hand-edited. `recipe.js` is a
structural aid, deliberately **not** a second schema authority.

## Tests

```text
node --test studio/dsh-species-workbench/recipe.test.mjs \
            studio/dsh-species-workbench/species.test.mjs \
            studio/dsh-species-workbench/confirm.test.mjs
```

`confirm.test.mjs` pins the NG-25 gate (no argv without confirm, no
`--with` ever) and the pack path allowlist; `species.test.mjs` runs the
inspect handshake against fake fetch/WebSocket.

## Install

`launch-vivy-studio.ps1` composes this bundle into the `vivy-studio`
profile (dependency + `dsh.profile.bundles` entry). To apply an edited
source before the next launch-script run: copy this directory over
`data/studio-home/profiles/vivy-studio/node_modules/dsh-species-workbench/`
and restart Studio — no hot reload. Requires `vivy-studio.exe` on the
workspace root (or `VIVY_STUDIO`), and a running backend for 当前形态
(`VIVY_BACKEND_ADDR`, default `127.0.0.1:8787`).
