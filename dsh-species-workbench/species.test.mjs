// species/inspect read path: bootstrap → WebSocket JSON-RPC → Report,
// with the two degraded paths (backend down, no global WebSocket).
import test from "node:test"
import assert from "node:assert/strict"

import { inspectSpecies } from "./species.js"

const REPORT = { protocol_version: "v1", generation_id: "gen_live_7", recipe: {}, grants: ["fs.read"] }

function fakeFetch(handler) {
  return async (url) => handler(url)
}

class FakeSocket {
  static lastUrl = ""
  static lastSent = ""
  constructor(url) {
    FakeSocket.lastUrl = url
    this.listeners = {}
    queueMicrotask(() => this.fire("open"))
  }
  addEventListener(type, fn) {
    ;(this.listeners[type] ||= []).push(fn)
  }
  fire(type, event) {
    for (const fn of this.listeners[type] || []) fn(event || {})
  }
  send(data) {
    FakeSocket.lastSent = data
    setTimeout(() => this.fire("message", { data: JSON.stringify({ jsonrpc: "2.0", id: 1, result: REPORT }) }), 0)
  }
  close() {}
}

test("happy path: bootstrap token then species/inspect over WS", async () => {
  const fetchImpl = fakeFetch(async (url) => {
    assert.equal(url, "http://127.0.0.1:8787/rpc/bootstrap")
    return { ok: true, json: async () => ({ protocol_version: "v1", websocket_path: "/rpc", token: "t0k" }) }
  })
  const r = await inspectSpecies("127.0.0.1:8787", { fetchImpl, WebSocketImpl: FakeSocket })
  assert.equal(r.ok, true)
  assert.equal(r.report.generation_id, "gen_live_7")
  assert.match(FakeSocket.lastUrl, /^ws:\/\/127\.0\.0\.1:8787\/rpc\?token=t0k$/)
  const frame = JSON.parse(FakeSocket.lastSent)
  assert.equal(frame.method, "species/inspect")
  assert.equal(frame.jsonrpc, "2.0")
})

test("backend down is reachable:false, not a crash", async () => {
  const fetchImpl = fakeFetch(async () => {
    throw new Error("connect ECONNREFUSED")
  })
  const r = await inspectSpecies("127.0.0.1:9999", { fetchImpl, WebSocketImpl: FakeSocket })
  assert.equal(r.ok, false)
  assert.equal(r.reachable, false)
  assert.match(r.message, /ECONNREFUSED/)
})

test("no global WebSocket degrades the species card only", async () => {
  const r = await inspectSpecies("127.0.0.1:8787", { fetchImpl: fakeFetch(async () => ({ ok: true, json: async () => ({}) })), WebSocketImpl: undefined })
  assert.equal(r.ok, false)
  assert.equal(r.degraded, "websocket-unavailable")
})

test("RPC error frames surface as inspect failures", async () => {
  class ErrSocket extends FakeSocket {
    send(data) {
      FakeSocket.lastSent = data
      setTimeout(() => this.fire("message", { data: JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "method not found" } }) }), 0)
    }
  }
  const fetchImpl = fakeFetch(async () => ({ ok: true, json: async () => ({ websocket_path: "/rpc", token: "t" }) }))
  const r = await inspectSpecies("127.0.0.1:8787", { fetchImpl, WebSocketImpl: ErrSocket })
  assert.equal(r.ok, false)
  assert.match(r.message, /method not found/)
})
