// Vivy Studio 物种工作台 (Host half).
//
// A profile-bundle cordis plugin in the Studio server process. Scope:
//   * 当前形态: read-only species/inspect through the managed backend's
//     /rpc control plane (NG-23 — the species side never accepts writes
//     from here; promotions/promote and evals/start are never called).
//   * 候选与生命周期: the Studio ledger + pack/eval/release/reject/
//     install/rollback driven through vivy-studio.exe. Release/install/
//     rollback forward --actor human --yes (and run at all) only after an
//     explicit UI confirmation (NG-25); the switch takes effect on the
//     NEXT launch of the daily location, never in-process.
//   * Recipe 编辑器: draft recipes live under Studio scratch
//     (data/studio-home/species-workbench/recipes), never under recipes/
//     — promoting a draft into the repository is a human copy. Validation
//     is structural here and authoritative at pack time (the sdk compiler
//     stays the single source of truth).
//
// Air gap (ST-2): this plugin reads the ledger and writes only under
// data/studio-home/. data/vivy.db, data/demo/, data/workspaces/ are the
// tenant Journal and never touched.
//
// Routes on the Studio webServer (same-origin for the client half):
//   GET  /dsh-species-workbench/api/state
//   GET  /dsh-species-workbench/api/species?addr=
//   POST /dsh-species-workbench/api/species/probe   {addr}
//   GET  /dsh-species-workbench/api/ledger?kind=
//   GET  /dsh-species-workbench/api/catalog
//   GET  /dsh-species-workbench/api/repo-recipes/<name>   (read-only)
//   GET|PUT|DELETE /dsh-species-workbench/api/recipes/<name>
//   POST /dsh-species-workbench/api/recipes/<name>/validate {strict}
//   POST /dsh-species-workbench/api/jobs   {action, ...fields, confirm}
//   GET  /dsh-species-workbench/api/jobs/<id>

import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DEFAULT_BACKEND, inspectSpecies } from "./species.js"
import { validateRecipe } from "./recipe.js"
import { buildLifecycleArgs, createJobRunner } from "./jobs.js"

export const name = "dsh-species-workbench"
export const inject = ["webServer"]

const root = process.cwd().replace(/[\\/]+$/, "")
const workbenchDir = join(root, "data", "studio-home", "species-workbench")
const draftsDir = join(workbenchDir, "recipes")
const validateDir = join(workbenchDir, "validate")
const apiPrefix = "/dsh-species-workbench/api"

const norm = (p) => String(p || "").replace(/\\/g, "/")

const runner = createJobRunner()

function resolveStudioExe() {
  const candidates = []
  if (process.env.VIVY_STUDIO) candidates.push(process.env.VIVY_STUDIO)
  candidates.push(join(root, "vivy-studio.exe"), join(root, "vivy-studio"))
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return norm(candidate)
  }
  return ""
}

function backendAddr() {
  return String(process.env.VIVY_BACKEND_ADDR || DEFAULT_BACKEND).trim()
}

// ---- ledger reads (vivy-studio.exe list, same trust path as actions) ----

function lifecycleList(kind) {
  const exe = resolveStudioExe()
  if (!exe) return Promise.resolve({ ok: false, message: "未找到 vivy-studio.exe（先运行 just studio）" })
  const argv = kind === "worktrees" ? ["--worktree", root, "workspace", "list"] : ["--worktree", root, "list", kind]
  return new Promise((resolve) => {
    const proc = spawn(exe, argv, { windowsHide: true, env: process.env })
    let stdout = ""
    let stderr = ""
    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8")
    })
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8")
    })
    proc.on("error", (error) => resolve({ ok: false, message: "vivy-studio: " + error.message }))
    proc.on("close", (code) => {
      if (code !== 0) return resolve({ ok: false, message: stderr.trim() || `vivy-studio exited ${code}` })
      try {
        resolve({ ok: true, value: JSON.parse(stdout) })
      } catch (error) {
        resolve({ ok: false, message: "解析失败: " + (error instanceof Error ? error.message : error) })
      }
    })
  })
}

