// Vivy Studio console — Client half (installed package bundle entry).
//
// Registers a "Vivy 控制台" tab in the conversation view ring
// (`conversation.view` slot, beside Chat / Trajectory / Context) and renders
// the unified development loop as a **总控台** (main console): one-click
// start/stop/restart for both sides, backend status and frontend status on
// one screen so nothing feels split, plus 日志 — one structured console for
// both processes (level colours, timestamps, source and level filters, row
// detail, follow/pause) fed incrementally by the host half.
//
// The unified model (one dev server only):
//   * backend = pure-API vivy binary (vivy_headless, no embedded frontend),
//     auto-compiled into Studio scratch on start
//   * frontend = the DEV dev server (pnpm dev in ui/, :3015) — the sole app
// Frontend debugging happens in the normal browser at http://127.0.0.1:3015.
//
// Hand-authored module in the client-modules handoff format
// (`window.__ModuleLoader__.load({id, factory})`); the injected `require`
// resolves `react` from the browser module table. No build step.
(() => {
  window.__ModuleLoader__.load({
    id: "dsh-vivy-console",
    factory: (require) => {
      var module = { exports: {} }
      const React = require("react")
      const h = React.createElement
      const { useState, useEffect, useMemo, useRef, useCallback } = React

      const NS = "dsh-vivy-console"
      const API = "/vivy-console/api"

      // ---- tiny helpers ----
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
      function fmtTime(ms) {
        const d = new Date(ms)
        if (isNaN(d.getTime())) return "—"
        return d.toLocaleTimeString("en-GB", { hour12: false })
      }
      function trunc(value, n) {
        const text = String(value ?? "")
        return text.length > n ? text.slice(0, n) + "…" : text
      }
      function row(key, value) {
        return h("div", { className: "vc-row" }, [
          h("span", { className: "vc-key" }, key),
          h("span", { className: "vc-val" }, value),
        ])
      }
      function stateText(running, managed, listening) {
        if (running) return "运行中 " + (managed ? "(本控制台管理)" : "(外部进程)")
        if (listening) return "已停止（端口仍被监听）"
        return "已停止"
      }

      // ---- shared controls ----
      // The DSH shell seeds the browser module table with its UI primitives
      // (PLATFORM_MODULES), so the console toolbar uses the same controls as the
      // rest of Studio. A shell that cannot resolve them falls back to this
      // plugin's own .vc-chip / .vc-btn / .vc-input markup.
      let PRIMITIVES = null
      try {
        PRIMITIVES = require("@deepseek-ai/dsh-client-ui-primitives")
      } catch (err) {
        PRIMITIVES = null
      }
      const HAS_PRIMITIVES = !!(PRIMITIVES && PRIMITIVES.Button && PRIMITIVES.Pill && PRIMITIVES.Input)
      function Chip({ active, onClick, title, children }) {
        if (HAS_PRIMITIVES) {
          return h(PRIMITIVES.Pill, { active: !!active, onClick: onClick, title: title }, children)
        }
        return h("button", { className: "vc-chip" + (active ? " on" : ""), onClick: onClick, title: title }, children)
      }
      function Btn({ onClick, disabled, title, children }) {
        if (HAS_PRIMITIVES) {
          return h(
            PRIMITIVES.Button,
            { size: "sm", variant: "ghost", onClick: onClick, disabled: !!disabled, title: title },
            children,
          )
        }
        return h("button", { className: "vc-btn", onClick: onClick, disabled: !!disabled, title: title }, children)
      }
      function SearchBox({ value, onChange, placeholder }) {
        if (HAS_PRIMITIVES) {
          return h(PRIMITIVES.Input, {
            value: value,
            onChange: onChange,
            placeholder: placeholder,
            "aria-label": placeholder,
          })
        }
        return h("input", {
          className: "vc-input",
          value: value,
          onChange: onChange,
          placeholder: placeholder,
          "aria-label": placeholder,
        })
      }
      function copyText(text) {
        try {
          if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).catch(() => {})
            return true
          }
        } catch (err) {
          /* clipboard unavailable (non-secure context) */
        }
        return false
      }

      // ---- styles ----
      if (!document.getElementById("dsh-vivy-console-style")) {
        const style = document.createElement("style")
        style.id = "dsh-vivy-console-style"
        style.textContent = [
          ".vc-root{box-sizing:border-box;height:100%;display:flex;flex-direction:column;",
          "color:var(--dsw-alias-label-primary);font-size:13px;padding:12px 16px;overflow:hidden}",
          ".vc-tabs{display:flex;gap:6px;flex:none;margin-bottom:10px;border-bottom:1px solid var(--dsw-alias-border-l1);padding-bottom:8px}",
          ".vc-tab{background:transparent;border:1px solid transparent;border-radius:8px;padding:4px 12px;",
          "color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:13px;white-space:nowrap}",
          ".vc-tab.on{background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}",
          ".vc-pane{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:8px}",
          ".vc-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px}",
          ".vc-card-title{font-size:12px;font-weight:600;margin-bottom:6px;color:var(--dsw-alias-label-secondary)}",
          ".vc-row{display:flex;gap:6px;padding:2px 0;font-size:12px}",
          ".vc-key{color:var(--dsw-alias-label-secondary);min-width:84px;flex:none}",
          ".vc-val{word-break:break-all}",
          ".vc-btn{height:28px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;",
          "background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer;font-size:12px;white-space:nowrap}",
          ".vc-btn:disabled{opacity:.45;cursor:default}",
          ".vc-btn.primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}",
          ".vc-btn.danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}",
          ".vc-msg{min-height:16px;color:var(--dsw-alias-label-secondary);font-size:12px;white-space:pre-wrap;word-break:break-all}",
          ".vc-input{height:28px;padding:0 8px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);",
          "border-radius:6px;color:var(--dsw-alias-label-primary);font-size:12px;box-sizing:border-box}",
          ".vc-pre{flex:1;min-height:120px;max-height:40vh;overflow:auto;margin:0;padding:8px 10px;",
          "background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;",
          "font-family:var(--ds-font-family-code);font-size:var(--dsw-font-xs-13-font-size,13px);line-height:var(--dsw-font-xs-13-line-height,20px);white-space:pre-wrap;word-break:break-all}",
          // 日志 面板：唯一时间线控制台。字号角色沿用 dsh 文本 Token
          // （13/14/16），级别颜色只使用语义状态色，行内其余文字保持中性。
          ".vc-logs{flex:1;min-height:0;display:flex;flex-direction:column;gap:8px}",
          ".vc-logs-bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;flex:none}",
          ".vc-logs-status{display:flex;gap:10px;align-items:center;flex-wrap:wrap;flex:none;",
          "font-size:12px;color:var(--dsw-alias-label-tertiary)}",
          ".vc-log-label{color:var(--dsw-alias-label-tertiary);font-size:12px;flex:none}",
          ".vc-log-search{flex:1;min-width:180px;display:flex;align-items:center}",
          ".vc-log-search>*{flex:1;min-width:0}",
          ".vc-log-body{flex:1;min-height:180px;overflow:auto;margin:0;padding:6px 8px;",
          "background:var(--dsw-alias-markdown-code-block);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;",
          "font-family:var(--ds-font-family-code);--vc-log-size:var(--dsw-font-s-14-font-size,14px);",
          "--vc-log-lh:var(--dsw-font-s-14-line-height,22px);font-size:var(--vc-log-size);line-height:var(--vc-log-lh);",
          "color:var(--dsw-alias-label-primary)}",
          ".vc-log-body[data-size=\"s\"]{--vc-log-size:var(--dsw-font-xs-13-font-size,13px);--vc-log-lh:var(--dsw-font-xs-13-line-height,20px)}",
          ".vc-log-body[data-size=\"l\"]{--vc-log-size:var(--dsw-font-base-16-font-size,16px);--vc-log-lh:var(--dsw-font-base-16-line-height,24px)}",
          ".vc-log-line{display:grid;grid-template-columns:92px 58px 50px minmax(0,1fr);gap:8px;align-items:start;",
          "padding:1px 6px;border-left:2px solid transparent;border-radius:4px}",
          ".vc-log-line:hover{background:var(--dsw-alias-interactive-bg-hover)}",
          ".vc-log-line[data-open=\"on\"]{background:var(--dsw-alias-bg-module-platform)}",
          ".vc-log-line[data-level=\"error\"]{border-left-color:var(--dsw-alias-state-error-primary)}",
          ".vc-log-line[data-level=\"warn\"]{border-left-color:var(--dsw-alias-state-warn-primary)}",
          ".vc-log-time{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap}",
          ".vc-log-level{font-weight:600;letter-spacing:.02em;white-space:nowrap}",
          ".vc-log-line[data-level=\"info\"] .vc-log-level{color:var(--dsw-alias-label-tertiary)}",
          ".vc-log-line[data-level=\"debug\"] .vc-log-level{color:var(--dsw-alias-label-dimmed)}",
          ".vc-log-line[data-level=\"warn\"] .vc-log-level{color:var(--dsw-alias-state-warn-primary)}",
          ".vc-log-line[data-level=\"error\"] .vc-log-level{color:var(--dsw-alias-state-error-primary)}",
          ".vc-log-src{color:var(--dsw-alias-label-secondary);white-space:nowrap}",
          ".vc-log-src::before{content:\"\";display:inline-block;width:6px;height:6px;margin-right:5px;border-radius:2px;",
          "background:var(--dsw-alias-label-dimmed);vertical-align:1px}",
          ".vc-log-src[data-src=\"backend\"]::before{background:var(--dsw-alias-state-business-primary)}",
          ".vc-log-msg{min-width:0;background:none;border:0;padding:0;font:inherit;text-align:left;cursor:pointer;",
          "color:var(--dsw-alias-label-primary);white-space:pre}",
          ".vc-log-msg:focus-visible{outline:1px solid var(--dsw-alias-brand-primary);outline-offset:2px;border-radius:3px}",
          ".vc-log-body[data-wrap=\"on\"] .vc-log-msg{white-space:pre-wrap;overflow-wrap:anywhere}",
          ".vc-log-line[data-level=\"debug\"] .vc-log-msg,.vc-log-kind-cont .vc-log-msg{color:var(--dsw-alias-label-secondary)}",
          ".vc-log-field-key{color:var(--dsw-alias-label-tertiary)}",
          ".vc-log-field-val{color:var(--dsw-alias-label-secondary);white-space:pre}",
          ".vc-log-field-val[data-key=\"err\"]{color:var(--dsw-alias-state-error-primary)}",
          ".vc-log-detail{grid-column:1/-1;margin:2px 0 6px;padding:6px 8px;background:var(--dsw-alias-bg-base);",
          "border:1px solid var(--dsw-alias-border-l1);border-radius:6px;display:flex;flex-direction:column;gap:6px}",
          ".vc-log-detail-head{display:flex;gap:10px;align-items:center;flex-wrap:wrap;color:var(--dsw-alias-label-tertiary);font-size:12px}",
          ".vc-log-detail-text{margin:0;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-primary)}",
          ".vc-log-empty{color:var(--dsw-alias-label-tertiary);font-size:12px;padding:10px 4px;display:flex;",
          "flex-direction:column;gap:6px;align-items:flex-start}",
          ".vc-log-error{color:var(--dsw-alias-state-error-primary)}",
          ".vc-chip{background:none;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:1px 10px;",
          "color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:11px}",
          ".vc-chip.on{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}",
          ".vc-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:6px}",
          ".vc-field{display:flex;flex-direction:column;gap:2px;font-size:11px;color:var(--dsw-alias-label-secondary)}",
          ".vc-tbl{width:100%;border-collapse:collapse;font-size:12px}",
          ".vc-tbl th,.vc-tbl td{border:1px solid var(--dsw-alias-border-l1);padding:4px 6px;text-align:left;vertical-align:top}",
          ".vc-tbl th{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-weight:600;position:sticky;top:0}",
          ".vc-empty{color:var(--dsw-alias-label-tertiary);font-size:12px;padding:8px 2px}",
        ].join("")
        document.head.appendChild(style)
      }

      // ---- 总控台 (main console) ----
      function OverviewPane({ status }) {
        const [busy, setBusy] = useState("")
        const [msg, setMsg] = useState("")
        const [exe, setExe] = useState("")
        useEffect(() => {
          if (!exe && status && status.exe) setExe(status.exe)
        }, [status && status.exe]) // eslint-disable-line react-hooks/exhaustive-deps

        const bk = !!(status && status.running)
        const fe = !!(status && status.frontend && status.frontend.running)
        const allRunning = bk && fe
        const overall = allRunning
          ? "全部运行中"
          : bk
            ? "后端运行中 · 前端未运行"
            : fe
              ? "前端运行中 · 后端未运行"
              : "未运行"

        function runAction(label, fn) {
          setBusy(label)
          setMsg("")
          Promise.resolve(fn()).then((text) => {
            setMsg(text || label + " 完成")
            setBusy("")
          })
        }
        function act(prefix, name, label) {
          runAction(label, () =>
            call("POST", "/" + prefix + name).then((r) => (r && r.message) || label + " 完成"),
          )
        }

        function startAll() {
          runAction("一键启动", async () => {
            const b = await call("POST", "/start")
            if (b && b.ok) {
              const f = await call("POST", "/frontend/start")
              return f && f.ok ? "一键启动完成：后端 + 前端均已启动" : "后端已启动；前端启动失败：" + ((f && f.message) || "")
            }
            if (b && !b.ok && (b.message || "").indexOf("已在运行") >= 0) {
              const f = await call("POST", "/frontend/start")
              return f && f.ok ? "后端已在运行；前端已启动" : "后端已在运行；前端启动失败：" + ((f && f.message) || "")
            }
            return "一键启动失败（后端）：" + ((b && b.message) || "")
          })
        }
        function stopAll() {
          runAction("一键停止", async () => {
            const f = await call("POST", "/frontend/stop")
            const b = await call("POST", "/stop")
            return [
              f && f.ok ? "前端已停止" : (f && f.message) || "前端停止失败",
              b && b.ok ? "后端已停止" : (b && b.message) || "后端停止失败",
            ].join("；")
          })
        }
        function restartAll() {
          runAction("一键重启", async () => {
            await call("POST", "/stop")
            await call("POST", "/frontend/stop")
            const b = await call("POST", "/start")
            if (!(b && b.ok)) return "一键重启失败（后端）：" + ((b && b.message) || "")
            const f = await call("POST", "/frontend/start")
            return f && f.ok
              ? "一键重启完成：后端 + 前端均重新启动"
              : "后端已重启；前端启动失败：" + ((f && f.message) || "")
          })
        }
        function applyExe() {
          call("POST", "/setExe", { path: exe }).then((r) => {
            setMsg((r && r.ok && "已应用 EXE 路径") || "设置失败")
          })
        }

        const feStatus = (status && status.frontend) || {}
        // Host may lag the client after a profile sync (no Studio kill): if
        // status has no `code` block yet, still show the card with copyable
        // commands so the panel is usable without restarting Studio.
        const codeHost = !!(status && status.code)
        const code = (status && status.code) || {
          ready: false,
          root: "",
          command: "go run ./cmd/vivy tui --demo",
          note: "host 路由尚未加载（需日后重启 Studio 一次）；可先复制命令在独立终端运行",
        }
        function openCode(mode) {
          const label = mode === "plain" ? "打开 Code plain" : "打开 Code"
          runAction(label, () =>
            call("POST", "/code/open", { mode: mode || "demo" }).then((r) => {
              if (r && r.ok) return r.message || "已打开"
              // 404 / missing route → fall back to clipboard so the operator
              // is never blocked on a Studio restart.
              const cmd =
                mode === "plain"
                  ? "cd ..\\agent-vivy-tui-crush; go run ./cmd/vivy tui --plain"
                  : "cd ..\\agent-vivy-tui-crush; go run ./cmd/vivy tui --demo"
              if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(cmd).catch(() => {})
              }
              return (
                ((r && r.message) || "host 尚未提供 /code/open") +
                "\n已复制命令（请在独立终端运行，勿与前后端混用）：\n" +
                cmd
              )
            }),
          )
        }
        const cards = [
          h("div", { className: "vc-card", style: { flex: "1 1 260px", minWidth: 260 } }, [
            h("div", { className: "vc-card-title" }, "后端状态"),
            row("状态", stateText(bk, !!(status && status.managed), !!(status && status.listening))),
            row("PID", String((status && status.pid) || "—")),
            row("监听", String((status && status.addr) || "—") + "（/rpc 控制面）"),
            row("启动于", status && status.startedAtMs ? fmtTime(status.startedAtMs) : "—"),
            row("EXE", trunc((status && status.exe) || "…", 100)),
            row("形态", "纯 API（vivy_headless，无内嵌前端）"),
            row("编译", (status && status.autoBuild) === false ? "指定 EXE，不自动编译" : "go build -tags vivy_headless（每次启动增量编译）"),
            h("div", { style: { display: "flex", gap: 8, marginTop: 8 } }, [
              h("button", { className: "vc-btn", disabled: !!busy, onClick: () => act("", "start", "后端启动") }, busy === "后端启动" ? "启动中…" : "▶ 启动"),
              h("button", { className: "vc-btn", disabled: !!busy, onClick: () => act("", "stop", "后端停止") }, busy === "后端停止" ? "停止中…" : "■ 停止"),
              h("button", { className: "vc-btn", disabled: !!busy, onClick: () => act("", "restart", "后端重启") }, busy === "后端重启" ? "重启中…" : "⟳ 重启"),
            ]),
            h("div", { style: { display: "flex", gap: 8, marginTop: 8 } }, [
              h("input", { className: "vc-input", style: { flex: 1 }, value: exe, placeholder: "后端 EXE 路径（留空自动编译 vivy_headless）", onChange: (e) => setExe(e.target.value) }),
              h("button", { className: "vc-btn", onClick: applyExe }, "应用 EXE"),
            ]),
          ]),
          h("div", { className: "vc-card", style: { flex: "1 1 260px", minWidth: 260 } }, [
            h("div", { className: "vc-card-title" }, "前端状态"),
            row("状态", stateText(fe, !!(feStatus && feStatus.managed), !!(feStatus && feStatus.listening))),
            row("PID", String((feStatus && feStatus.pid) || "—")),
            row("入口", String((feStatus && feStatus.addr) || "127.0.0.1:3015") + "（Vite DEV 开发服务器，唯一前端）"),
            row("启动于", feStatus && feStatus.startedAtMs ? fmtTime(feStatus.startedAtMs) : "—"),
            row("命令", String((feStatus && feStatus.command) || "pnpm dev") + " @ " + trunc((feStatus && feStatus.cwd) || "…", 100)),
            row("代理", "/rpc → " + String((feStatus && feStatus.rpcTarget) || "…") + "（Vite 代理到纯 API 后端）"),
            h("div", { style: { display: "flex", gap: 8, marginTop: 8 } }, [
              h("button", { className: "vc-btn", disabled: !!busy, onClick: () => act("frontend/", "start", "前端启动") }, busy === "前端启动" ? "启动中…" : "▶ 启动"),
              h("button", { className: "vc-btn", disabled: !!busy, onClick: () => act("frontend/", "stop", "前端停止") }, busy === "前端停止" ? "停止中…" : "■ 停止"),
              h("button", { className: "vc-btn", disabled: !!busy, onClick: () => act("frontend/", "restart", "前端重启") }, busy === "前端重启" ? "重启中…" : "⟳ 重启"),
              h("button", { className: "vc-btn", disabled: !(feStatus && feStatus.url), onClick: () => window.open(feStatus.url, "vivy-dev") }, "打开 " + String((feStatus && feStatus.addr) || "127.0.0.1:3015")),
            ]),
          ]),
          h("div", { className: "vc-card", style: { flex: "1 1 260px", minWidth: 260 } }, [
            h("div", { className: "vc-card-title" }, "Vivy Code（TUI 开发面板）"),
            row("定位", "独立控制台窗口 · 不并入一键启停 · 不与后端/前端生命周期混淆"),
            row(
              "源码",
              codeHost
                ? code.ready
                  ? trunc(code.root || "…", 100)
                  : "未就绪（缺 internal/tui 或设置 VIVY_CODE_ROOT）"
                : "host 路由待加载（可复制命令；不杀 Studio）",
            ),
            row("命令", String(code.command || "go run ./cmd/vivy tui --demo")),
            row("上次打开", code.openedAtMs ? fmtTime(code.openedAtMs) + " · " + String(code.mode || "—") : "—"),
            h("div", { style: { display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" } }, [
              h(
                "button",
                {
                  className: "vc-btn primary",
                  disabled: !!busy || (codeHost && !code.ready),
                  onClick: () => openCode("demo"),
                },
                busy === "打开 Code" ? "打开中…" : "◈ 打开 Vivy Code",
              ),
              h(
                "button",
                {
                  className: "vc-btn",
                  disabled: !!busy || (codeHost && !code.ready),
                  onClick: () => openCode("plain"),
                },
                busy === "打开 Code plain" ? "打开中…" : "行式 REPL（--plain）",
              ),
            ]),
            codeHost && !code.ready
              ? h(
                  "div",
                  { className: "vc-msg", style: { marginTop: 8 } },
                  "源码树尚无 TUI（cmd/vivy/tui.go + internal/tui/view）。可把 TUI worktree 放在 ../agent-vivy-tui-crush，或设置环境变量 VIVY_CODE_ROOT。",
                )
              : null,
            !codeHost
              ? h(
                  "div",
                  { className: "vc-msg", style: { marginTop: 8 } },
                  "当前 Studio 进程尚未加载 /code/* host 路由。按钮会尝试打开并在失败时复制命令；不必为了本卡片重启 Studio。",
                )
              : null,
          ]),
        ]

        return h("div", { className: "vc-pane" }, [
          h("div", { className: "vc-card" }, [
            h("div", { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" } }, [
              h("span", { className: "vc-key" }, "总览"),
              h("span", { className: "vc-val", style: { fontWeight: 600 } }, overall),
              h("span", { style: { flex: 1 } }, null),
              h("button", { className: "vc-btn primary", disabled: !!busy || allRunning, onClick: startAll }, busy === "一键启动" ? "启动中…" : "▶ 一键启动"),
              h("button", { className: "vc-btn danger", disabled: !!busy || (!bk && !fe), onClick: stopAll }, busy === "一键停止" ? "停止中…" : "■ 一键停止"),
              h("button", { className: "vc-btn", disabled: !!busy || !bk, onClick: restartAll }, busy === "一键重启" ? "重启中…" : "⟳ 一键重启"),
            ]),
            h(
              "div",
              { className: "vc-msg", style: { marginTop: 6 } },
              "一键启停只管后端 + 前端。Vivy Code 是第三条面：单独打开，不参与上列按钮。",
            ),
            msg ? h("div", { className: "vc-msg", style: { marginTop: 8 } }, msg) : null,
          ]),
          h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-start" } }, cards),
        ])
      }

      // ---- 日志 (unified structured timeline) ----
      // One feed for the kernel backend (slog JSON) and the Vite dev server. The
      // host half parses every line (logs.js) and serves it incrementally through
      // a byte cursor; this pane only filters, colours and follows, so the two
      // halves can never disagree about a level.
      const LOG_VIEW_KEY = "dsh-vivy-console.logs.view"
      const LOG_VIEW_DEFAULTS = { size: "m", wrap: "off" }
      const LOG_SIZE_LABELS = [["s", "小"], ["m", "中"], ["l", "大"]]
      const LOG_LEVEL_FILTERS = [["all", "全部"], ["error", "错误"], ["warn", "警告"], ["info", "信息"], ["debug", "调试"]]
      const LOG_SRC_FILTERS = [["all", "全部"], ["backend", "后端"], ["frontend", "前端"]]
      const LOG_MAX_RECORDS = 1000

      function readLogView() {
        try {
          const parsed = JSON.parse(window.localStorage.getItem(LOG_VIEW_KEY) || "null")
          if (!parsed || typeof parsed !== "object") return Object.assign({}, LOG_VIEW_DEFAULTS)
          return {
            size: LOG_SIZE_LABELS.some((pair) => pair[0] === parsed.size) ? parsed.size : LOG_VIEW_DEFAULTS.size,
            wrap: parsed.wrap === "on" ? "on" : "off",
          }
        } catch (err) {
          return Object.assign({}, LOG_VIEW_DEFAULTS)
        }
      }
      function writeLogView(view) {
        try {
          window.localStorage.setItem(LOG_VIEW_KEY, JSON.stringify(view))
        } catch (err) {
          /* storage unavailable (private mode) */
        }
      }
      function logClock(ms) {
        if (!ms || ms <= 0) return ""
        const d = new Date(ms)
        if (isNaN(d.getTime())) return ""
        const pad = (n, width) => String(n).padStart(width, "0")
        return pad(d.getHours(), 2) + ":" + pad(d.getMinutes(), 2) + ":" + pad(d.getSeconds(), 2) + "." + pad(d.getMilliseconds(), 3)
      }
      function logHaystack(rec) {
        const fields = rec.fields && typeof rec.fields === "object" ? rec.fields : {}
        let text = [rec.msg, rec.caller, rec.file, rec.text, rec.level, rec.src].filter(Boolean).join(" ")
        for (const key of Object.keys(fields)) text += " " + key + "=" + fields[key]
        return text.toLowerCase()
      }
      function logLineText(rec) {
        const fields = rec.fields && typeof rec.fields === "object"
          ? Object.keys(rec.fields).map((key) => key + "=" + rec.fields[key]).join(" ")
          : ""
        return [
          logClock(rec.ts) || "--:--:--.---",
          String(rec.level || "info").toUpperCase(),
          rec.src === "frontend" ? "前端" : "后端",
          rec.msg,
          fields,
        ].filter(Boolean).join(" ")
      }
      // Upsert by record id: a line that was still being written arrives again
      // complete with the same id, and replaces its partial version.
      function mergeLogRecords(previous, incoming) {
        const list = previous.slice()
        const index = new Map()
        list.forEach((rec, at) => index.set(rec.id, at))
        let changed = false
        for (const rec of incoming) {
          const at = index.get(rec.id)
          if (at === undefined) {
            index.set(rec.id, list.length)
            list.push(rec)
          } else {
            list[at] = rec
          }
          changed = true
        }
        return { list: list, changed: changed }
      }

      function LogsPane({ status }) {
        const [view, setView] = useState(readLogView)
        const [records, setRecords] = useState([])
        const [dropped, setDropped] = useState(0)
        const [mode, setMode] = useState("tail")
        const [reset, setReset] = useState(false)
        const [omitted, setOmitted] = useState(false)
        const [legacy, setLegacy] = useState(false)
        const [paths, setPaths] = useState("")
        const [levelFilter, setLevelFilter] = useState("all")
        const [srcFilter, setSrcFilter] = useState("all")
        const [query, setQuery] = useState("")
        const [paused, setPaused] = useState(false)
        const [follow, setFollow] = useState(true)
        const [pending, setPending] = useState(0)
        const [loaded, setLoaded] = useState(false)
        const [error, setError] = useState("")
        const [openIds, setOpenIds] = useState(() => new Set())
        const cursorRef = useRef(null)
        const recordsRef = useRef([])
        const droppedRef = useRef(0)
        const lengthRef = useRef(0)
        const bodyRef = useRef(null)

        useEffect(() => {
          writeLogView(view)
        }, [view])

        useEffect(() => {
          if (paused) return undefined
          let alive = true
          const tick = () => {
            const cursor = cursorRef.current
            call("GET", "/logs" + (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""))
              .then((res) => {
                if (!alive) return
                setLoaded(true)
                if (!res || !Array.isArray(res.lines)) {
                  setError(String((res && res.message) || "日志读取失败"))
                  return
                }
                setError("")
                // A host half that predates the cursor still answers with the
                // whole tail on every poll: show it, but say so instead of
                // pretending 清空 holds.
                const plain = typeof res.cursor !== "string" || res.cursor === ""
                if (!plain) cursorRef.current = res.cursor
                const replace = plain || res.reset === true
                const merged = mergeLogRecords(replace ? [] : recordsRef.current, res.lines)
                let list = merged.list
                if (list.length > LOG_MAX_RECORDS) {
                  droppedRef.current += list.length - LOG_MAX_RECORDS
                  list = list.slice(list.length - LOG_MAX_RECORDS)
                }
                recordsRef.current = list
                setDropped(droppedRef.current)
                setMode(res.mode === "delta" ? "delta" : "tail")
                setReset(res.reset === true)
                setOmitted(res.omitted === true)
                setLegacy(plain)
                const backend = (res.backend && res.backend.logPath) || ""
                const frontend = (res.frontend && res.frontend.logPath) || ""
                setPaths(
                  [backend, frontend].filter(Boolean).map((p) => p.replace(/\\/g, "/").split("/").pop()).join(" · "),
                )
                if (merged.changed || replace) setRecords(list)
              })
              .catch(() => {})
          }
          tick()
          const timer = setInterval(tick, 2000)
          return () => {
            alive = false
            clearInterval(timer)
          }
        }, [paused])

        const visible = useMemo(() => {
          const needle = query.trim().toLowerCase()
          return records.filter((rec) => {
            if (levelFilter !== "all" && rec.level !== levelFilter) return false
            if (srcFilter !== "all" && rec.src !== srcFilter) return false
            return needle === "" || logHaystack(rec).indexOf(needle) >= 0
          })
        }, [records, levelFilter, srcFilter, query])

        const counts = useMemo(() => {
          const byLevel = { error: 0, warn: 0, info: 0, debug: 0 }
          for (const rec of records) if (byLevel[rec.level] !== undefined) byLevel[rec.level] += 1
          return byLevel
        }, [records])

        useEffect(() => {
          const grown = records.length - lengthRef.current
          lengthRef.current = records.length
          if (grown > 0 && !follow) setPending((n) => n + grown)
        }, [records, follow])

        useEffect(() => {
          if (!follow) return
          const body = bodyRef.current
          if (body) body.scrollTop = body.scrollHeight
        }, [records, follow])

        function jumpToLatest() {
          setFollow(true)
          setPending(0)
          const body = bodyRef.current
          if (body) body.scrollTop = body.scrollHeight
        }
        function onScroll() {
          const body = bodyRef.current
          if (!body) return
          const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 24
          setFollow(atBottom)
          if (atBottom) setPending(0)
        }
        function clearView() {
          recordsRef.current = []
          droppedRef.current = 0
          lengthRef.current = 0
          setRecords([])
          setDropped(0)
          setPending(0)
        }
        function toggleRow(id) {
          setOpenIds((prev) => {
            const next = new Set(prev)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
          })
        }

        const rows = visible.map((rec) => {
          const level = rec.level || "info"
          const isCont = rec.kind === "cont"
          const open = openIds.has(rec.id)
          const fields = rec.fields && typeof rec.fields === "object" ? rec.fields : {}
          const message = [
            h("span", { key: "text" }, rec.msg === "" ? "\u00a0" : rec.msg),
            ...Object.keys(fields).map((key, at) =>
              h("span", { key: "field-" + at }, [
                h("span", { className: "vc-log-field-key" }, " " + key + "="),
                h("span", { className: "vc-log-field-val", "data-key": key }, String(fields[key])),
              ]),
            ),
          ]
          const cells = [
            h("span", { key: "time", className: "vc-log-time" }, isCont ? "" : logClock(rec.ts)),
            h("span", { key: "level", className: "vc-log-level" }, isCont ? "" : String(level).toUpperCase()),
            h(
              "span",
              { key: "src", className: "vc-log-src", "data-src": rec.src },
              isCont ? "" : rec.src === "frontend" ? "前端" : "后端",
            ),
            h(
              "button",
              {
                key: "msg",
                type: "button",
                className: "vc-log-msg",
                "aria-expanded": open ? "true" : "false",
                title: open ? "收起完整行" : "展开完整行（原文 / 调用点 / 字段）",
                onClick: () => toggleRow(rec.id),
              },
              message,
            ),
          ]
          if (open) {
            cells.push(
              h("div", { key: "detail", className: "vc-log-detail" }, [
                h("div", { className: "vc-log-detail-head" }, [
                  h(
                    "span",
                    { key: "origin" },
                    (rec.src === "frontend" ? "前端" : "后端") +
                      " · " +
                      rec.stream +
                      " · " +
                      rec.kind +
                      (rec.partial ? " · 未写完" : ""),
                  ),
                  rec.caller ? h("span", { key: "caller" }, rec.caller) : null,
                  rec.file ? h("span", { key: "file" }, rec.file + (rec.line ? ":" + rec.line : "")) : null,
                  rec.ts > 0 ? h("span", { key: "stamp" }, new Date(rec.ts).toLocaleString("en-GB", { hour12: false })) : null,
                  h(
                    "span",
                    { key: "copy", style: { marginLeft: "auto" } },
                    h(Btn, { onClick: () => copyText(rec.text) }, "复制本行"),
                  ),
                ]),
                h("pre", { key: "raw", className: "vc-log-detail-text" }, rec.text === "" ? "（空行）" : rec.text),
              ]),
            )
          }
          return h(
            "div",
            {
              key: rec.id,
              className: "vc-log-line" + (isCont ? " vc-log-kind-cont" : ""),
              "data-level": level,
              "data-src": rec.src,
              "data-open": open ? "on" : "off",
            },
            cells,
          )
        })

        const stopped = [
          status && status.running === false ? "后端未运行" : "",
          status && status.frontend && status.frontend.running === false ? "前端未运行" : "",
        ].filter(Boolean).join("、")

        let body = rows
        if (error) {
          body = records.length > 0
            ? rows
            : h("div", { className: "vc-log-empty" }, [
                h("div", { key: "why", className: "vc-log-error" }, "读取失败：" + error),
                h(Btn, { key: "retry", onClick: () => setPaused(false) }, "重试"),
              ])
        } else if (!loaded) {
          body = h("div", { className: "vc-log-empty" }, "读取中…")
        } else if (records.length === 0) {
          body = h("div", { className: "vc-log-empty" }, [
            h("div", { key: "none" }, "（暂无日志）"),
            h(
              "div",
              { key: "hint" },
              "启动后端 / 前端后，两个进程的输出会实时汇总到这里。" + (stopped ? "（" + stopped + "）" : ""),
            ),
          ])
        } else if (visible.length === 0) {
          body = h("div", { className: "vc-log-empty" }, "没有符合当前筛选条件的日志（共 " + records.length + " 条）。")
        }

        const statusParts = [
          paused ? "已暂停（继续后补齐）" : follow ? "跟随中" : "未跟随",
          "显示 " + visible.length + " / " + records.length + " 条",
        ]
        if (dropped > 0) statusParts.push("更早 " + dropped + " 条已滚出视图")
        if (omitted) statusParts.push(mode === "delta" ? "积压超过窗口，已跳过部分" : "仅保留最近窗口")
        if (reset) statusParts.push("日志已轮转，视图已刷新")
        if (legacy) statusParts.push("主机未重启：整段刷新")

        return h("div", { className: "vc-logs" }, [
          h("div", { className: "vc-logs-bar" }, [
            h("span", { key: "level-label", className: "vc-log-label" }, "级别"),
            ...LOG_LEVEL_FILTERS.map(([id, label]) =>
              h(
                Chip,
                { key: "level-" + id, active: levelFilter === id, onClick: () => setLevelFilter(id) },
                label + (id === "all" ? " " + records.length : counts[id] > 0 ? " " + counts[id] : ""),
              ),
            ),
            h("span", { key: "src-label", className: "vc-log-label", style: { marginLeft: 6 } }, "来源"),
            ...LOG_SRC_FILTERS.map(([id, label]) =>
              h(Chip, { key: "src-" + id, active: srcFilter === id, onClick: () => setSrcFilter(id) }, label),
            ),
            h(
              "span",
              { key: "search", className: "vc-log-search" },
              h(SearchBox, {
                value: query,
                onChange: (event) => setQuery(event.target.value),
                placeholder: "搜索消息 / 字段 / 调用点",
              }),
            ),
            query ? h(Btn, { key: "clear-search", onClick: () => setQuery(""), title: "清除搜索" }, "×") : null,
          ]),
          h("div", { className: "vc-logs-status" }, [
            h("span", { key: "state" }, statusParts.join(" · ")),
            paths ? h("span", { key: "paths", title: paths }, paths) : null,
            error ? h("span", { key: "error", className: "vc-log-error" }, "读取失败：" + error) : null,
            h("span", { key: "actions", style: { marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" } }, [
              h("span", { key: "size-label", className: "vc-log-label" }, "字号"),
              ...LOG_SIZE_LABELS.map(([id, label]) =>
                h(
                  Chip,
                  { key: "size-" + id, active: view.size === id, onClick: () => setView(Object.assign({}, view, { size: id })) },
                  label,
                ),
              ),
              h(
                Btn,
                { key: "pause", onClick: () => setPaused(!paused), title: paused ? "继续接收日志（不丢行）" : "暂停接收日志" },
                paused ? "▶ 继续" : "❚❚ 暂停",
              ),
              h(
                Btn,
                {
                  key: "clear",
                  disabled: legacy,
                  title: legacy ? "主机未重启：日志按整段刷新，清空会被下一次刷新覆盖" : "清空当前视图（新日志继续追加）",
                  onClick: clearView,
                },
                "清空",
              ),
              h(
                Btn,
                {
                  key: "wrap",
                  title: view.wrap === "on" ? "长行改为横向滚动" : "长行自动换行",
                  onClick: () => setView(Object.assign({}, view, { wrap: view.wrap === "on" ? "off" : "on" })),
                },
                view.wrap === "on" ? "不换行" : "换行",
              ),
              h(Btn, { key: "copy", onClick: () => copyText(visible.map(logLineText).join("\n")), title: "复制当前视图的文本" }, "复制"),
              h(
                Btn,
                { key: "jump", disabled: follow, onClick: jumpToLatest, title: "跳到最新一条" },
                "↓ 跳到最新" + (pending > 0 ? " (" + pending + ")" : ""),
              ),
            ]),
          ]),
          h(
            "div",
            {
              key: "body",
              ref: bodyRef,
              className: "vc-log-body",
              "data-size": view.size,
              "data-wrap": view.wrap,
              role: "log",
              "aria-label": "后端与前端日志",
              onScroll: onScroll,
            },
            body,
          ),
        ])
      }

      // ---- 打包与版本 (packaging & version management) ----
      // Studio distribution, deliberately separate from the dev loop
      // (总控台): this page never starts or stops the backend/frontend. All
      // actions run through vivy-studio.exe on the pinned worktree; release
      // keeps the human gate (NG-25).
      const LEDGER_KINDS = ["generations", "evals", "releases", "installs", "events", "worktrees"]
      const ACTION_LABELS = {
        pack: "打包 pack",
        eval: "评测 eval",
        release: "发布 release",
        reject: "拒绝 reject",
        install: "安装 install",
        rollback: "回滚 rollback",
        inspect: "检查 inspect",
      }

      function PackagePane() {
        const [kind, setKind] = useState("generations")
        const [data, setData] = useState(null)
        const [err, setErr] = useState("")
        const [job, setJob] = useState(null)
        const [form, setForm] = useState({
          with: "", candidate: "", baseline: "", suite: "",
          generation: "", eval: "", release: "", target: "", confirm: false,
        })
        const preRef = useRef(null)

        const refresh = useCallback(() => {
          call("GET", "/lifecycle/list?kind=" + encodeURIComponent(kind)).then((r) => {
            if (r && r.ok) { setData(r.value); setErr("") }
            else { setData(null); setErr((r && r.message) || "读取失败") }
          })
        }, [kind])
        useEffect(() => { refresh() }, [refresh])

        useEffect(() => {
          if (!job || job.status !== "running") return
          const timer = setInterval(() => {
            call("GET", "/lifecycle/jobs/" + encodeURIComponent(job.id)).then((r) => {
              if (r && r.ok) setJob(r.job)
            })
          }, 1000)
          return () => clearInterval(timer)
        }, [job ? job.id : null, job ? job.status : null]) // eslint-disable-line react-hooks/exhaustive-deps

        useEffect(() => {
          if (preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight
        }, [job ? job.output.length : 0]) // eslint-disable-line react-hooks/exhaustive-deps

        function set(field, value) { setForm((f) => ({ ...f, [field]: value })) }
        function run(action) {
          const body = { action: action, ...form }
          if (action === "pack") body.with = form.with.split(",").map((s) => s.trim()).filter(Boolean)
          call("POST", "/lifecycle/run", body).then((r) => {
            if (r && r.ok) { setJob({ id: r.id, action: action, status: "running", output: [], exitCode: null }); setErr("") }
            else setErr((r && r.message) || "任务启动失败")
          })
        }

        const rows = Array.isArray(data) ? data : data && Array.isArray(data.worktrees) ? data.worktrees : []
        const columns = []
        for (const row of rows) {
          if (row && typeof row === "object") {
            for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key)
          }
        }

        const fields = [
          { key: "with", label: "插件(逗号分隔)" },
          { key: "candidate", label: "候选 gen" },
          { key: "baseline", label: "基线 gen" },
          { key: "suite", label: "套件" },
          { key: "generation", label: "Generation" },
          { key: "eval", label: "EvalRun" },
          { key: "release", label: "Release" },
          { key: "target", label: "安装位(默认 VIVY_INSTALL_DIR)" },
        ]

        return h("div", { className: "vc-pane" }, [
          h("div", { className: "vc-card" }, [
            h("div", { className: "vc-card-title" }, "打包编译与版本管理（分发生命周期）"),
            h("div", { className: "vc-msg", style: { marginTop: 2 } }, "通过 vivy-studio.exe 对已钉选工作区执行 pack / eval / release / reject / install / rollback / inspect，并查看账本（generations / evals / releases / installs / events / worktrees）。本页与「总控台」的开发模式完全分离：不会启动或停止任何后端 / 前端开发进程。"),
          ]),
          h("div", { style: { display: "flex", gap: 6, alignItems: "center", flex: "none", flexWrap: "wrap" } }, [
            h("span", { className: "vc-key" }, "账本"),
            ...LEDGER_KINDS.map((k) =>
              h("button", { className: "vc-chip" + (k === kind ? " on" : ""), key: k, onClick: () => setKind(k) }, k),
            ),
            h("button", { className: "vc-btn", onClick: refresh }, "⟳ 刷新"),
          ]),
          err ? h("div", { className: "vc-msg" }, err) : null,
          rows.length === 0 && !err
            ? h("div", { className: "vc-empty" }, "（暂无记录）")
            : h("div", { style: { overflow: "auto", flex: "none", maxHeight: "30vh" } }, [
                h("table", { className: "vc-tbl" }, [
                  h("thead", null, [h("tr", null, columns.map((c) => h("th", { key: c }, c)))]),
                  h("tbody", null, rows.map((row, i) =>
                    h("tr", { key: i }, columns.map((c) => h("td", { key: c }, trunc(row && row[c], 80)))),
                  )),
                ]),
              ]),
          h("div", { className: "vc-card" }, [
            h("div", { className: "vc-grid" }, fields.map((f) =>
              h("label", { className: "vc-field", key: f.key }, [
                f.label,
                h("input", { className: "vc-input", value: form[f.key], onChange: (e) => set(f.key, e.target.value) }),
              ]),
            )),
            h("div", { style: { display: "flex", gap: 8, alignItems: "center", marginTop: 8, flexWrap: "wrap" } }, [
              ...Object.keys(ACTION_LABELS).map((a) =>
                h("button", {
                  className: "vc-btn" + (a === "release" ? " danger" : ""),
                  key: a,
                  disabled: !!job && job.status === "running",
                  onClick: () => run(a),
                }, ACTION_LABELS[a]),
              ),
              h("label", { style: { display: "flex", gap: 6, alignItems: "center", fontSize: 12, color: "var(--dsw-alias-state-warn-primary)" } }, [
                h("input", { type: "checkbox", checked: form.confirm, onChange: (e) => set("confirm", e.target.checked) }),
                "我确认发布：人工操作（--actor human --yes）",
              ]),
            ]),
            h("div", { className: "vc-msg", style: { marginTop: 6 } }, "发布必须勾选人工确认；install/rollback 目标由 vivy-studio.exe 拒绝源码树与 data/ 目录。"),
          ]),
          job
            ? h("div", { className: "vc-card" }, [
                h("div", { className: "vc-row" }, [
                  h("span", { className: "vc-key" }, "任务"),
                  h("span", { className: "vc-val" }, job.id + " · " + job.action + " · " + (job.status === "running" ? "运行中" : job.status === "ok" ? "成功" : "失败" + (job.exitCode != null ? " (exit " + job.exitCode + ")" : ""))),
                ]),
                h("pre", { ref: preRef, className: "vc-pre" }, job.output.length ? job.output.join("\n") : "（等待输出…）"),
                job.status !== "running" ? h("button", { className: "vc-btn", onClick: () => { setJob(null); refresh() } }, "关闭") : null,
              ])
            : null,
        ])
      }

      // ---- Root view ----
      const SECTIONS = [
        ["overview", "总控台"],
        ["logs", "日志"],
        ["package", "打包与版本"],
      ]

      function VivyConsoleView() {
        const [section, setSection] = useState("overview")
        const [status, setStatus] = useState(null)
        useEffect(() => {
          let alive = true
          const tick = () =>
            call("GET", "/status").then((s) => {
              if (alive && s && typeof s.running === "boolean") setStatus(s)
            }).catch(() => {})
          tick()
          const timer = setInterval(tick, 2000)
          return () => { alive = false; clearInterval(timer) }
        }, [])
        return h("div", { className: "vc-root" }, [
          h("div", { className: "vc-tabs" }, SECTIONS.map(([id, label]) =>
            h("button", { className: "vc-tab" + (id === section ? " on" : ""), key: id, onClick: () => setSection(id) }, label),
          )),
          section === "overview" ? h(OverviewPane, { status }) : null,
          section === "package" ? h(PackagePane, null) : null,
          section === "logs" ? h(LogsPane, { status }) : null,
        ])
      }

      // ---- registration ----
      function apply(ctx) {
        ctx.slots.inject("conversation.view", () =>
          ctx.slots.register(
            {
              name: "conversation.view",
              id: "vivy-console",
              order: 30,
              label: () => "Vivy 控制台",
            },
            (props) => h(VivyConsoleView, props),
          ),
        )
      }

      module.exports = { name: NS, inject: ["slots"], apply }
      return module.exports
    },
  })
})()