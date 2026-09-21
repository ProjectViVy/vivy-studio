// Vivy Studio 物种工作台 — Client half (installed package bundle entry).
//
// Registers a "物种工作台" tab in the conversation view ring beside the
// console. Three panes, matching the product semantics of a species:
//   * 当前形态 — read-only species/inspect of the live backend
//   * 候选与生命周期 — the Studio ledger with next-step guidance and the
//     human-confirmed eval/release/install/rollback chain (NG-25). A
//     switch lands on the NEXT launch of the daily location; the running
//     process is never hot-swapped.
//   * Recipe 编辑器 — draft recipes in Studio scratch; validation is
//     structural, pack runs the real compiler and is the authority.
//
// Hand-authored module in the client-modules handoff format
// (`window.__ModuleLoader__.load({id, factory})`); no build step.
(() => {
  window.__ModuleLoader__.load({
    id: "dsh-species-workbench",
    factory: (require) => {
      var module = { exports: {} }
      const React = require("react")
      const h = React.createElement
      const { useState, useEffect, useRef, useCallback } = React

      const NS = "dsh-species-workbench"
      const API = "/dsh-species-workbench/api"

      function call(method, path, payload) {
        return fetch(API + path, {
          method: method,
          headers: payload ? { "content-type": "application/json" } : undefined,
          body: payload ? JSON.stringify(payload) : undefined,
          cache: "no-store",
        })
          .then((r) => r.json())
          .catch((err) => ({ ok: false, message: String((err && err.message) || err) }))
      }
      function trunc(value, n) {
        const text = String(value ?? "")
        return text.length > n ? text.slice(0, n) + "…" : text
      }
      function row(key, value) {
        return h("div", { className: "wb-row" }, [
          h("span", { className: "wb-key" }, key),
          h("span", { className: "wb-val" }, value ?? "—"),
        ])
      }

      let PRIMITIVES = null
      try {
        PRIMITIVES = require("@deepseek-ai/dsh-client-ui-primitives")
      } catch (err) {
        PRIMITIVES = null
      }
      const HAS_PRIMITIVES = !!(PRIMITIVES && PRIMITIVES.Button && PRIMITIVES.Pill && PRIMITIVES.Input)
      function Chip({ active, onClick, title, children }) {
        if (HAS_PRIMITIVES) return h(PRIMITIVES.Pill, { active: !!active, onClick, title }, children)
        return h("button", { className: "wb-chip" + (active ? " on" : ""), onClick, title }, children)
      }
      function Btn({ onClick, disabled, title, children }) {
        if (HAS_PRIMITIVES) return h(PRIMITIVES.Button, { size: "sm", variant: "ghost", onClick, disabled: !!disabled, title }, children)
        return h("button", { className: "wb-btn", onClick, disabled: !!disabled, title }, children)
      }
      function Field({ label, value, onChange, placeholder }) {
        if (HAS_PRIMITIVES) return h("label", { className: "wb-field" }, [h("span", { className: "wb-key" }, label), h(PRIMITIVES.Input, { value, onChange, placeholder, "aria-label": label })])
        return h("label", { className: "wb-field" }, [
          h("span", { className: "wb-key" }, label),
          h("input", { className: "wb-input", value, onChange: (e) => onChange(e.target.value), placeholder, "aria-label": label }),
        ])
      }

      if (!document.getElementById("dsh-species-workbench-style")) {
        const style = document.createElement("style")
        style.id = "dsh-species-workbench-style"
        style.textContent = [
          ".wb-root{display:flex;flex-direction:column;gap:10px;height:100%;overflow:auto;padding:10px;font-size:13px}",
          ".wb-tabs{display:flex;gap:6px;flex:none}",
          ".wb-tab{padding:4px 10px;border:1px solid #8884;border-radius:8px;background:transparent;cursor:pointer;font:inherit}",
          ".wb-tab.on{background:#8882;font-weight:600}",
          ".wb-card{border:1px solid #8883;border-radius:10px;padding:10px;display:flex;flex-direction:column;gap:6px}",
          ".wb-card-title{font-weight:600}",
          ".wb-row{display:flex;gap:8px;align-items:baseline}",
          ".wb-key{opacity:.65;min-width:120px;flex:none}",
          ".wb-val{word-break:break-all}",
          ".wb-chip{padding:2px 9px;border:1px solid #8884;border-radius:999px;background:transparent;cursor:pointer;font:inherit}",
          ".wb-chip.on{background:#8883;font-weight:600}",
          ".wb-btn{padding:2px 10px;border:1px solid #8884;border-radius:8px;background:transparent;cursor:pointer;font:inherit}",
          ".wb-input{font:inherit;padding:2px 6px;border:1px solid #8884;border-radius:6px;background:transparent;color:inherit}",
          ".wb-field{display:flex;gap:6px;align-items:center}",
          ".wb-msg{opacity:.8}",
          ".wb-err{color:#e5484d}",
          ".wb-ok{color:#30a46c}",
          ".wb-pre{font-family:ui-monospace,monospace;font-size:12px;white-space:pre-wrap;max-height:260px;overflow:auto;background:#0002;border-radius:8px;padding:6px}",
          ".wb-table{width:100%;border-collapse:collapse;font-size:12px}",
          ".wb-table th,.wb-table td{border-bottom:1px solid #8882;text-align:left;padding:2px 6px;word-break:break-all}",
          ".wb-area{width:100%;min-height:220px;font-family:ui-monospace,monospace;font-size:12px;background:transparent;color:inherit;border:1px solid #8884;border-radius:8px;padding:6px;box-sizing:border-box}",
          ".wb-hint{font-size:12px;opacity:.75}",
        ].join("\n")
        document.head.appendChild(style)
      }

      // ---- 当前形态 (read-only species/inspect) ----

      function SpeciesPane({ state }) {
        const [addr, setAddr] = useState(state ? state.backend : "")
        const [data, setData] = useState(null)
        const [busy, setBusy] = useState(false)
        const probe = useCallback(() => {
          setBusy(true)
          call("POST", "/species/probe", { addr }).then((r) => {
            setBusy(false)
            setData(r)
          })
        }, [addr])
        useEffect(() => {
          probe()
        }, [probe])
        if (!state || !state.ws) {
          return h("div", { className: "wb-card" }, [
            h("div", { className: "wb-card-title" }, "当前形态"),
            h("div", { className: "wb-msg wb-err" }, "宿主 Node 无全局 WebSocket，形态卡不可用；其余功能不受影响。"),
          ])
        }
        const rep = data && data.report
        return h("div", { className: "wb-card" }, [
          h("div", { className: "wb-card-title" }, "当前形态（只读，来自运行中的后端 /rpc）"),
          h("div", { style: { display: "flex", gap: 6, alignItems: "center" } }, [
            h(Field, { label: "后端地址", value: addr, onChange: setAddr, placeholder: "127.0.0.1:8787" }),
            h(Btn, { onClick: probe, disabled: busy }, busy ? "探测中…" : "⟳ 探测"),
          ]),
          !data ? h("div", { className: "wb-msg" }, "读取中…") : null,
          data && !data.ok ? h("div", { className: "wb-msg wb-err" }, data.message || "后端不可达") : null,
          rep
            ? h("div", null, [
                row("Generation", rep.generation_id),
                row("Binary", rep.binary_id),
                row("Artifact sha256", trunc(rep.artifact_sha256, 64)),
                row("UI sha256", trunc(rep.ui_artifact_sha256, 64)),
                row("协议", rep.protocol_version),
                row("策略", `${rep.policy_profile} · ${trunc(rep.policy_hash, 16)}`),
                row("Recipe", rep.recipe && (rep.recipe.face || rep.recipe.loop) ? JSON.stringify(rep.recipe) : "（v1：见账本 Recipe）"),
                row("Grants", (rep.grants || []).join(", ") || "—"),
                row("Tools", `${(rep.tools || []).length} 个：` + (rep.tools || []).map((t) => t.id || t.name || t).slice(0, 12).join(", ")),
              ])
            : null,
          h("div", { className: "wb-hint" }, "物种 = 编译密封的 Generation 身体；运行时不可换形态（face-pack §11），切换在「候选与生命周期」里完成，下次启动生效。"),
        ])
      }

      // ---- 候选与生命周期 ----

      function deriveSteps(generations, evals, releases, installs) {
        return (generations || []).map((gen) => {
          const evaluated = (evals || []).some((e) => e.CandidateID === gen.ID || e.candidateID === gen.ID || e.candidate_id === gen.ID)
          const release = (releases || []).find((r) => (r.GenerationID || r.generationID || r.generation_id) === gen.ID)
          const installed = !!release && (installs || []).some((i) => (i.ReleaseID || i.releaseID || i.release_id) === (release.ID || release.id))
          let next = "已安装"
          if (!evaluated) next = "缺评测 eval"
          else if (!release) next = "缺发布 release"
          else if (!installed) next = "缺安装 install"
          return { gen, evaluated, release, installed, next }
        })
      }

      function LifecyclePane({ job, setJob }) {
        const [ledger, setLedger] = useState({ kind: "generations", data: null, err: "" })
        const [steps, setSteps] = useState(null)
        const [form, setForm] = useState({ candidate: "", baseline: "", suite: "", generation: "", eval: "", release: "", target: "", confirm: false })
        const set = (k, v) => setForm((f) => ({ ...f, [k]: v }))
        const KINDS = ["generations", "evals", "releases", "installs", "events", "worktrees"]

        const refresh = useCallback(() => {
          call("GET", "/ledger?kind=" + ledger.kind).then((r) => {
            setLedger((l) => ({ ...l, data: r.ok ? r.value : null, err: r.ok ? "" : r.message || "读取失败" }))
          })
        }, [ledger.kind])
        useEffect(() => {
          refresh()
        }, [refresh])
        useEffect(() => {
          Promise.all([
            call("GET", "/ledger?kind=generations"),
            call("GET", "/ledger?kind=evals"),
            call("GET", "/ledger?kind=releases"),
            call("GET", "/ledger?kind=installs"),
          ]).then(([g, e, r, i]) => {
            if (g.ok && e.ok && r.ok && i.ok) setSteps(deriveSteps(g.value, e.value, r.value, i.value))
          })
        }, [job ? job.id + job.status : ""])

        function run(action, extra) {
          const body = { action, ...form, ...(extra || {}) }
          call("POST", "/jobs", body).then((res) => {
            if (res.ok) setJob({ id: res.id, action, status: "running", output: [] })
            else setLedger((l) => ({ ...l, err: res.message || "任务启动失败" }))
          })
        }

        const rows = Array.isArray(ledger.data) ? ledger.data : ledger.data && Array.isArray(ledger.data.worktrees) ? ledger.data.worktrees : []
        const columns = []
        for (const r of rows) if (r && typeof r === "object") for (const k of Object.keys(r)) if (!columns.includes(k)) columns.push(k)

        return h("div", { className: "wb-card" }, [
          h("div", { className: "wb-card-title" }, "候选物种（Studio 账本）与生命周期"),
          h("div", { className: "wb-hint" }, "切换 = 换下次启动的 EXE 身体，绝不热换运行进程；release / install / rollback 必须由人确认（NG-25）。"),
          steps && steps.length
            ? h("div", { style: { display: "flex", gap: 6, flexWrap: "wrap" } }, steps.map((s) =>
                h(Chip, { key: s.gen.ID || s.gen.id, active: form.candidate === (s.gen.ID || s.gen.id), onClick: () => { set("candidate", s.gen.ID || s.gen.id); set("generation", s.gen.ID || s.gen.id) }, title: s.gen.ArtifactSHA256 || s.gen.artifact_sha256 || "" },
                  `${trunc(s.gen.ID || s.gen.id, 18)} · ${s.next}`),
              ))
            : h("div", { className: "wb-msg" }, "账本为空：先在「Recipe 编辑器」打包一个候选。"),
          h("div", { style: { display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" } }, [
            h(Field, { label: "候选/Generation", value: form.generation || form.candidate, onChange: (v) => { set("generation", v); set("candidate", v) }, placeholder: "gen_…" }),
            h(Btn, { onClick: () => run("eval", { candidate: form.candidate }) }, "评测 eval"),
            h(Btn, { onClick: () => run("release") }, "发布 release"),
            h(Btn, { onClick: () => run("reject") }, "拒绝 reject"),
          ]),
          h("div", { style: { display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" } }, [
            h(Field, { label: "Release", value: form.release, onChange: (v) => set("release", v), placeholder: "rel_…" }),
            h(Field, { label: "安装位(默认 VIVY_INSTALL_DIR)", value: form.target, onChange: (v) => set("target", v), placeholder: "留空用默认" }),
            h("label", { className: "wb-field" }, [
              h("input", { type: "checkbox", checked: form.confirm, onChange: (e) => set("confirm", e.target.checked) }),
              h("span", { className: "wb-key" }, "我已确认（切换下次启动的身体）"),
            ]),
            h(Btn, { onClick: () => run("install") }, "安装 install"),
            h(Btn, { onClick: () => run("rollback") }, "回滚 rollback"),
          ]),
          h("div", { style: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" } }, [
            h("span", { className: "wb-key" }, "账本"),
            ...KINDS.map((k) => h(Chip, { key: k, active: k === ledger.kind, onClick: () => setLedger((l) => ({ ...l, kind: k })) }, k)),
            h(Btn, { onClick: refresh }, "⟳ 刷新"),
          ]),
          ledger.err ? h("div", { className: "wb-msg wb-err" }, ledger.err) : null,
          columns.length
            ? h("table", { className: "wb-table" }, [
                h("thead", null, h("tr", null, columns.map((c) => h("th", { key: c }, c)))),
                h("tbody", null, rows.slice(0, 200).map((r, i) => h("tr", { key: i }, columns.map((c) => h("td", { key: c }, trunc(typeof r[c] === "object" ? JSON.stringify(r[c]) : r[c], 90)))))),
              ])
            : null,
          job ? h(JobView, { job, setJob }) : null,
        ])
      }

      function JobView({ job, setJob }) {
        const preRef = useRef(null)
        useEffect(() => {
          if (!job || job.status !== "running") return
          const timer = setInterval(() => {
            call("GET", "/jobs/" + encodeURIComponent(job.id)).then((r) => {
              if (r && r.ok) setJob(r.job)
            })
          }, 1000)
          return () => clearInterval(timer)
        }, [job ? job.id : null, job ? job.status : null]) // eslint-disable-line react-hooks/exhaustive-deps
        useEffect(() => {
          if (preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight
        }, [job && job.output ? job.output.length : 0]) // eslint-disable-line react-hooks/exhaustive-deps
        if (!job) return null
        const badge = job.status === "running" ? "运行中" : job.status === "ok" ? "完成" : "失败"
        return h("div", null, [
          h("div", { className: "wb-row" }, [
            h("span", { className: "wb-key" }, `任务 ${job.action} (${job.id})`),
            h("span", { className: "wb-val " + (job.status === "ok" ? "wb-ok" : job.status === "failed" ? "wb-err" : "") }, badge),
          ]),
          h("pre", { ref: preRef, className: "wb-pre" }, (job.output || []).join("\n")),
        ])
      }

      // ---- Recipe 编辑器 ----

      const DEFAULT_RECIPE = `apiVersion: vivy.generation/v1
profile: my-body
modules:
  - vivy/loop
  - vivy/model
  - vivy/storage
  - vivy/checkpoint
  - vivy/credential
  - vivy/sandbox
  - vivy/tool-host
`

      function RecipePane({ job, setJob }) {
        const [catalog, setCatalog] = useState(null)
        const [name, setName] = useState("")
        const [text, setText] = useState(DEFAULT_RECIPE)
        const [msg, setMsg] = useState("")
        const [errs, setErrs] = useState([])
        const refresh = useCallback(() => call("GET", "/catalog").then((r) => r.ok && setCatalog(r)), [])
        useEffect(() => {
          refresh()
        }, [refresh])

        function save() {
          if (!name.trim()) return setMsg("先填草稿文件名（如 my-body.vivy.yml）")
          call("PUT", "/recipes/" + encodeURIComponent(name.trim()), { text }).then((r) => {
            setMsg(r.ok ? "已存到 " + r.path : r.message || "保存失败")
            if (r.ok) refresh()
          })
        }
        function load(draftName) {
          call("GET", "/recipes/" + encodeURIComponent(draftName)).then((r) => {
            if (r.ok) {
              setName(draftName)
              setText(r.text)
              setErrs([])
              setMsg("已载入 " + draftName)
            } else {
              setMsg(r.message || "无法读取草稿")
            }
          })
        }
        function copyRepoRecipe(recipeName) {
          call("GET", "/repo-recipes/" + encodeURIComponent(recipeName)).then((r) => {
            if (r.ok) {
              setName(recipeName)
              setText(r.text)
              setErrs([])
              setMsg("已载入 repo 配方 " + recipeName + "，保存后成为草稿")
            } else {
              setMsg(r.message || "读取 repo 配方失败")
            }
          })
        }
        function validate() {
          save2().then((ok) => {
            if (!ok) return
            call("POST", "/recipes/" + encodeURIComponent(name.trim()) + "/validate", {}).then((r) => {
              setErrs(r.errors || [])
              setMsg(r.ok ? "结构校验通过（权威校验在打包）" : "结构问题见下")
            })
          })
        }
        function save2() {
          if (!name.trim()) {
            setMsg("先填草稿文件名")
            return Promise.resolve(false)
          }
          return call("PUT", "/recipes/" + encodeURIComponent(name.trim()), { text }).then((r) => {
            setMsg(r.ok ? "" : r.message || "保存失败")
            return r.ok
          })
        }
        function pack() {
          save2().then((ok) => {
            if (!ok) return
            call("POST", "/jobs", { action: "pack", recipe: name.trim(), source: [] }).then((res) => {
              // host expands the bare draft name to its absolute path.
              if (res.ok) {
                setJob({ id: res.id, action: "pack", status: "running", output: [] })
                setMsg("打包中（分钟级 go build，勿关页）")
              } else setMsg(res.message || "打包启动失败")
            })
          })
        }
        function remove() {
          if (!name.trim() || !window.confirm("删除草稿 " + name + "？")) return
          call("DELETE", "/recipes/" + encodeURIComponent(name.trim())).then((r) => {
            setMsg(r.ok ? "已删除" : r.message || "删除失败")
            if (r.ok) {
              setName("")
              setText(DEFAULT_RECIPE)
              refresh()
            }
          })
        }
        const drafts = catalog ? catalog.recipes.filter((x) => x.origin === "draft") : []
        const repoRecipes = catalog ? catalog.recipes.filter((x) => x.origin === "repo") : []
        return h("div", { className: "wb-card" }, [
          h("div", { className: "wb-card-title" }, "Recipe 编辑器（草稿存 Studio scratch，进 recipes/ 由人复制）"),
          h("div", { style: { display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" } }, [
            h(Field, { label: "草稿名", value: name, onChange: setName, placeholder: "my-body.vivy.yml" }),
            h(Btn, { onClick: save }, "保存"),
            h(Btn, { onClick: validate }, "结构校验"),
            h(Btn, { onClick: pack }, "打包新物种 pack"),
            h(Btn, { onClick: remove }, "删除"),
          ]),
          h("div", { style: { display: "flex", gap: 6, flexWrap: "wrap" } }, [
            ...drafts.map((d) => h(Chip, { key: d.path, active: d.name === name, onClick: () => load(d.name) }, "草稿 " + d.name)),
            ...repoRecipes.map((d) => h(Chip, { key: d.path, onClick: () => copyRepoRecipe(d.name) }, "repo " + d.name + "（复制为草稿）")),
          ]),
          h("textarea", { className: "wb-area", value: text, onChange: (e) => setText(e.target.value), spellCheck: false }),
          errs.length ? h("div", null, errs.map((e, i) => h("div", { key: i, className: "wb-msg wb-err" }, e))) : null,
          msg ? h("div", { className: "wb-msg" }, msg) : null,
          catalog ? h("div", { className: "wb-hint" }, `可选模块 ${catalog.modules.length} 个（plugins/）· faces ${catalog.faces.length} 个 · 表外模块需 recipe sources + --source 双配（SHA256 门禁在 sdk）`) : null,
          job && job.action === "pack" ? h(JobView, { job, setJob }) : null,
        ])
      }

      // ---- shell ----

      function Workbench() {
        const [state, setState] = useState(null)
        const [job, setJob] = useState(null)
        const [section, setSection] = useState("species")
        useEffect(() => {
          call("GET", "/state").then((r) => r && r.ok && setState(r))
        }, [])
        useEffect(() => {
          if (!job || job.status !== "running") return
          const timer = setInterval(() => {
            call("GET", "/jobs/" + encodeURIComponent(job.id)).then((r) => {
              if (r && r.ok) setJob(r.job)
            })
          }, 1000)
          return () => clearInterval(timer)
        }, [job ? job.id : null, job ? job.status : null]) // eslint-disable-line react-hooks/exhaustive-deps
        const SECTIONS = [
          ["species", "当前形态"],
          ["lifecycle", "候选与生命周期"],
          ["recipe", "Recipe 编辑器"],
        ]
        return h("div", { className: "wb-root" }, [
          h("div", { className: "wb-tabs" }, SECTIONS.map(([id, label]) =>
            h("button", { className: "wb-tab" + (id === section ? " on" : ""), key: id, onClick: () => setSection(id) }, label),
          )),
          section === "species" ? h(SpeciesPane, { state }) : null,
          section === "lifecycle" ? h(LifecyclePane, { job, setJob }) : null,
          section === "recipe" ? h(RecipePane, { job, setJob }) : null,
        ])
      }

      // ---- registration ----
      function apply(ctx) {
        ctx.slots.inject("conversation.view", () =>
          ctx.slots.register(
            {
              name: "conversation.view",
              id: "species-workbench",
              order: 40,
              label: () => "物种工作台",
            },
            (props) => h(Workbench, props),
          ),
        )
      }

      module.exports = { name: NS, inject: ["slots"], apply }
      return module.exports
    },
  })
})()
