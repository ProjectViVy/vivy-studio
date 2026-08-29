/**
 * DSH Plugin Hub — Vivy Studio source-tree install path.
 *
 * When the active profile is `vivy-studio` and `vivySourceInstall` is enabled,
 * community plugins are installed into the Vivy repository under `studio/` and
 * registered as `file:` dependencies + DSH bundles in the Vivy Studio profile,
 * keeping plugin assets under version control alongside Vivy instead of
 * scattering them under `DSH_HOME`.
 *
 * Two source flows:
 *  - clone flow: GitHub repositories are `git clone`d into `studio/<slug>/`;
 *  - repack flow: npm packages are downloaded via `npm pack` and unpacked into
 *    `studio/<dir>/` as a source directory.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { loadSettings } from '../settings.ts'
import { githubRepoOf, githubTarget, profileDirectory, validPackageName } from '../profile/profile.ts'
import { removeLoadedEntry, type LoaderHandle } from '../loader.ts'
import { addPendingRestart, clearPendingRestart } from '../profile/pending-restart.ts'
import type { InstallResult, InstallTask } from './install-types.ts'

export interface VivySourcePlugin {
  name: string
  repo: string
  localPath: string
  installedAt: string
}

export interface VivySourceRegistry {
  plugins: VivySourcePlugin[]
}

/** Profile-local registry of plugins that were installed into the Vivy source tree. */
export function vivySourceRegistryFile(profile: string): string {
  return join(profileDirectory(profile), 'vivy-source-plugins.json')
}

/** Read the registry; missing/corrupt files return an empty registry. */
export function readVivySourceRegistry(profile: string): VivySourceRegistry {
  try {
    const raw = JSON.parse(readFileSync(vivySourceRegistryFile(profile), 'utf8')) as unknown
    if (raw && typeof raw === 'object' && Array.isArray((raw as VivySourceRegistry).plugins)) {
      return raw as VivySourceRegistry
    }
  } catch {
    /* ignore missing/corrupt */
  }
  return { plugins: [] }
}

/** Write the registry; failures are swallowed (install already succeeded). */
export function writeVivySourceRegistry(profile: string, registry: VivySourceRegistry): void {
  try {
    writeFileSync(vivySourceRegistryFile(profile), `${JSON.stringify(registry, null, 2)}\n`)
  } catch {
    /* best effort */
  }
}

/** Whether the current profile + setting should use the Vivy source install path. */
export function isVivySourceInstallEnabled(profile: string): boolean {
  if (profile !== 'vivy-studio') return false
  return loadSettings(profile).vivySourceInstall !== false
}

/** Locate the Vivy repository root. */
export function resolveVivyRoot(): string | null {
  const envRoot = process.env.VIVY_ROOT
  if (envRoot) {
    const root = resolve(envRoot)
    if (existsSync(join(root, 'studio'))) return root
  }
  // Heuristic: DSH_HOME is inside the Vivy repo as <repo>/data/studio-home.
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const heuristic = resolve(dshHome, '..', '..')
  if (existsSync(join(heuristic, 'studio'))) return heuristic
  return null
}

/** Turn `owner/repo` into a safe directory name under `studio/`. */
export function sourcePluginDirName(repo: string): string {
  return repo
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-|-$/g, '')
}

function toUnixPath(p: string): string {
  return sep === '\\' ? p.replace(/\\/g, '/') : p
}

function pushTaskLine(task: InstallTask | undefined, line: string): void {
  if (!task) return
  const text = line.trimEnd()
  if (!text) return
  // Keep same pattern as task-queue.ts: prepend to lines, cap length
  if (text !== task.lines[0]) {
    task.lines.unshift(text)
    if (task.lines.length > 200) task.lines.length = 200
  }
  if (task.status === 'running' && task.progress < 85) {
    task.progress = Math.max(task.progress, 6 + Math.min(79, task.lines.length * 2))
  }
}

