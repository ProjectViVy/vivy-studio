// Recipe light structural checks (Host half of dsh-species-workbench).
//
// This is deliberately NOT a second YAML/schema authority: the compiler
// in vivy-sdk stays the single source of truth and rejects anything else
// at pack time (strict validation here runs a real pack into a throwaway
// dir). These checks only catch the shape errors that cost a human a
// minutes-long build round-trip: wrong apiVersion, missing profile or
// modules, duplicate module rows, unknown top-level keys.

const TOP_LEVEL_KEYS = [
  "apiVersion",
  "profile",
  "modules",
  "sources",
  "exclusive",
  "order",
  "grantApprovals",
  "ui",
]

// parseRecipeText understands the two YAML shapes the repository recipes
// actually use for lists: inline flow (`modules: [a, b]`) and block items
// (`  - a`). Anything deeper (maps under sources/ui/…) is kept verbatim;
// structural validation stops at the top-level contract.
export function parseRecipeText(text) {
  const lines = String(text || "").split(/\r?\n/)
  const errors = []
  const keys = []
  const modules = []
  let currentList = null
  for (const raw of lines) {
    if (raw.trim() === "" || raw.trim().startsWith("#")) continue
    const top = /^([A-Za-z][\w-]*):(.*)$/.exec(raw)
    if (top) {
      keys.push(top[1])
      currentList = null
      if (top[2].trim() === "") {
        currentList = top[1]
        continue
      }
      const inline = /^(\[[^\]]*\])$/.exec(top[2].trim())
      if (inline && (top[1] === "modules" || top[1] === "sources")) {
        for (const item of splitFlow(inline[1])) if (top[1] === "modules") modules.push(item)
        currentList = null
        continue
      }
      continue
    }
    const item = /^\s+-\s+(.*)$/.exec(raw)
    if (item && currentList === "modules") {
      modules.push(item[1].trim())
    }
  }
  if (!keys.includes("apiVersion")) errors.push("缺少 apiVersion")
  if (!keys.includes("profile")) errors.push("缺少 profile")
  if (!keys.includes("modules")) errors.push("缺少 modules")
  for (const k of keys) {
    if (!TOP_LEVEL_KEYS.includes(k)) errors.push(`未知顶层键: ${k}`)
  }
  return { keys, modules, errors }
}

function splitFlow(text) {
  return text
    .replace(/^\[/, "")
    .replace(/\]\s*$/, "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
}

export function validateRecipe(text) {
  const parsed = parseRecipeText(text)
  const errors = [...parsed.errors]
  const apiVersion = /^apiVersion:\s*(\S+)/m.exec(String(text || ""))
  if (apiVersion && apiVersion[1] !== "vivy.generation/v1") {
    errors.push(`apiVersion 必须是 vivy.generation/v1（当前 ${apiVersion[1]}）`)
  }
  const profile = /^profile:\s*(\S+)/m.exec(String(text || ""))
  if (profile && !/^[A-Za-z0-9._-]+$/.test(profile[1])) {
    errors.push(`profile 名不合法: ${profile[1]}`)
  }
  if (parsed.modules.length === 0 && !errors.some((e) => e.includes("modules"))) {
    errors.push("modules 不能为空")
  }
  const seen = new Set()
  for (const m of parsed.modules) {
    if (seen.has(m)) errors.push(`modules 重复: ${m}`)
    seen.add(m)
  }
  return { ok: errors.length === 0, errors, modules: parsed.modules, profile: profile ? profile[1] : "" }
}
