/**
 * DSH Plugin Hub — Vivy source-tree path unit tests.
 *
 * Covers the uninstall closure: resolving the plugin source directory under
 * `studio/`, deleting it, and the path-scoped auto-commit into the
 * vivy-studio submodule. Everything runs against temporary directories and
 * locally created git repos — no network, no real profile.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  commitVivySourceChange,
  deleteVivySourcePluginDir,
  readVivySourceRegistry,
  resolveVivySourceDir,
  vivySourceRegistryFile,
  writeVivySourceRegistry,
} from '../src/server/services/install/vivy-source.ts'

/** 每个测试用独立临时 Vivy 仓库根（含 studio/）+ 独立 DSH_HOME，互不污染。 */
interface Sandbox {
  root: string
  studio: string
  profileDir: string
}

/** 建立临时 Vivy 仓库（VIVY_ROOT=<root>，studio/ 存在，DSH_HOME 在 <root>/data/studio-home）。 */
function makeSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'dsh-hub-vivy-'))
  const studio = join(root, 'studio')
  mkdirSync(studio, { recursive: true })
  process.env.VIVY_ROOT = root
  const profileDir = join(root, 'data', 'studio-home', 'profiles', 'vivy-studio')
  mkdirSync(profileDir, { recursive: true })
  process.env.DSH_HOME = join(root, 'data', 'studio-home')
  return { root, studio, profileDir }
}

async function withSandbox<T>(run: (sb: Sandbox) => T | Promise<T>): Promise<T> {
  const sb = makeSandbox()
  const prevRoot = process.env.VIVY_ROOT
  const prevHome = process.env.DSH_HOME
  try {
    return await run(sb)
  } finally {
    if (prevRoot === undefined) delete process.env.VIVY_ROOT
    else process.env.VIVY_ROOT = prevRoot
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    rmSync(sb.root, { recursive: true, force: true })
  }
}

function unixPath(p: string): string {
  return p.replace(/\\/g, '/')
}

function writeProfile(sb: Sandbox, deps: Record<string, string>): void {
  writeFileSync(join(sb.profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-vivy-studio',
    private: true,
    dependencies: deps,
    dsh: { profile: { bundles: [] } },
  }, null, 2))
}

function writeRegistry(sb: Sandbox, name: string, localPath: string | undefined, repo: string): void {
  writeFileSync(vivySourceRegistryFile('vivy-studio'), JSON.stringify({
    plugins: [{ name, repo, localPath, installedAt: '2026-01-01T00:00:00.000Z' }],
  }, null, 2))
}

function git(args: string[], cwd: string): { status: number; stdout: string; stderr: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

/** 初始化一个可直接 commit 的本地仓库（预设 user 身份，避免依赖全局配置）。 */
function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true })
  assert.equal(git(['init'], dir).status, 0, 'git init should succeed')
  git(['config', 'user.name', 'hub-test'], dir)
  git(['config', 'user.email', 'hub-test@example.invalid'], dir)
}

/** 轻量 InstallTask：只需 pushTaskLine 用到的 status + lines 两个字段。 */
function fakeTask(): { status: string; lines: string[] } {
  return { status: 'running', lines: [] }
}

test('resolveVivySourceDir：优先用注册表 localPath，只认 studio/ 内路径', () =>
  withSandbox((sb) => {
    mkdirSync(join(sb.studio, 'dsh-foo'), { recursive: true })
    writeProfile(sb, { 'dsh-foo': `file:${unixPath(join(sb.studio, 'dsh-foo'))}` })
    writeRegistry(sb, 'dsh-foo', 'studio/dsh-foo', 'owner/foo')

    const hit = resolveVivySourceDir('vivy-studio', 'dsh-foo', 'studio/dsh-foo')
    assert.ok(hit, 'registry localPath should resolve')
    assert.equal(hit!.rel, 'studio/dsh-foo')
    assert.equal(hit!.dir.toLowerCase(), join(sb.studio, 'dsh-foo').toLowerCase())

    // 指向 studio/ 之外的 localPath 拒绝（防删源码树外）；该包不在依赖里，回退也不命中
    const outside = resolveVivySourceDir('vivy-studio', 'dsh-outside', '../outside/dsh-foo')
    assert.equal(outside, null)
  }))

test('resolveVivySourceDir：注册表缺失时回退到 profile 依赖里的 file: spec', () =>
  withSandbox((sb) => {
    mkdirSync(join(sb.studio, 'dsh-legacy'), { recursive: true })
    writeProfile(sb, { 'dsh-legacy': `file:${unixPath(join(sb.studio, 'dsh-legacy'))}` })

    const hit = resolveVivySourceDir('vivy-studio', 'dsh-legacy', null)
    assert.ok(hit, 'file: dep under studio/ should resolve')
    assert.equal(hit!.rel, 'studio/dsh-legacy')

    // 指向 studio/ 之外的 file: 依赖 → 不认
    const other = resolveVivySourceDir('vivy-studio', 'dsh-other', null)
    assert.equal(other, null)
  }))