function runCommand(
  file: string,
  args: string[],
  cwd: string,
  task?: InstallTask,
  timeoutMs = 5 * 60 * 1000,
  useShell?: boolean,
): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; error?: string }> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    let child: ReturnType<typeof spawn>
    // shell 由调用方决定：git 走原生 spawn（不经 cmd，保证带空格参数不被拆词），
    // pnpm/npm/tar 这类 .cmd 包装在 Windows 上仍必须经 shell 解析
    const useShellFinal = useShell ?? process.platform === 'win32'

    try {
      child = spawn(file, args, {
        cwd,
        shell: useShellFinal,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      pushTaskLine(task, `[error] ${message}`)
      resolve({ exitCode: null, stdout, stderr, timedOut: false, error: message })
      return
    }

    const timer = setTimeout(() => {
      timedOut = true
      try {
        if (process.platform === 'win32' && child.pid !== undefined) {
          spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' }).unref()
        } else if (child.pid !== undefined) {
          process.kill(-child.pid, 'SIGKILL')
        } else {
          child.kill('SIGKILL')
        }
      } catch { /* ignore */ }
    }, timeoutMs)

    const finish = (result: { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; error?: string }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stdout = (stdout + text).slice(-64 * 1024)
      for (const line of text.split(/\r?\n|\r/)) pushTaskLine(task, line)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stderr = (stderr + text).slice(-64 * 1024)
      for (const line of text.split(/\r?\n|\r/)) pushTaskLine(task, line)
    })
    child.once('error', (error) => {
      const message = error.message
      pushTaskLine(task, `[error] ${message}`)
      finish({ exitCode: null, stdout, stderr, timedOut: false, error: message })
    })
    child.once('close', (code) => {
      finish({ exitCode: code, stdout, stderr, timedOut, error: timedOut ? 'timed out' : undefined })
    })
  })
}

/**
 * git 专用 runner：原生 spawn（不经 shell）。Windows 上 git 是真实 .exe，
 * 无需 cmd 解析；带空格的消息/路径参数若有 shell 会被拆词破坏（DEP0190），
 * 这里固定 shell=false。
 */
function runGit(
  args: string[],
  cwd: string,
  task?: InstallTask,
  timeoutMs = 5 * 60 * 1000,
): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; error?: string }> {
  return runCommand('git', args, cwd, task, timeoutMs, false)
}

/** Ensure a directory exists for cloning. */
function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true })
}

/** Read and validate the cloned plugin's package.json. */
function readPluginManifest(pluginDir: string): { name: string; hasBuild: boolean; hasBundle: boolean } {
  const pkgPath = join(pluginDir, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
    name?: string
    scripts?: { build?: string }
    dsh?: { bundle?: { patch?: string } }
  }
  const name = typeof pkg.name === 'string' && pkg.name ? pkg.name : null
  if (!name) throw new Error('cloned plugin package.json has no valid name')
  return {
    name,
    hasBuild: typeof pkg.scripts?.build === 'string',
    hasBundle: typeof pkg.dsh?.bundle?.patch === 'string',
  }
}

function readProfileManifest(profile: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(profileDirectory(profile), 'package.json'), 'utf8')) as Record<string, unknown>
}

