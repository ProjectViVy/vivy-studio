// Vivy Console — unified log model (host half, pure).
//
// Turns the four raw log streams (backend out/err, frontend out/err) into one
// ordered timeline of structured records. This module does no I/O: index.js
// reads the byte windows and hands them here, so every rule below is unit
// testable (logs.test.mjs).
//
// Record fields are the /vivy-console/api/logs wire shape:
//   id      stable line identity "<b|f>:<out|err>:<byte offset of the line>"
//   src     "backend" | "frontend"
//   stream  "out" | "err"
//   kind    "json" (kernel slog line) | "text" | "cont" (continuation of the previous line)
//   level   "debug" | "info" | "warn" | "error" — inferred once, here, never on the client
//   ts      epoch ms of the record, 0 when the line carries no timestamp
//   msg     the message (json: the msg attribute, text: the line itself)
//   caller  short function name from the slog source, "" otherwise
//   file    repo-relative source file, "" otherwise
//   line    source line number, 0 otherwise
//   fields  display-ready attributes, excluding time/level/msg/source
//   text    the raw line with ANSI stripped — the lossless copy/expand source
//   partial true when the line had no newline yet; the completed line returns
//           with the same id, so a reader upserts instead of duplicating

/** Severity order used by the panel filters. */
export const LEVELS = ["debug", "info", "warn", "error"]

/** Number of streams a cursor tracks: backend out/err, frontend out/err. */
export const CURSOR_LENGTH = 4

const ANSI_OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g
const ANSI_CSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g
// Only the plain and bright red/amber SGR codes are read as a severity hint;
// extended-color (38;5;n) sequences are left alone rather than guessed at.
const SGR_RED = /\u001b\[(?:31|91)m/
const SGR_AMBER = /\u001b\[(?:33|93)m/
const TEXT_ERROR = /\b(error|errors|failed|failure|fatal|panic|exception|refused|denied)\b|ERR!|✘|✖|exit code [1-9]/i
const TEXT_WARN = /\b(warn|warns|warning|warnings|deprecated|deprecation)\b|⚠/i
// A line that belongs to the previous record: indented output, a Go stack frame,
// or a tool's own error block. Anything else after a structured line is a new line.
const TEXT_STACK = /^(goroutine |panic:|main\.|created by |exit status|ELIFECYCLE|npm ERR!|ERR!|\tat )|^\S+\.go:\d+/

function isContinuationLine(text) {
  return text === "" || /^\s/.test(text) || TEXT_STACK.test(text)
}

/** Strip ANSI OSC and CSI sequences, keeping the visible text. */
export function stripAnsi(text) {
  return String(text ?? "").replace(ANSI_OSC, "").replace(ANSI_CSI, "")
}

/**
 * Map a declared log level to the four panel levels.
 * Unknown or missing values return ""; callers choose the fallback.
 */
export function normalizeLevel(raw) {
  const value = String(raw ?? "").trim().toLowerCase()
  if (value === "") return ""
  if (value.startsWith("err") || value === "fatal" || value === "panic" || value === "critical") return "error"
  if (value.startsWith("warn")) return "warn"
  if (value === "debug" || value === "trace" || value === "verbose") return "debug"
  if (value === "info" || value === "notice" || value === "log") return "info"
  return "info"
}

/**
 * Infer a level for a line that carries no level field: error wording first,
 * then the SGR colour an ANSI-coloured tool used, then warning wording, then
 * the stream default (stderr is at least a warning).
 */
export function inferTextLevel(raw, stream) {
  const text = String(raw ?? "")
  if (TEXT_ERROR.test(text)) return "error"
  if (SGR_RED.test(text)) return "error"
  if (SGR_AMBER.test(text)) return "warn"
  if (TEXT_WARN.test(text)) return "warn"
  return stream === "err" ? "warn" : "info"
}

/**
 * Shorten a slog source.function, e.g.
 * "agent-vivy/internal/channelhost.(*Host).StartAll" -> "channelhost.Host.StartAll".
 */
export function shortCaller(fn) {
  const raw = String(fn ?? "").trim()
  if (raw === "") return ""
  const tail = raw.slice(raw.lastIndexOf("/") + 1)
  const segments = tail
    .split(".")
    .map((part) => part.replace(/^\(\*?/, "").replace(/\)$/, ""))
    .filter((part) => part !== "")
  if (segments.length === 0) return ""
  if (segments.length > 3) return [segments[0], ...segments.slice(-2)].join(".")
  return segments.join(".")
}

/**
 * Shorten a slog source.file to its repository-relative tail, e.g.
 * "C:/…/agent-vivy/internal/app/app.go" -> "internal/app/app.go".
 */
export function shortFile(file) {
  const raw = String(file ?? "").trim().replace(/\\/g, "/")
  if (raw === "") return ""
  const anchor = Math.max(raw.lastIndexOf("/internal/"), raw.lastIndexOf("/cmd/"))
  if (anchor >= 0) return raw.slice(anchor + 1)
  const slash = raw.lastIndexOf("/")
  return slash >= 0 ? raw.slice(slash + 1) : raw
}

/** Parse a slog time value (RFC3339 string or epoch number) to epoch ms; 0 when unknown. */
export function parseTime(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value > 1e12 ? value : value * 1000)
  }
  const raw = String(value ?? "").trim()
  if (raw === "") return 0
  const direct = Date.parse(raw)
  if (!Number.isNaN(direct)) return direct
  // Engines that reject more than three fractional digits (slog writes nanoseconds).
  const trimmed = Date.parse(raw.replace(/\.(\d{3})\d+/, ".$1"))
  return Number.isNaN(trimmed) ? 0 : trimmed
}

