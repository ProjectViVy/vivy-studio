// Unit tests for the Vivy Console log model (host half).
//
// Run from the repository root:
//   node --test studio/dsh-vivy-console/logs.test.mjs
//
// These pin the parsing rules that the panel and the /logs cursor depend on:
// level inference, byte-accurate offsets for multi-byte lines, continuation
// chaining, timeline ordering, and cursor round-trips.
import test from "node:test"
import assert from "node:assert/strict"

import {
  buildRecords,
  formatCursor,
  inferTextLevel,
  mergeTimeline,
  normalizeLevel,
  parseCursor,
  parseTime,
  shortCaller,
  shortFile,
  splitBufferLines,
  stripAnsi,
} from "./logs.js"

test("normalizeLevel maps the kernel vocabulary to four levels", () => {
  assert.equal(normalizeLevel("INFO"), "info")
  assert.equal(normalizeLevel("info"), "info")
  assert.equal(normalizeLevel("WARN"), "warn")
  assert.equal(normalizeLevel("warning"), "warn")
  assert.equal(normalizeLevel("ERROR"), "error")
  assert.equal(normalizeLevel("fatal"), "error")
  assert.equal(normalizeLevel("DEBUG"), "debug")
  assert.equal(normalizeLevel("trace"), "debug")
  assert.equal(normalizeLevel(""), "")
  assert.equal(normalizeLevel(undefined), "")
})

test("inferTextLevel reads wording, then colour, then the stream default", () => {
  assert.equal(inferTextLevel("ELIFECYCLE  Command failed with exit code 1.", "err"), "error")
  assert.equal(inferTextLevel("panic: runtime error: index out of range", "out"), "error")
  assert.equal(inferTextLevel("\u001b[31mboom\u001b[0m", "out"), "error")
  assert.equal(inferTextLevel("\u001b[33mcareful\u001b[0m", "out"), "warn")
  assert.equal(inferTextLevel("Warning: deprecated option", "out"), "warn")
  assert.equal(inferTextLevel("some progress noise", "err"), "warn")
  assert.equal(inferTextLevel("  VITE v7.3.6  ready in 1307 ms", "out"), "info")
  assert.equal(inferTextLevel("", "out"), "info")
})

test("stripAnsi removes SGR and OSC sequences and keeps CJK text", () => {
  assert.equal(stripAnsi("\u001b[32m ready \u001b[39m"), " ready ")
  assert.equal(stripAnsi("\u001b]0;title\u0007done"), "done")
  assert.equal(stripAnsi("路径 未找到"), "路径 未找到")
  assert.equal(stripAnsi(undefined), "")
})

test("parseTime accepts slog nanoseconds and epoch numbers", () => {
  const ms = parseTime("2026-09-17T08:13:59.2834704+08:00")
  assert.equal(ms, Date.parse("2026-09-17T08:13:59.283+08:00"))
  assert.equal(parseTime(1789604471767), 1789604471767)
  assert.equal(parseTime(1789604471.767), 1789604471767)
  assert.equal(parseTime("not a time"), 0)
  assert.equal(parseTime(""), 0)
})

test("shortCaller and shortFile shorten real slog source values", () => {
  assert.equal(
    shortCaller("agent-vivy/internal/channelhost.(*Host).StartAll"),
    "channelhost.Host.StartAll",
  )
  assert.equal(shortCaller("main.main"), "main.main")
  assert.equal(shortCaller("agent-vivy/internal/app.(*App).Run.func1"), "app.Run.func1")
  assert.equal(shortCaller(""), "")
  assert.equal(
    shortFile("C:/Users/x/agent-vivy/internal/app/app.go"),
    "internal/app/app.go",
  )
  assert.equal(shortFile("C:\\Users\\x\\agent-vivy\\cmd\\vivy\\main.go"), "cmd/vivy/main.go")
  assert.equal(shortFile("app.go"), "app.go")
})

test("splitBufferLines keeps byte offsets for multi-byte lines and CRLF", () => {
  const buffer = Buffer.from("中文 line\nnext\r\nstuck", "utf8")
  const lines = splitBufferLines(buffer, 100)
  assert.equal(lines.length, 3)
  assert.equal(lines[0].text, "中文 line")
  assert.equal(lines[0].offset, 100)
  assert.equal(lines[0].partial, false)
  // 中文 = 6 bytes + " line" = 5 + "\n" = 12 bytes of the first record.
  assert.equal(lines[1].text, "next")
  assert.equal(lines[1].offset, 112)
  assert.equal(lines[2].text, "stuck")
  assert.equal(lines[2].offset, 118)
  assert.equal(lines[2].partial, true)
})

test("splitBufferLines does not invent a trailing empty line", () => {
  assert.deepEqual(splitBufferLines(Buffer.from("a\n", "utf8"), 0).map((l) => l.text), ["a"])
  assert.equal(splitBufferLines(Buffer.alloc(0), 5).length, 0)
})