function writeProfileManifest(profile: string, manifest: Record<string, unknown>): void {
  writeFileSync(join(profileDirectory(profile), 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
}

/**
 * Verify the plugin's declared entry file exists in the cloned source directory.
 * Without a build script a git distribution may lack built output, which would
 * crash the host on next load — fail the install now so the caller can roll back.
 */
function verifySourceEntry(pluginDir: string): string | null {
  let pkg: { main?: unknown; exports?: unknown }
  try {
    pkg = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8')) as { main?: unknown; exports?: unknown }
  } catch {
    return null
  }
  const dot = (pkg.exports as Record<string, unknown> | undefined)?.['.']
  const resolved = typeof dot === 'string' ? dot
    : dot !== null && typeof dot === 'object'
      ? (dot as Record<string, unknown>).default
      : undefined
  const entry = typeof resolved === 'string' ? resolved : typeof pkg.main === 'string' ? pkg.main : 'index.js'
  if (entry.startsWith('./') || entry.startsWith('../') || entry.startsWith('/')) {
    const safe = entry.replace(/^\.?\//, '')
    try {
      return existsSync(join(pluginDir, safe)) ? null : entry
    } catch {
      return entry
    }
  }
  return null
}

/** Clone a repo into the Vivy source tree, or pull if already present and clean. */
export async function cloneOrUpdateVivySourceRepo(
  repo: string,
  pluginDir: string,
  task?: InstallTask,
): Promise<void> {
  // `git+https://...` is a pnpm specifier, not a git CLI URL — git needs a
  // plain https:// remote. Validate the repo shape first, then build the URL.
  const repoId = githubRepoOf(repo)
  if (!repoId) throw new Error(`invalid GitHub repo: ${repo}`)
  const target = `https://github.com/${repoId}.git`

  if (existsSync(join(pluginDir, '.git'))) {
    // Check for dirty working tree
    const status = await runGit(['status', '--porcelain'], pluginDir, task, 30_000)
    if (status.exitCode !== 0) throw new Error(`git status failed in ${pluginDir}`)
    if (status.stdout.trim()) {
      throw new Error(`directory ${pluginDir} has local changes; commit or stash before update`)
    }
    pushTaskLine(task, `[vivy-source] updating ${repo} in ${pluginDir}`)
    const pull = await runGit(['pull'], pluginDir, task)
    if (pull.exitCode !== 0) throw new Error(`git pull failed for ${repo}`)
    return
  }

  if (existsSync(pluginDir)) {
    let entries: string[] = []
    try {
      entries = readdirSync(pluginDir)
    } catch { /* treat unreadable as non-empty to be safe */ }
    if (entries.length > 0) {
      throw new Error(`directory ${pluginDir} already exists and is not a git repo`)
    }
  }

  ensureDir(dirname(pluginDir))
  pushTaskLine(task, `[vivy-source] cloning ${repo} into ${pluginDir}`)
  const clone = await runGit(['clone', target, pluginDir], resolveVivyRoot() ?? pluginDir, task)
  if (clone.exitCode !== 0) throw new Error(`git clone failed for ${repo}`)
}

/**
 * npm 包下载改装流程：`npm pack <pkg>` 下载 tarball → 解压 → 移入 Vivy 源码树。
 * 这样纯 npm 分发（无 GitHub 仓库 / 仓库未知）的插件也能作为源码目录被管理。
 * 已存在目录时整体覆盖（更新语义）；新安装由调用方的 created 回滚兜底。
 */
export async function downloadNpmToVivySource(
  pkg: string,
  pluginDir: string,
  vivyRoot: string,
  task?: InstallTask,
): Promise<void> {
  const tmp = join(tmpdir(), `vivy-npm-${Date.now()}-${Math.floor(Math.random() * 1e6)}`)
  ensureDir(tmp)
  try {
    pushTaskLine(task, `[vivy-source] downloading npm package ${pkg}`)
    const pack = await runCommand('npm', ['pack', pkg, '--pack-destination', tmp], vivyRoot, task)
    if (pack.exitCode !== 0) throw new Error(`npm pack failed for ${pkg}`)

    const tarball = readdirSync(tmp).find((f) => f.endsWith('.tgz'))
    if (!tarball) throw new Error(`npm pack produced no tarball for ${pkg}`)

    const extractDir = join(tmp, 'extract')
    ensureDir(extractDir)
    pushTaskLine(task, `[vivy-source] unpacking ${tarball}`)
    const untar = await runCommand('tar', ['-xzf', join(tmp, tarball), '-C', extractDir], tmp, task)
    if (untar.exitCode !== 0) throw new Error(`failed to unpack ${tarball} (system tar unavailable?)`)

    const unpacked = join(extractDir, 'package')
    if (!existsSync(unpacked)) throw new Error(`npm package ${pkg} unpacked without a package/ directory`)

    if (existsSync(pluginDir)) rmSync(pluginDir, { recursive: true, force: true })
    ensureDir(dirname(pluginDir))
    cpSync(unpacked, pluginDir, { recursive: true })
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}

/** 把命令失败的关键输出（stdout/stderr 尾部）并入错误消息，便于用户定位安装失败原因。 */
function failureDetail(result: { stdout: string; stderr: string }): string {
  const tail = `${result.stderr}\n${result.stdout}`.trim().split(/\r?\n/).slice(-8).join('\n')
  return tail ? `\n${tail}` : ''
}

/** Build a Vivy-source plugin if it declares a build script. */
export async function buildVivySourcePlugin(pluginDir: string, task?: InstallTask): Promise<void> {
  const manifest = readPluginManifest(pluginDir)
  if (!manifest.hasBuild) {
    pushTaskLine(task, '[vivy-source] no build script, skipping build')
    return
  }
  pushTaskLine(task, '[vivy-source] installing plugin dependencies')
  const install = await runCommand('pnpm', ['install'], pluginDir, task)
  if (install.exitCode !== 0) throw new Error(`plugin dependency install failed${failureDetail(install)}`)
  pushTaskLine(task, '[vivy-source] building plugin')
  const build = await runCommand('npm', ['run', 'build'], pluginDir, task)
  if (build.exitCode !== 0) throw new Error(`plugin build failed${failureDetail(build)}`)
}

/** Add or update a plugin in the Vivy Studio profile as a file: dependency + bundle. */
export async function installVivySourcePlugin(
  profile: string,
  target: string,
  task?: InstallTask,
): Promise<{ packageName: string; pluginDir: string; repo: string; needsRestart: boolean }> {
  // 双流程判定：GitHub 仓库 → 克隆流程；npm 包名 → 下载改装流程；两者皆非 → 拒绝。
  const repo = githubRepoOf(target)
  const pkg = repo === null && validPackageName(target) ? target : null
  if (repo === null && pkg === null) {
    throw new Error(`vivy-source install target must be a GitHub repository or an npm package name: ${target}`)
  }

  const vivyRoot = resolveVivyRoot()
  if (!vivyRoot) throw new Error('cannot locate Vivy repository root (set VIVY_ROOT or ensure DSH_HOME is inside the repo)')

  const dirName = repo !== null ? sourcePluginDirName(repo) : sourcePluginDirName(pkg!)
  const pluginDir = join(vivyRoot, 'studio', dirName)

  // Track whether pluginDir is a brand-new directory so a failure below (missing
  // bundle, build failure, pnpm failure) can roll it back instead of leaving a
  // half-installed directory in the Vivy source tree.
  const created = !existsSync(pluginDir)
  try {
    if (repo !== null) {
      await cloneOrUpdateVivySourceRepo(repo, pluginDir, task)
    } else {
      await downloadNpmToVivySource(pkg!, pluginDir, vivyRoot, task)
    }

    const manifest = readPluginManifest(pluginDir)
    if (!manifest.hasBundle) {
      throw new Error(`plugin ${manifest.name} does not declare a dsh.bundle; cannot load as a DSH bundle`)
    }

    if (repo !== null) {
      // git 源：仓库通常无构建产物，需本地构建
      await buildVivySourcePlugin(pluginDir, task)
    } else {
      // npm 源：发布物即最终构建产物（打包时构建配置文件不会进入 tarball，
      // 本地 build 必然失败），跳过构建，直接校验入口
      pushTaskLine(task, '[vivy-source] npm package ships built output, skipping build')
    }

    const missingEntry = verifySourceEntry(pluginDir)
    if (missingEntry !== null) {
      const sourceLabel = repo !== null ? 'git distribution' : 'npm package'
      throw new Error(`plugin ${manifest.name} has no build output (entry file ${missingEntry} missing in the ${sourceLabel})`)
    }

    const profileManifest = readProfileManifest(profile)
    const deps = (profileManifest.dependencies as Record<string, string> | undefined) ?? {}
    const bundles = ((profileManifest.dsh as Record<string, unknown> | undefined)?.profile as Record<string, unknown> | undefined)?.bundles as string[] | undefined ?? []

    const fileSpec = `file:${toUnixPath(pluginDir)}`
    deps[manifest.name] = fileSpec
    if (!bundles.includes(manifest.name)) bundles.push(manifest.name)

    profileManifest.dependencies = deps
    profileManifest.dsh = {
      ...(profileManifest.dsh as Record<string, unknown> | undefined),
      profile: {
        ...(((profileManifest.dsh as Record<string, unknown> | undefined)?.profile as Record<string, unknown> | undefined)),
        bundles,
      },
    }
    writeProfileManifest(profile, profileManifest)

    pushTaskLine(task, '[vivy-source] running pnpm install in profile')
    const pnpm = await runCommand('pnpm', ['install'], profileDirectory(profile), task)
    if (pnpm.exitCode !== 0) throw new Error('pnpm install in Vivy Studio profile failed')

    const registry = readVivySourceRegistry(profile)
    const existingIndex = registry.plugins.findIndex((p) => p.name === manifest.name)
    const entry: VivySourcePlugin = {
      name: manifest.name,
      // npm 包用 `npm:<name>` 标识来源，与 GitHub 仓库（owner/repo）区分
      repo: repo !== null ? repo : `npm:${pkg}`,
      localPath: join('studio', dirName),
      installedAt: new Date().toISOString(),
    }
    if (existingIndex >= 0) registry.plugins[existingIndex] = entry
    else registry.plugins.push(entry)
    writeVivySourceRegistry(profile, registry)

    // 自动提交（设置开启时）：把新装/更新的源码目录提交进 vivy-studio 子模块，
    // 保持源码树干净留痕；只提交该插件路径，不触碰其他改动
    if (loadSettings(profile).vivySourceAutoCommit !== false) {
      const sha = await commitVivySourceChange(
        vivyRoot,
        toUnixPath(join('studio', dirName)),
        `chore(hub): install plugin ${manifest.name} source`,
        task,
      )
      if (sha) pushTaskLine(task, `[vivy-source] committed install to vivy-studio repo (${sha})`)
    }

    return { packageName: manifest.name, pluginDir, repo: repo ?? `npm:${pkg}`, needsRestart: true }
  } catch (error) {
    if (created && existsSync(pluginDir)) {
      try {
        rmSync(pluginDir, { recursive: true, force: true })
      } catch { /* best effort cleanup */ }
    }
    throw error
  }
}

/**
 * Remove a Vivy-source plugin from the profile — deletion closure: the source
 * directory under `studio/` is deleted too, and (when auto-commit is enabled)
 * the removal is committed into the vivy-studio submodule.
 */
export async function removeVivySourcePlugin(
  profile: string,
  target: string,
  task?: InstallTask,
): Promise<{ removed: boolean; packageName?: string; sourceDeleted?: boolean; commitSha?: string | null }> {
  const registry = readVivySourceRegistry(profile)
  const repo = githubRepoOf(target)

  // Find by repo or by package name
  let entry = registry.plugins.find((p) => p.repo === repo || p.name === target)
  if (!entry && repo) {
    // Maybe target is an npm package name that was installed from a repo
    entry = registry.plugins.find((p) => repo.endsWith(p.repo.split('/')[1] ?? ''))
  }

  const profileManifest = readProfileManifest(profile)
  const deps = (profileManifest.dependencies as Record<string, string> | undefined) ?? {}
  const bundles = (((profileManifest.dsh as Record<string, unknown> | undefined)?.profile as Record<string, unknown> | undefined)?.bundles as string[] | undefined) ?? []

  let packageName: string | undefined
  let entryLocalPath: string | null = null
  if (entry) {
    packageName = entry.name
    entryLocalPath = entry.localPath ?? null
  } else {
    // Try to find a dependency whose spec points into Vivy's studio directory
    const vivyRoot = resolveVivyRoot()
    if (vivyRoot) {
      for (const [name, spec] of Object.entries(deps)) {
        if (spec.startsWith('file:')) {
          const depPath = resolve(profileDirectory(profile), spec.slice(5))
          if (depPath.toLowerCase().startsWith(join(vivyRoot, 'studio').toLowerCase())) {
            packageName = name
            break
          }
        }
      }
    }
  }

  if (!packageName || !deps[packageName]) {
    return { removed: false }
  }

  pushTaskLine(task, `[vivy-source] removing ${packageName} from profile`)
  delete deps[packageName]
  const newBundles = bundles.filter((b) => b !== packageName)
  profileManifest.dependencies = deps
  profileManifest.dsh = {
    ...(profileManifest.dsh as Record<string, unknown> | undefined),
    profile: {
      ...(((profileManifest.dsh as Record<string, unknown> | undefined)?.profile as Record<string, unknown> | undefined)),
      bundles: newBundles,
    },
  }
  writeProfileManifest(profile, profileManifest)

  const pnpm = await runCommand('pnpm', ['install'], profileDirectory(profile), task)
  if (pnpm.exitCode !== 0) throw new Error('pnpm install failed after removing plugin')

  registry.plugins = registry.plugins.filter((p) => p.name !== packageName)
  writeVivySourceRegistry(profile, registry)

  // —— 卸载闭环：profile / 注册表移除成功后，删除 studio/ 下的源码目录 ——
  // 放在持久化之后执行，避免半吊子状态（profile 已改但源码未删）
  let sourceDeleted = false
  let commitSha: string | null = null
  const vivyRoot = resolveVivyRoot()
  if (vivyRoot) {
    const resolved = resolveVivySourceDir(profile, packageName, entryLocalPath)
    if (resolved) {
      sourceDeleted = await deleteVivySourcePluginDir(vivyRoot, resolved.rel, task)
      if (sourceDeleted && loadSettings(profile).vivySourceAutoCommit !== false) {
        commitSha = await commitVivySourceChange(
          vivyRoot,
          resolved.rel,
          `chore(hub): remove plugin ${packageName} source`,
          task,
        )
        if (commitSha) pushTaskLine(task, `[vivy-source] committed removal to vivy-studio repo (${commitSha})`)
      }
    } else {
      pushTaskLine(task, `[vivy-source] cannot resolve source directory for ${packageName}; source kept`)
    }
  } else {
    pushTaskLine(task, '[vivy-source] cannot locate Vivy repository root; source directory kept')
  }

  return { removed: true, packageName, sourceDeleted, commitSha }
}

/** Update a Vivy-source plugin: GitHub sources pull latest, npm sources re-download. */
export async function updateVivySourcePlugin(
  profile: string,
  target: string,
  task?: InstallTask,
): Promise<{ packageName: string; needsRestart: boolean }> {
  const repo = githubRepoOf(target)
  const registry = readVivySourceRegistry(profile)
  const entry = repo ? registry.plugins.find((p) => p.repo === repo) : registry.plugins.find((p) => p.name === target)
  if (!entry) throw new Error('plugin is not managed as a Vivy source install')

  const vivyRoot = resolveVivyRoot()
  if (!vivyRoot) throw new Error('cannot locate Vivy repository root')

  const pluginDir = resolve(vivyRoot, entry.localPath)
  if (entry.repo.startsWith('npm:')) {
    // npm 源：重新下载最新版本并覆盖源码目录（npm 发布物自带构建产物，无需重建）
    const pkg = entry.repo.slice(4)
    pushTaskLine(task, `[vivy-source] updating npm package ${pkg}`)
    await downloadNpmToVivySource(pkg, pluginDir, vivyRoot, task)
  } else {
    await cloneOrUpdateVivySourceRepo(entry.repo, pluginDir, task)
    await buildVivySourcePlugin(pluginDir, task)
  }

  const profileManifest = readProfileManifest(profile)
  const deps = (profileManifest.dependencies as Record<string, string> | undefined) ?? {}
  deps[entry.name] = `file:${toUnixPath(pluginDir)}`
  profileManifest.dependencies = deps
  writeProfileManifest(profile, profileManifest)

  const pnpm = await runCommand('pnpm', ['install'], profileDirectory(profile), task)
  if (pnpm.exitCode !== 0) throw new Error('pnpm install failed after update')

  if (loadSettings(profile).vivySourceAutoCommit !== false) {
    const sha = await commitVivySourceChange(vivyRoot, toUnixPath(entry.localPath), `chore(hub): update plugin ${entry.name} source`, task)
    if (sha) pushTaskLine(task, `[vivy-source] committed update to vivy-studio repo (${sha})`)
  }

  return { packageName: entry.name, needsRestart: true }
}

/** List Vivy-source plugins currently registered in the profile. */
export function listVivySourcePlugins(profile: string): VivySourcePlugin[] {
  return readVivySourceRegistry(profile).plugins
}

/**
 * 卸载闭环：解析插件在 Vivy 源码树里的目录。
 * 优先用注册表的 `localPath`；老安装/注册表缺失时回退扫 profile 依赖里
 * `file:` 指向 studio/ 的条目。只认 studio/ 子模块工作树内的路径，其余返回 null。
 * 返回 `{ dir, rel }`：dir 是绝对路径，rel 是相对 Vivy 仓库根的 `studio/<slug>` 形式。
 */
export function resolveVivySourceDir(
  profile: string,
  packageName: string,
  entryLocalPath: string | null,
): { dir: string; rel: string } | null {
  const vivyRoot = resolveVivyRoot()
  if (!vivyRoot) return null
  const studioRoot = join(vivyRoot, 'studio')

  if (entryLocalPath) {
    const dir = resolve(vivyRoot, entryLocalPath)
    if (dir.toLowerCase().startsWith(studioRoot.toLowerCase())) {
      const slug = entryLocalPath.replace(/^studio[/\\]+/, '').replace(/[/\\]+/g, '/')
      if (slug) return { dir, rel: `studio/${slug}` }
    }
  }

  // 回退：注册表缺失（旧安装）时按依赖里的 file: spec 定位
  try {
    const profileManifest = readProfileManifest(profile)
    const deps = (profileManifest.dependencies as Record<string, string> | undefined) ?? {}
    const spec = deps[packageName]
    if (typeof spec === 'string' && spec.startsWith('file:')) {
      const depPath = resolve(profileDirectory(profile), spec.slice(5))
      if (depPath.toLowerCase().startsWith(studioRoot.toLowerCase())) {
        const slug = depPath.slice(studioRoot.length).replace(/^[/\\]+/, '').replace(/[/\\]+/g, '/')
        if (slug) return { dir: depPath, rel: `studio/${slug}` }
      }
    }
  } catch { /* 解析失败当作解析不到 */ }
  return null
}

/**
 * 自动提交：在 vivy-studio 子模块里把某条插件路径的改动提交掉。
 * 路径限定（`-- <rel>`），绝不触碰子模块里的其他改动；不是 git 仓库、
 * 无相关改动或提交失败时只记警告并返回 null —— 提交失败绝不能让安装/卸载失败。
 * 返回提交的短 SHA（成功后）。
 */
export async function commitVivySourceChange(
  vivyRoot: string,
  repoRel: string,
  message: string,
  task?: InstallTask,
): Promise<string | null> {
  const submodule = join(vivyRoot, 'studio')
  // git 在子模块根目录执行：rel 转成相对子模块的路径（去掉 `studio/` 前缀）
  const rel = repoRel.replace(/^studio[/\\]+/, '').replace(/\\/g, '/')
  if (!rel) return null

  const probe = await runGit(['rev-parse', '--is-inside-work-tree'], submodule, task, 15_000)
  if (probe.exitCode !== 0) {
    pushTaskLine(task, `[vivy-source] studio/ is not a git work tree; skipped auto-commit (${rel})`)
    return null
  }
  const add = await runGit(['add', '--', rel], submodule, task, 30_000)
  if (add.exitCode !== 0) {
    pushTaskLine(task, `[vivy-source] git add failed for ${rel}; skipped auto-commit: ${add.stderr.trim().split(/\r?\n/).slice(-2).join(' ')}`)
    return null
  }
  // exit 0 = 该路径无暂存差异（无改动/从未跟踪且已不存在）→ 不产生空提交
  const staged = await runGit(['diff', '--cached', '--quiet', '--', rel], submodule, task, 15_000)
  if (staged.exitCode === 0) {
    pushTaskLine(task, `[vivy-source] no tracked change for ${rel}; nothing to commit`)
    return null
  }
  // 显式关掉 GPG 签名：无人值守环境里签名会挂起/失败，本提交只是本地留痕
  const commit = await runGit(
    ['-c', 'commit.gpgsign=false', 'commit', '-m', message],
    submodule, task, 60_000,
  )
  if (commit.exitCode !== 0) {
    pushTaskLine(task, `[vivy-source] auto-commit failed: ${commit.stderr.trim().split(/\r?\n/).slice(-3).join(' ')}`)
    return null
  }
  const sha = await runGit(['rev-parse', '--short', 'HEAD'], submodule, task, 15_000)
  return sha.exitCode === 0 ? sha.stdout.trim() : null
}

/** 删除 Vivy 源码目录（卸载闭环）：删掉 studio/<slug> 整棵目录。
 *  克隆流程的目录自带嵌套 .git，存在未提交改动时先打警告行（改动随目录一并删除）。 */
export async function deleteVivySourcePluginDir(
  vivyRoot: string,
  repoRel: string,
  task?: InstallTask,
): Promise<boolean> {
  const dir = resolve(vivyRoot, repoRel)
  if (!existsSync(dir)) {
    pushTaskLine(task, `[vivy-source] source directory ${toUnixPath(dir)} not found; nothing to delete`)
    return false
  }
  if (existsSync(join(dir, '.git'))) {
    const status = await runGit(['status', '--porcelain'], dir, task, 15_000)
    if (status.exitCode === 0 && status.stdout.trim()) {
      pushTaskLine(task, `[vivy-source] warning: ${toUnixPath(dir)} has uncommitted changes; they are deleted together with the plugin source`)
    }
  }
  pushTaskLine(task, `[vivy-source] deleting source directory ${toUnixPath(dir)}`)
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch (error) {
    throw new Error(`failed to delete plugin source directory ${toUnixPath(dir)}: ${error instanceof Error ? error.message : String(error)}`)
  }
  return true
}

function markTaskFailed(task: InstallTask | undefined, message: string): InstallResult {
  if (task && task.status !== 'cancelled') {
    task.status = 'failed'
    task.exitCode = null
    task.progress = 0
    pushTaskLine(task, `[vivy-source error] ${message}`)
  }
  return { exitCode: 1, timedOut: false, error: message, stdout: '', stderr: message }
}

function markTaskDone(task: InstallTask | undefined, needsRestart: boolean): InstallResult {
  if (task && task.status !== 'cancelled') {
    task.status = 'done'
    task.exitCode = 0
    task.progress = 100
    task.needsRestart = needsRestart
  }
  return { exitCode: 0, timedOut: false, error: null, stdout: '', stderr: '' }
}

/**
 * Run one add / remove / update mutation through the Vivy source-tree path.
 * Returns null when the path does not apply (wrong profile or setting off),
 * so the caller can fall back to the normal `dsh plugin` path.
 */
export async function runVivySourceMutation(options: {
  action: 'add' | 'remove' | 'update'
  profile: string
  target: string
  task?: InstallTask
  displayTarget?: string
  uninstallLoader?: LoaderHandle
}): Promise<InstallResult | null> {
  if (!isVivySourceInstallEnabled(options.profile)) return null
  const { action, profile, target, task, displayTarget, uninstallLoader } = options

  try {
    if (action === 'add' || action === 'update') {
      const result = action === 'update'
        ? await updateVivySourcePlugin(profile, target, task)
        : await installVivySourcePlugin(profile, target, task)
      addPendingRestart(displayTarget ?? target, 'install')
      return markTaskDone(task, result.needsRestart)
    }

    if (action === 'remove') {
      const result = await removeVivySourcePlugin(profile, target, task)
      if (!result.removed || !result.packageName) {
        return null // not a Vivy-source plugin; let normal path try
      }
      const removedFromLoader = uninstallLoader
        ? await removeLoadedEntry(uninstallLoader, result.packageName)
        : false
      if (removedFromLoader) clearPendingRestart(displayTarget ?? target)
      else addPendingRestart(displayTarget ?? target, 'uninstall')
      return markTaskDone(task, !removedFromLoader)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return markTaskFailed(task, message)
  }

  return null
}