// ---- catalog: what may enter a recipe (mirror of the build-owned tables) ----

function listModuleDirs(subdir) {
  const base = join(root, subdir)
  if (!existsSync(base)) return []
  const out = []
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (existsSync(join(base, entry.name, "vivy-module.yaml"))) out.push(`${subdir}/${entry.name}`)
  }
  return out
}

function catalog() {
  const recipes = []
  const repoRecipes = join(root, "recipes")
  if (existsSync(repoRecipes)) {
    for (const f of readdirSync(repoRecipes)) {
      if (/\.vivy\.ya?ml$/.test(f)) recipes.push({ name: f, path: `recipes/${f}`, origin: "repo" })
    }
  }
  const drafts = []
  if (existsSync(draftsDir)) {
    for (const f of readdirSync(draftsDir)) {
      if (/\.(ya?ml|vivy\.ya?ml)$/.test(f)) drafts.push({ name: f, path: norm(join(draftsDir, f)), origin: "draft" })
    }
  }
  return {
    ok: true,
    recipes: recipes.concat(drafts),
    modules: listModuleDirs("plugins"),
    faces: listModuleDirs("faces"),
  }
}

// ---- draft recipes (Studio scratch only; never writes recipes/) ----

const DRAFT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}(\.vivy)?\.ya?ml$/

function draftPath(name) {
  if (!DRAFT_NAME.test(String(name || ""))) return ""
  return join(draftsDir, name)
}

function readDraft(file) {
  try {
    return { ok: true, text: readFileSync(file, "utf8") }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

// resolveRecipeArg maps a browser-supplied recipe reference to a real path.
// The browser sends names, never paths: a bare <name>.yml resolves to the
// draft dir, "recipes/<name>" to the repo, and draftsDir-absolute paths
// (issued by strict validate) pass through. Anything else is refused.
export function resolveRecipeArg(value) {
  const text = norm(String(value || "").trim())
  if (!text) return ""
  const base = text.split("/").pop()
  if (!DRAFT_NAME.test(base)) return ""
  if (!text.includes("/")) return norm(join(draftsDir, base))
  if (text === `recipes/${base}`) return norm(join(root, "recipes", base))
  if (text.startsWith(norm(draftsDir) + "/")) return text
  return ""
}

function writeDraft(file, text) {
  try {
    if (typeof text !== "string" || text.length > 256 * 1024) return { ok: false, message: "内容不合法或过大" }
    mkdirSync(draftsDir, { recursive: true })
    writeFileSync(file, text, "utf8")
    return { ok: true, path: norm(file) }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

// ---- HTTP plumbing (same shape as the console plugin) ----

function readBody(req) {
  return new Promise((resolve) => {
    let data = ""
    req.on("data", (chunk) => {
      data += chunk
      if (data.length > 64 * 1024) req.destroy()
    })
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {})
      } catch {
        resolve({})
      }
    })
    req.on("error", () => resolve({}))
  })
}

function json(res, payload) {
  res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
  res.end(JSON.stringify(payload))
}