test("buildRecords parses kernel JSON lines into structured records", () => {
  const raw = JSON.stringify({
    time: "2026-09-17T08:21:11.824437+08:00",
    level: "INFO",
    source: {
      function: "agent-vivy/internal/app.(*App).Run.func1",
      file: "C:/w/agent-vivy/internal/app/app.go",
      line: 1562,
    },
    msg: "vivy starting",
    addr: "127.0.0.1:8787",
    count: 2,
    nested: { a: 1 },
  })
  const lines = splitBufferLines(Buffer.from(raw + "\n", "utf8"), 4096)
  const [rec] = buildRecords(lines, "backend", "out")
  assert.equal(rec.id, "b:out:4096")
  assert.equal(rec.kind, "json")
  assert.equal(rec.level, "info")
  assert.equal(rec.src, "backend")
  assert.equal(rec.stream, "out")
  assert.equal(rec.msg, "vivy starting")
  assert.equal(rec.caller, "app.Run.func1")
  assert.equal(rec.file, "internal/app/app.go")
  assert.equal(rec.line, 1562)
  assert.equal(rec.ts, parseTime("2026-09-17T08:21:11.824437+08:00"))
  assert.deepEqual(rec.fields, { addr: "127.0.0.1:8787", count: "2", nested: '{"a":1}' })
  assert.equal(rec.partial, false)
})

test("buildRecords trusts the last duplicate level key (slog milestone line)", () => {
  const raw =
    '{"time":"2026-09-17T08:21:11.824437+08:00","level":"INFO","msg":"logging initialized","level":"info","format":"json"}'
  const [rec] = buildRecords(splitBufferLines(Buffer.from(raw + "\n", "utf8"), 0), "backend", "out")
  assert.equal(rec.level, "info")
  assert.equal(rec.msg, "logging initialized")
  assert.deepEqual(rec.fields, { format: "json" })
})

test("buildRecords chains continuations and keeps text lines independent", () => {
  const text = [
    '{"time":"2026-09-17T08:13:59.2834704+08:00","level":"ERROR","msg":"startup aborted","err":"boom"}',
    "\tgoroutine 1 [running]:",
    "main.main()",
    "",
    "> vite --port 3015",
    "  ➜  Local:   http://localhost:3015/",
  ].join("\n")
  const records = buildRecords(splitBufferLines(Buffer.from(text + "\n", "utf8"), 0), "backend", "err")
  assert.deepEqual(records.map((r) => r.kind), ["json", "cont", "cont", "cont", "text", "text"])
  assert.deepEqual(records.map((r) => r.level), ["error", "error", "error", "error", "warn", "warn"])
  assert.equal(records[2].msg, "main.main()")
  // A plain line that does not look like a continuation ends the chain and gets
  // its own inferred level instead of inheriting the structured line's.
  const mixed = buildRecords(
    splitBufferLines(Buffer.from('{"level":"warn","msg":"degraded"}\nplain line\n', "utf8"), 0),
    "backend",
    "out",
  )
  assert.deepEqual(mixed.map((r) => r.kind), ["json", "text"])
  assert.equal(mixed[1].level, "info")
})

test("a partial line and its completed version share one id", () => {
  const first = buildRecords(splitBufferLines(Buffer.from('{"level":"info","msg":"half', "utf8"), 700), "backend", "out")
  const second = buildRecords(
    splitBufferLines(Buffer.from('{"level":"info","msg":"half done"}\n', "utf8"), 700),
    "backend",
    "out",
  )
  assert.equal(first[0].partial, true)
  assert.equal(second[0].partial, false)
  assert.equal(first[0].id, second[0].id)
  assert.equal(second[0].msg, "half done")
})

test("mergeTimeline orders by timestamp and inherits per source", () => {
  const records = [
    { id: "b:err:1", src: "backend", stream: "err", ts: 300, message: "later" },
    { id: "b:out:1", src: "backend", stream: "out", ts: 100, message: "earlier" },
    { id: "b:out:2", src: "backend", stream: "out", ts: 0, message: "no clock" },
    { id: "f:out:1", src: "frontend", stream: "out", ts: 0, message: "vite text" },
  ]
  assert.deepEqual(
    mergeTimeline(records).map((r) => r.id),
    ["b:out:1", "b:out:2", "b:err:1", "f:out:1"],
  )
})

test("mergeTimeline keeps read order when no timestamp exists anywhere", () => {
  const records = [
    { id: "b:out:1", src: "backend", stream: "out", ts: 0 },
    { id: "f:out:1", src: "frontend", stream: "out", ts: 0 },
    { id: "f:err:1", src: "frontend", stream: "err", ts: 0 },
  ]
  assert.deepEqual(
    mergeTimeline(records).map((r) => r.id),
    ["b:out:1", "f:out:1", "f:err:1"],
  )
})

test("cursor parse and format round-trip, malformed cursors are refused", () => {
  assert.deepEqual(parseCursor("44266.0.12277.10181"), [44266, 0, 12277, 10181])
  assert.equal(formatCursor([44266, 0, 12277, 10181]), "44266.0.12277.10181")
  assert.equal(parseCursor("  1.2.3.4  ").length, 4)
  assert.equal(parseCursor(""), null)
  assert.equal(parseCursor("1.2.3"), null)
  assert.equal(parseCursor("1.2.3.4.5"), null)
  assert.equal(parseCursor("1.2.3.-4"), null)
  assert.equal(parseCursor("a.b.c.d"), null)
  assert.equal(parseCursor("1.2.3.99999999999999999999"), null)
  assert.equal(parseCursor(undefined), null)
  assert.equal(formatCursor([-3, 0, 1.9, 10]), "0.0.1.10")
})