test('commitVivySourceChange：路径限定提交 + 无改动不产生空提交', () =>
  withSandbox(async (sb) => {
    initRepo(sb.studio)
    // 无关的脏文件：提交必须不碰它
    writeFileSync(join(sb.studio, 'unrelated.txt'), 'dirty\n')

    mkdirSync(join(sb.studio, 'dsh-foo'), { recursive: true })
    writeFileSync(join(sb.studio, 'dsh-foo', 'package.json'), '{"name":"dsh-foo"}\n')

    const sha = await commitVivySourceChange(sb.root, 'studio/dsh-foo', 'test: commit plugin source')
    assert.ok(sha, 'commit should succeed')
    const log = git(['log', '--oneline', '-1'], sb.studio)
    assert.match(log.stdout, /test: commit plugin source/)
    assert.match(git(['ls-files', 'dsh-foo/package.json'], sb.studio).stdout, /dsh-foo\/package\.json/)

    // 无关改动保持未提交
    assert.match(git(['status', '--porcelain'], sb.studio).stdout, /unrelated\.txt/)

    // 再次提交同一路径：无新改动 → null（不产生空提交）
    const again = await commitVivySourceChange(sb.root, 'studio/dsh-foo', 'test: nothing to do')
    assert.equal(again, null)
    assert.equal(git(['log', '--oneline'], sb.studio).stdout.trim().split('\n').length, 1)
  }))

test('commitVivySourceChange：studio/ 不是 git 仓库时跳过（返回 null，不抛错）', () =>
  withSandbox(async (sb) => {
    mkdirSync(join(sb.studio, 'dsh-foo'), { recursive: true })
    writeFileSync(join(sb.studio, 'dsh-foo', 'package.json'), '{"name":"dsh-foo"}\n')
    const sha = await commitVivySourceChange(sb.root, 'studio/dsh-foo', 'test: skip')
    assert.equal(sha, null)
  }))

test('deleteVivySourcePluginDir：删除目录，嵌套 git 仓库的未提交改动给出警告行', () =>
  withSandbox(async (sb) => {
    // 克隆流程形态：目录内是嵌套 git 仓库且有未提交改动
    const dir = join(sb.studio, 'dsh-dirty')
    initRepo(dir)
    writeFileSync(join(dir, 'index.js'), 'console.log(1)\n')
    git(['add', '.'], dir)
    assert.equal(git(['commit', '-m', 'initial'], dir).status, 0)
    writeFileSync(join(dir, 'index.js'), 'console.log(2)\n') // 本地改动

    const task = fakeTask()
    const deleted = await deleteVivySourcePluginDir(sb.root, 'studio/dsh-dirty', task as never)
    assert.equal(deleted, true)
    assert.equal(existsSync(dir), false, 'source directory should be deleted')
    assert.ok(
      task.lines.some((l) => l.includes('uncommitted changes')),
      'dirty nested repo should produce a warning line',
    )

    // 目录不存在 → 返回 false 且不报错
    const missing = await deleteVivySourcePluginDir(sb.root, 'studio/never-existed', task as never)
    assert.equal(missing, false)
  }))

test('卸载闭环联调：源码目录被删、自动提交留痕、无关改动不受影响', () =>
  withSandbox(async (sb) => {
    initRepo(sb.studio)

    // 已安装的 vivy-source 插件：源码目录预先跟踪进子模块（base 提交）
    const src = join(sb.studio, 'dsh-foo')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'package.json'), '{"name":"dsh-foo"}\n')
    git(['add', '.'], sb.studio)
    assert.equal(git(['commit', '-m', 'base'], sb.studio).status, 0)

    // base 之后留下的无关脏改动：卸载提交必须不碰它
    writeFileSync(join(sb.studio, 'unrelated.txt'), 'mine\n')

    writeProfile(sb, { 'dsh-foo': `file:${unixPath(src)}` })
    writeRegistry(sb, 'dsh-foo', 'studio/dsh-foo', 'owner/foo')

    // 与 removeVivySourcePlugin 次序一致：先移除注册表条目，再删目录 + 提交
    const registry = readVivySourceRegistry('vivy-studio')
    registry.plugins = registry.plugins.filter((p) => p.name !== 'dsh-foo')
    writeVivySourceRegistry('vivy-studio', registry)

    const task = fakeTask()
    const deleted = await deleteVivySourcePluginDir(sb.root, 'studio/dsh-foo', task as never)
    assert.equal(deleted, true)
    assert.equal(existsSync(src), false)

    const sha = await commitVivySourceChange(sb.root, 'studio/dsh-foo', 'chore(hub): remove plugin dsh-foo source', task as never)
    assert.ok(sha)
    assert.match(git(['log', '--oneline', '-1'], sb.studio).stdout, /remove plugin dsh-foo source/)
    // 无关改动仍留在工作树（路径限定提交）
    assert.match(git(['status', '--porcelain'], sb.studio).stdout, /unrelated\.txt/)
  }))