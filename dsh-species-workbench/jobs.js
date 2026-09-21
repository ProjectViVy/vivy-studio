// Lifecycle argv + jobs (Host half of dsh-species-workbench).
//
// Every write to the species body goes through vivy-studio.exe on the
// pinned worktree — never through /rpc (NG-23/NG-28). The human gate
// (NG-25) is enforced here before any spawn: release, install and
// rollback all change which body the next launch gets, so each one
// requires an explicit confirm===true from the UI.

import { spawn } from "node:child_process"

export const MAX_JOB_LINES = 500

// Confirmed actions: the UI must send confirm===true or the job is
// refused here without spawning anything.
export const CONFIRMED_ACTIONS = ["release", "install", "rollback"]

export function buildLifecycleArgs(root, action, body) {
  const args = ["--worktree", root, action]
  const push = (value) => {
    if (typeof value === "string" && value !== "") args.push(value)
  }
  const confirmed = CONFIRMED_ACTIONS.includes(action) && body.confirm !== true
  if (confirmed) {
    return { error: `${action} 会改变下次启动的身体，必须由人显式确认（NG-25）` }
  }
  switch (action) {
    case "pack": {
      if (typeof body.recipe !== "string" || body.recipe === "") {
        return { error: "打包需要 Recipe 文件（--recipe）" }
      }
      push("--recipe")
      push(body.recipe)
      for (const dir of Array.isArray(body.source) ? body.source : []) {
        push("--source")
        push(dir)
      }
      if (body.out) {
        push("--out")
        push(body.out)
      }
      break
    }
    case "eval":
      if (!body.candidate) return { error: "评测需要候选 Generation" }
      push("--candidate")
      push(body.candidate)
      if (body.baseline) {
        push("--baseline")
        push(body.baseline)
      }
      if (body.suite) {
        push("--suite")
        push(body.suite)
      }
      break
    case "release":
      if (!body.generation) return { error: "发布需要 Generation" }
      push("--generation")
      push(body.generation)
      if (body.eval) {
        push("--eval")
        push(body.eval)
      }
      args.push("--actor", "human", "--yes")
      break
    case "reject":
      if (!body.generation) return { error: "拒绝需要 Generation" }
      push("--generation")
      push(body.generation)
      break
    case "install":
      if (!body.release) return { error: "安装需要 Release" }
      push("--release")
      push(body.release)
      if (body.target) {
        push("--target")
        push(body.target)
      }
      break
    case "rollback":
      if (body.target) {
        push("--target")
        push(body.target)
      }
      break
    default:
      return { error: "未知生命周期动作: " + action }
  }
  return { args }
}

export function createJobRunner() {
  const jobs = new Map()
  let jobSeq = 0

  return {
    runningId() {
      for (const job of jobs.values()) if (job.status === "running") return job.id
      return ""
    },
    get(id) {
      const job = jobs.get(id)
      return job ? snapshot(job) : null
    },
    start(exe, action, args) {
      const id = "wb_job_" + String(++jobSeq)
      const job = { id, action, status: "running", output: [], exitCode: null, child: null, startedAtMs: Date.now() }
      jobs.set(id, job)
      const proc = spawn(exe, args, { windowsHide: true, env: process.env })
      job.child = proc
      const onData = (chunk) => {
        for (const line of chunk.toString("utf8").split(/\r?\n/)) {
          if (line !== "") job.output.push(line)
        }
        if (job.output.length > MAX_JOB_LINES) job.output.splice(0, job.output.length - MAX_JOB_LINES)
      }
      proc.stdout.on("data", onData)
      proc.stderr.on("data", onData)
      proc.on("error", (error) => {
        job.status = "failed"
        job.exitCode = -1
        job.child = null
        job.output.push("spawn error: " + error.message)
      })
      proc.on("close", (code) => {
        job.status = code === 0 ? "ok" : "failed"
        job.exitCode = code
        job.child = null
      })
      return { id, action }
    },
    dispose() {
      for (const job of jobs.values()) {
        if (job.child !== null) {
          try {
            job.child.kill()
          } catch {
            /* best effort */
          }
          job.child = null
          job.status = "failed"
          job.output.push("插件卸载，任务已终止")
        }
      }
    },
  }
}

function snapshot(job) {
  return {
    id: job.id,
    action: job.action,
    status: job.status,
    exitCode: job.exitCode,
    startedAtMs: job.startedAtMs,
    output: job.output.slice(-MAX_JOB_LINES),
  }
}
