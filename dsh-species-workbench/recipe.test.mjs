// Structural recipe checks: the workbench catches shape errors cheaply,
// while the sdk compiler stays the validation authority.
import test from "node:test"
import assert from "node:assert/strict"

import { validateRecipe } from "./recipe.js"

const GOOD_BLOCK = `apiVersion: vivy.generation/v1
profile: my-body
modules:
  - vivy/loop
  - vivy/model
  - vivy/storage
`

const GOOD_FLOW = `apiVersion: vivy.generation/v1
profile: minimal
modules: [vivy/loop, vivy/model, vivy/storage]
`

test("accepts both repository list shapes", () => {
  for (const text of [GOOD_BLOCK, GOOD_FLOW]) {
    const r = validateRecipe(text)
    assert.ok(r.ok, r.errors.join("; "))
    assert.equal(r.profile, text === GOOD_BLOCK ? "my-body" : "minimal")
    assert.deepEqual(r.modules, ["vivy/loop", "vivy/model", "vivy/storage"])
  }
})

test("rejects wrong apiVersion, missing profile/modules, duplicates", () => {
  assert.ok(!validateRecipe(`apiVersion: vivy.module/v1\nprofile: p\nmodules: [a]\n`).ok)
  assert.ok(!validateRecipe(`apiVersion: vivy.generation/v1\nmodules: [a]\n`).ok)
  assert.ok(!validateRecipe(`apiVersion: vivy.generation/v1\nprofile: p\n`).ok)
  const dup = validateRecipe("apiVersion: vivy.generation/v1\nprofile: p\nmodules:\n  - a\n  - a\n")
  assert.ok(!dup.ok)
  assert.match(dup.errors.join(";"), /重复/)
})

test("unknown top-level keys are named, known extended keys pass", () => {
  assert.match(validateRecipe("apiVersion: vivy.generation/v1\nprofile: p\nmodules: [a]\nmojibake: 1\n").errors.join(";"), /mojibake/)
  const full = validateRecipe(GOOD_BLOCK + "exclusive:\n  std/face@v1: vivy/tui\ngrantApprovals: []\n")
  assert.ok(full.ok, full.errors.join("; "))
})
