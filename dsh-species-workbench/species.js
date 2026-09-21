// species/inspect read path (Host half of dsh-species-workbench).
//
// The control plane is a token-guarded WebSocket JSON-RPC behind
// GET /rpc/bootstrap (internal/app/app.go). Requests carry no browser
// Origin when they come from this Node half, which the kernel's origin
// policy accepts. The species side is read-only here (NG-23): every
// lifecycle write goes through vivy-studio.exe, never through /rpc —
// promotions/promote and evals/start are off-limits to this plugin.

export const DEFAULT_BACKEND = "127.0.0.1:8787"

function errMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

export async function inspectSpecies(addr, opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch
  const WebSocketImpl = "WebSocketImpl" in opts ? opts.WebSocketImpl : globalThis.WebSocket
  const timeoutMs = opts.timeoutMs || 4000
  if (typeof WebSocketImpl !== "function") {
    return { ok: false, reachable: false, degraded: "websocket-unavailable", message: "宿主 Node 无全局 WebSocket，无法读取 /rpc" }
  }
  let boot
  try {
    boot = await withTimeout(
      fetchImpl(`http://${addr}/rpc/bootstrap`).then(async (res) => {
        if (!res.ok) throw new Error(`bootstrap HTTP ${res.status}`)
        return await res.json()
      }),
      timeoutMs,
    )
  } catch (error) {
    return { ok: false, reachable: false, message: `后端不可达 (${addr}): ${errMessage(error)}` }
  }
  const wsUrl = `ws://${addr}${boot.websocket_path || "/rpc"}?token=${encodeURIComponent(boot.token || "")}`
  try {
    const report = await withTimeout(rpcCall(WebSocketImpl, wsUrl, "species/inspect"), timeoutMs)
    return { ok: true, reachable: true, report }
  } catch (error) {
    return { ok: false, reachable: false, message: `species/inspect 失败: ${errMessage(error)}` }
  }
}

function rpcCall(WebSocketImpl, url, method) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocketImpl(url)
    let settled = false
    const done = (fn, value) => {
      if (settled) return
      settled = true
      try {
        socket.close()
      } catch {
        /* already closing */
      }
      fn(value)
    }
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method }))
    })
    socket.addEventListener("message", (event) => {
      let frame
      try {
        frame = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (!frame || frame.id !== 1) return
      if (frame.error) done(reject, new Error(`${frame.error.code}: ${frame.error.message}`))
      else done(resolve, frame.result)
    })
    socket.addEventListener("error", () => done(reject, new Error("websocket error")))
    socket.addEventListener("close", () => done(reject, new Error("websocket closed before reply")))
  })
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`超时 (${ms}ms)`)), ms).unref?.()),
  ])
}
