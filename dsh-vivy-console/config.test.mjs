// Regression tests for the managed backend config (host half).
//
// Run from the repository root:
//   node --test studio/dsh-vivy-console/config.test.mjs
//
// The kernel decodes this file strictly. PROV-P1/P3 deleted
// `providers.bundle_dir` and the per-vendor `{env_key, default_model}`
// blocks, but this producer kept emitting them, so the managed backend
// aborted with "field bundle_dir not found in type config.Providers" before
// the listener opened and 总控台 reported a start that never happened. These
// tests pin the producer's shape so the console cannot drift from the config
// struct again.
import test from "node:test"
import assert from "node:assert/strict"

import { backendConfig } from "./index.js"

// Top-level sections the kernel's config struct declares. A new section here
// must be a deliberate kernel change, not an accident of this template.
const KNOWN_SECTIONS = ["server", "storage", "providers", "runtime", "tools"]

function sections(yaml) {
  return yaml
    .split("\n")
    .filter((line) => /^[A-Za-z_][\w-]*:/.test(line))
    .map((line) => line.slice(0, line.indexOf(":")))
}

// Direct keys of a top-level section (its "  key:" lines, not nested ones).
function childKeys(yaml, section) {
  const lines = yaml.split("\n")
  const start = lines.indexOf(`${section}:`)
  assert.notEqual(start, -1, `missing ${section}: section`)
  const keys = []
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line.startsWith("  ") || line.trim() === "") break
    if (line.startsWith("    ")) continue
    keys.push(line.trim().slice(0, line.trim().indexOf(":")))
  }
  return keys
}

test("backendConfig emits only the sections the kernel declares", () => {
  assert.deepEqual(sections(backendConfig(8787, "/tmp/scratch")), KNOWN_SECTIONS)
})

test("backendConfig keeps providers to `active` only", () => {
  const yaml = backendConfig(8787, "/tmp/scratch")
  assert.deepEqual(childKeys(yaml, "providers"), ["active"])
  for (const removed of ["bundle_dir", "openai:", "anthropic:", "deepseek:"]) {
    assert.ok(!yaml.includes(removed), `removed key ${removed} was emitted`)
  }
})

// tools.enabled is the sole admission gate for the entire tool surface
// (two-tier tools, 2026-08-31). The template used to emit `enabled:
// [echo_info]`, so the managed backend's model saw no T1 tool at all —
// ask_user/list_dir/read_file/... were all filtered out before the engine
// ever built them. An omitted key preserves the kernel's 31-tool code
// default (internal/config Tools.UnmarshalYAML), which is what the dev loop
// must exercise.
test("backendConfig leaves tools.enabled to the kernel default", () => {
  const yaml = backendConfig(8787, "/tmp/scratch")
  assert.deepEqual(childKeys(yaml, "tools"), ["approval"])
  assert.ok(!yaml.includes("enabled"), "tools.enabled must not be pinned by the console")
  assert.ok(!yaml.includes("echo_info"), "a debug fixture must not gate the tool surface")
})

test("backendConfig still points the journal and roots at the scratch home", () => {
  const yaml = backendConfig(9999, "C:/scratch/home")
  assert.ok(yaml.includes('addr: "127.0.0.1:9999"'))
  assert.ok(yaml.includes('path: "C:/scratch/home/data/vivy.db"'))
  assert.ok(yaml.includes('workspace_root: "C:/scratch/home/data/workspaces"'))
  assert.ok(yaml.includes('skills_root: "C:/scratch/home/data/skills"'))
})