function displayValue(value) {
  if (value === null || value === undefined) return ""
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** Parse one kernel slog JSON line into the record parts; null when it is not JSON. */
function parseJsonLine(text) {
  const trimmed = text.trim()
  if (trimmed.length < 2 || trimmed.charCodeAt(0) !== 0x7b) return null
  let parsed
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const source = parsed.source && typeof parsed.source === "object" ? parsed.source : {}
  const fields = {}
  for (const key of Object.keys(parsed)) {
    if (key === "time" || key === "level" || key === "msg" || key === "source") continue
    fields[key] = displayValue(parsed[key])
  }
  return {
    time: parsed.time,
    level: parsed.level,
    msg: parsed.msg === undefined ? "" : displayValue(parsed.msg),
    caller: shortCaller(source.function),
    file: shortFile(source.file),
    line: Number.isInteger(source.line) ? source.line : 0,
    fields,
  }
}

function lineId(src, stream, offset) {
  return `${src === "backend" ? "b" : "f"}:${stream}:${offset}`
}

/**
 * Turn one stream's lines into records, chaining continuations: an indented or
 * stack-like line after a structured line is `cont` and inherits the previous
 * level (Go panic traces, pnpm error blocks). A line that does not look like a
 * continuation opens a new `text` record with its own inferred level.
 */
export function buildRecords(lines, src, stream) {
  const out = []
  let previousLevel = ""
  let previousStructured = false
  for (const line of lines) {
    const id = lineId(src, stream, line.offset)
    const text = stripAnsi(line.text)
    const json = parseJsonLine(text)
    const base = { id, src, stream, text, partial: line.partial === true }
    if (json !== null) {
      out.push({
        ...base,
        kind: "json",
        level: normalizeLevel(json.level) || "info",
        ts: parseTime(json.time),
        msg: json.msg,
        caller: json.caller,
        file: json.file,
        line: json.line,
        fields: json.fields,
      })
    } else if (previousStructured && isContinuationLine(text)) {
      out.push({
        ...base,
        kind: "cont",
        level: previousLevel === "" ? "info" : previousLevel,
        ts: 0,
        msg: text,
        caller: "",
        file: "",
        line: 0,
        fields: {},
      })
    } else {
      out.push({
        ...base,
        kind: "text",
        level: inferTextLevel(line.text, stream),
        ts: 0,
        msg: text,
        caller: "",
        file: "",
        line: 0,
        fields: {},
      })
    }
    const last = out[out.length - 1]
    previousLevel = last.level
    previousStructured = last.kind === "json" || last.kind === "cont"
  }
  return out
}

/**
 * Order records into one timeline: by timestamp where one exists, with a
 * timestamp-less record inheriting the last timestamp of its own source. A
 * source with no timestamp at all (today: the Vite/pnpm streams) sorts after
 * the timestamped records in read order, so nothing is invented.
 */
export function mergeTimeline(records) {
  const lastTimestamp = new Map()
  const keyed = records.map((rec, index) => {
    let key = rec.ts
    if (key > 0) {
      lastTimestamp.set(rec.src, key)
    } else {
      const inherited = lastTimestamp.get(rec.src)
      key = inherited > 0 ? inherited : Number.POSITIVE_INFINITY
    }
    return { rec, key, index }
  })
  keyed.sort((a, b) => a.key - b.key || a.index - b.index)
  return keyed.map((entry) => entry.rec)
}

/**
 * Split a byte window into lines carrying their absolute byte offset.
 * Offsets stay byte-accurate for multi-byte text, and a trailing segment with
 * no newline is marked `partial` so its cursor can wait for the rest.
 */
export function splitBufferLines(buffer, base) {
  const lines = []
  let position = 0
  const size = buffer.length
  while (position < size) {
    const newline = buffer.indexOf(0x0a, position)
    if (newline === -1) {
      lines.push({
        text: buffer.subarray(position, size).toString("utf8").replace(/\r$/, ""),
        offset: base + position,
        partial: true,
      })
      break
    }
    lines.push({
      text: buffer.subarray(position, newline).toString("utf8").replace(/\r$/, ""),
      offset: base + position,
      partial: false,
    })
    position = newline + 1
  }
  return lines
}

/**
 * Parse a cursor string ("<backend.out>.<backend.err>.<frontend.out>.<frontend.err>"
 * byte offsets). Anything malformed returns null, which the caller treats as
 * "no cursor" — a fresh tail — rather than guessing.
 */
export function parseCursor(raw) {
  if (typeof raw !== "string") return null
  const trimmed = raw.trim()
  if (trimmed === "") return null
  const parts = trimmed.split(".")
  if (parts.length !== CURSOR_LENGTH) return null
  const offsets = []
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null
    const value = Number(part)
    if (!Number.isSafeInteger(value)) return null
    offsets.push(value)
  }
  return offsets
}

/** Format byte offsets into the opaque cursor string handed back to the client. */
export function formatCursor(offsets) {
  return offsets.map((value) => String(Math.max(0, Math.trunc(value)))).join(".")
}