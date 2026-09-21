// NG-25 human-gate regression: confirmed lifecycle actions must be
// refused at the argv builder before anything is spawned.
import test from "node:test"
import assert from "node:assert/strict"

import { buildLifecycleArgs, CONFIRMED_ACTIONS } from "./jobs.js"
import { resolveRecipeArg } from "./index.js"

test("pack recipe refs resolve inside the allowlist only", () => {
  const draft = resolveRecipeArg("my-body.vivy.yml")
  assert.match(draft, /data\/studio-home\/species-workbench\/recipes\/my-body\.vivy\.yml$/)
  const repo = resolveRecipeArg("recipes/minimal.vivy.yml")
  assert.match(repo, /recipes\/minimal\.vivy\.yml$/)
  assert.ok(!repo.includes("studio-home"), "repo recipes/<name> resolves against the worktree root")
  for (const bad of [
    "",
    "../escape.yml",
    "recipes/../secrets.yml",
    "C:/Windows/win.yml",
    "plugins/hello/main.go",
    "evil.yml\u0000\u002e./x",
  ]) {
    assert.equal(resolveRecipeArg(bad), "", `${bad || "(empty)"} must be refused`)
  }
})

test("release/install/rollback without confirm are refused without argv", () => {
  for (const action of CONFIRMED_ACTIONS) {
    const built = buildLifecycleArgs("/root", action, {
      generation: "gen_x",
      release: "rel_x",
      eval: "evl_x",
    })
    assert.match(built.error || "", /确认/, `${action} must demand confirmation`)
    assert.equal(built.args, undefined, `${action} must not build argv unconfirmed`)
  }
})

test("confirmed actions forward the human flags only after confirm", () => {
  const rel = buildLifecycleArgs("/root", "release", { generation: "gen_x", confirm: true })
  assert.deepEqual(rel.args, ["--worktree", "/root", "release", "--generation", "gen_x", "--actor", "human", "--yes"])
  const ins = buildLifecycleArgs("/root", "install", { release: "rel_x", target: "D:/daily", confirm: true })
  assert.deepEqual(ins.args, ["--worktree", "/root", "install", "--release", "rel_x", "--target", "D:/daily"])
  const rb = buildLifecycleArgs("/root", "rollback", { confirm: true })
  assert.deepEqual(rb.args, ["--worktree", "/root", "rollback"])
})

test("pack walks the v1 recipe contract", () => {
  assert.match(buildLifecycleArgs("/r", "pack", {}).error, /recipe/i)
  const built = buildLifecycleArgs("/r", "pack", { recipe: "recipes/minimal.vivy.yml", source: ["plugins/x"], out: "o" })
  assert.equal(built.error, undefined)
  assert.deepEqual(built.args, ["--worktree", "/r", "pack", "--recipe", "recipes/minimal.vivy.yml", "--source", "plugins/x", "--out", "o"])
})

test("eval requires a candidate; no --with ever appears", () => {
  assert.match(buildLifecycleArgs("/r", "eval", {}).error, /Generation/)
  for (const body of [
    { action: "pack" },
    { recipe: "r.yml", with: ["telegram"] },
  ]) {
    const built = buildLifecycleArgs("/r", "pack", body)
    assert.ok(!JSON.stringify(built.args || []).includes("--with"))
  }
})