async function handleApi(req, res, route) {
  const method = req.method || "GET"
  const url = new URL(req.url || "/", "http://x")
  const body = method === "POST" ? await readBody(req) : {}
  const query = url.searchParams

  if (method === "GET" && route === "/state") {
    return json(res, {
      ok: true,
      root: norm(root),
      workdir: norm(workbenchDir),
      studioExe: resolveStudioExe(),
      backend: backendAddr(),
      ws: typeof globalThis.WebSocket === "function",
    })
  }
  if (method === "GET" && route === "/species") {
    return json(res, await inspectSpecies(String(query.get("addr") || backendAddr())))
  }
  if (method === "POST" && route === "/species/probe") {
    return json(res, await inspectSpecies(String(body.addr || backendAddr())))
  }
  if (method === "GET" && route === "/ledger") {
    const kind = String(query.get("kind") || "generations")
    if (!["generations", "evals", "releases", "installs", "events", "worktrees"].includes(kind)) {
      return json(res, { ok: false, message: "未知账本: " + kind })
    }
    return json(res, await lifecycleList(kind))
  }
  if (method === "GET" && route === "/catalog") {
    return json(res, catalog())
  }
  if (method === "GET" && route.startsWith("/repo-recipes/")) {
    const recipeName = decodeURIComponent(route.slice("/repo-recipes/".length))
    if (!DRAFT_NAME.test(recipeName)) return json(res, { ok: false, message: "配方名不合法" })
    return json(res, readDraft(join(root, "recipes", recipeName)))
  }
  if (route.startsWith("/recipes/")) {
    const rest = route.slice("/recipes/".length)
    const validate = rest.endsWith("/validate")
    const name = decodeURIComponent(validate ? rest.slice(0, -"/validate".length) : rest)
    const file = draftPath(name)
    if (!file) return json(res, { ok: false, message: "草稿名不合法（仅限 workdir 内的 *.yml/*.yaml）" })
    if (method === "GET") return json(res, readDraft(file))
    if (method === "PUT") return json(res, writeDraft(file, body.text))
    if (method === "DELETE") {
      try {
        rmSync(file)
        return json(res, { ok: true })
      } catch (error) {
        return json(res, { ok: false, message: error instanceof Error ? error.message : String(error) })
      }
    }
    if (method === "POST" && validate) {
      const draft = readDraft(file)
      if (!draft.ok) return json(res, draft)
      const structural = validateRecipe(draft.text)
      if (!structural.ok || body.strict !== true) return json(res, { ...structural, strict: false })
      // Strict validation runs the real compiler against a throwaway dir.
      return json(res, startActionJob("pack", { recipe: norm(file), out: uniqueValidateDir(), source: body.source }))
    }
  }
  if (method === "POST" && route === "/jobs") {
    return json(res, startActionJob(String(body.action || ""), body))
  }
  if (method === "GET" && route.startsWith("/jobs/")) {
    const job = runner.get(route.slice("/jobs/".length))
    return json(res, job ? { ok: true, job } : { ok: false, message: "任务不存在" })
  }
  res.writeHead(404, { "content-type": "application/json" })
  res.end(JSON.stringify({ ok: false, message: `no route: ${method} ${route}` }))
}

function uniqueValidateDir() {
  mkdirSync(validateDir, { recursive: true })
  let out = ""
  do {
    out = join(validateDir, "check-" + Date.now().toString(36) + "-" + Math.floor(Math.random() * 1e4).toString(36))
  } while (existsSync(out))
  return norm(out)
}

function startActionJob(action, body) {
  if (!action) return { ok: false, message: "缺少 action" }
  const running = runner.runningId()
  if (running) return { ok: false, message: `已有任务在运行（并发上限 1）: ${running}` }
  const exe = resolveStudioExe()
  if (!exe) return { ok: false, message: "未找到 vivy-studio.exe（先运行 just studio）" }
  let resolved = body
  if (action === "pack") {
    const recipe = resolveRecipeArg(body.recipe)
    if (!recipe) return { ok: false, message: "Recipe 需是草稿名、recipes/<name> 或草稿目录下已有文件" }
    resolved = { ...body, recipe }
  }
  const built = buildLifecycleArgs(root, action, resolved)
  if (built.error) return { ok: false, message: built.error }
  const job = runner.start(exe, action, built.args)
  return { ok: true, id: job.id, action: job.action }
}

async function handleRoute(req, res) {
  try {
    const url = new URL(req.url || "/", "http://x")
    if (url.pathname.startsWith(apiPrefix)) {
      await handleApi(req, res, url.pathname.slice(apiPrefix.length) || "/")
      return
    }
    res.writeHead(404, { "content-type": "application/json" })
    res.end(JSON.stringify({ ok: false, message: "not found" }))
  } catch (error) {
    json(res, { ok: false, message: error instanceof Error ? error.message : String(error) })
  }
}

export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "prefix",
        path: "/dsh-species-workbench",
        handler: handleRoute,
      }),
    "dsh-species-workbench: species inspect + ledger + recipe drafts + lifecycle jobs API",
  )
  ctx.effect(() => runner.dispose, "dsh-species-workbench: terminate running lifecycle jobs")
}
