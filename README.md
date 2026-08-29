# vivy-studio

Independent repository for the **Vivy Studio** shell (DSH profile bundles and
first-party / community plugins).

The host product repository is [`agent-vivy`](https://github.com/ProjectViVy/agent-vivy).
This tree is consumed there as a **git submodule** mounted at `studio/`.

## What lives here

| Path | Role |
|---|---|
| `dsh-vivy-studio/` | First-party skin (Fluorite theme, wordmark, welcome) |
| `dsh-vivy-console/` | First-party console (dev loop + packaging UI host) |
| `dsh-plugin-hub/` | Vivy-maintained fork of DSH Plugin Hub (`dsh-plugin`) |
| `dsh-better-sidebar/` | Community plugin snapshot (source-install) |
| `dsh-context/` | Community plugin snapshot |
| `dsh-cost-meter/` | Community plugin snapshot |
| `dsh-plugin-subscriptions/` | Community plugin snapshot |
| `verify-st1.mjs` / `verify-st2.mjs` | Studio bootstrap checks |

## What does **not** live here

- Species runtime / Journal (`vivy.exe`, `internal/`, `data/vivy.db`)
- Studio lifecycle CLI (`cmd/vivy-studio`, `internal/studiocore`, `vivy-studio.exe`) — stays in `agent-vivy`
- Runtime scratch (`data/studio-home/`) — never commit this

## How the host uses this

From `agent-vivy`:

```text
git submodule update --init --recursive -- studio
# or: just ensure-studio
.\launch-vivy-studio.ps1
```

Profile name: `vivy-studio`. DSH home on the host: `data/studio-home/`.
Engine workspace is the **agent-vivy** root, not this submodule alone.

## Developing inside this repo

```text
# clone standalone
git clone https://github.com/ProjectViVy/vivy-studio.git
# or work via the submodule checkout under agent-vivy/studio

# edit bundles, then from the submodule / this repo:
git add -A && git commit -m "..." && git push
# host repo only bumps the gitlink SHA:
cd <agent-vivy> && git add studio && git commit -m "chore(studio): bump vivy-studio"
```

## Community plugins and dirty trees

Installing plugins through the Vivy-source path writes under `studio/<slug>/`
(this repository's working tree when mounted as a submodule). That dirties the
submodule; do **not** auto-commit install noise into `main` unless you intend
to pin that plugin snapshot.

## License

MIT for first-party bundles. Community plugin trees retain their upstream
licenses (see each package's `LICENSE`).
