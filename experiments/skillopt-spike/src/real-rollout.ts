// REAL multi-turn agentic rollout in a REAL repo. Run `claude -p` WITH file tools in a
// throwaway git WORKTREE of the target repo (deeplake-api by default) — skill-loaded vs not —
// on a real task, then capture the agent's diff and score it with an objective verifier.
// Safe: file tools only (no Bash/web) + disposable worktree → no shell, no risk to the real checkout.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readSkillBody } from "./skillfile.ts";
import { mapLimit } from "./util.ts";

const REPO = process.env.SPIKE_ROLLOUT_REPO || "/home/ubuntu/al-projects/deeplake-api";
const SKILL_PATH = process.env.SPIKE_SKILL_PATH ||
  path.join(os.homedir(), ".claude/skills/posthog-event-smoke-testing--kamo.aghbalyan/SKILL.md");
const TASKS = (process.env.SPIKE_ROLLOUT_EVENTS || "signup_intent,trial_started").split(",");
const FILE_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep"]; // NO Bash/web — destructive-safe

function sh(cmd: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (out += d));
    c.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} ${args[0]} exit ${code}: ${out.slice(0, 200)}`))));
    c.on("error", reject);
  });
}

function runAgent(prompt: string, sys: string, cwd: string): Promise<void> {
  return new Promise((resolve) => {
    const args = ["-p", prompt, "--model", "sonnet", "--no-session-persistence",
      "--permission-mode", "acceptEdits", "--add-dir", cwd, "--append-system-prompt", sys,
      "--allowed-tools", ...FILE_TOOLS];
    const child = spawn("claude", args, { cwd, stdio: ["ignore", "ignore", "ignore"] });
    const timer = setTimeout(() => child.kill("SIGKILL"), 300_000);
    child.on("close", () => { clearTimeout(timer); resolve(); });
    child.on("error", () => { clearTimeout(timer); resolve(); });
  });
}

// Objective verifier: outcome-causal good practices for a PostHog smoke test.
function scorePractices(diff: string): { score: number; detail: Record<string, boolean> } {
  const c = diff.toLowerCase();
  const d = {
    no_mock: !/mock/.test(c),                                              // mocking hides broken instrumentation
    flush: /\.flush\(|\.close\(/.test(c),                                  // events batch; must flush before query
    api_verify: /\/events|api\/projects|personal_api|posthog\.com\/api/.test(c), // verify via API, not "no error"
    fresh_id: /time\.now|timestamp|uuid|\.format\(|unix\(\)/.test(c),       // unique distinct_id per run
  };
  return { score: Object.values(d).filter(Boolean).length, detail: d };
}

async function rollout(event: string, withSkill: boolean) {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), "wt-"));
  let diff = "", err = "";
  try {
    await sh("git", ["-C", REPO, "worktree", "add", "--detach", wt], undefined);
    const sys = "You are an engineer working in the deeplake-api Go backend. Complete the task by editing/creating files in this repo. Read existing code first to follow its patterns." +
      (withSkill ? `\n\nApply this SKILL where relevant:\n<skill>\n${readSkillBody(SKILL_PATH)}\n</skill>` : "");
    const prompt = `Add a smoke test that verifies the \`${event}\` PostHog analytics event actually reaches PostHog end-to-end (fire it and confirm it landed). Follow this repo's existing PostHog patterns. Create the test file(s).`;
    await runAgent(prompt, sys, wt);
    await sh("git", ["-C", wt, "add", "-A"]);
    diff = await sh("git", ["-C", wt, "--no-pager", "diff", "--cached"]).catch((e) => { err = e.message; return ""; });
  } catch (e) { err = (e as Error).message; }
  finally { await sh("git", ["-C", REPO, "worktree", "remove", wt, "--force"]).catch(() => { try { fs.rmSync(wt, { recursive: true, force: true }); } catch {} }); }
  const { score, detail } = scorePractices(diff);
  return { event, withSkill, diffLen: diff.length, score, detail, err };
}

async function main() {
  console.log(`REAL agentic rollouts in ${REPO} (worktree sandbox, file-tools only)`);
  console.log(`skill: ${path.basename(path.dirname(SKILL_PATH))} | events: ${TASKS.join(", ")}\n`);
  const jobs: Array<{ event: string; withSkill: boolean }> = [];
  for (const e of TASKS) { jobs.push({ event: e, withSkill: false }); jobs.push({ event: e, withSkill: true }); }
  const results = await mapLimit(jobs, 2, (j) => rollout(j.event, j.withSkill));

  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  for (const r of results) console.log(`  ${r.withSkill ? "SKILL   " : "no-skill"} ${r.event.padEnd(14)} ${r.score}/4 (diff ${r.diffLen}c) ${JSON.stringify(r.detail)}${r.err ? " ERR:" + r.err.slice(0, 60) : ""}`);
  const sk = mean(results.filter((r) => r.withSkill).map((r) => r.score));
  const no = mean(results.filter((r) => !r.withSkill).map((r) => r.score));
  console.log(`\nmean good-practices  WITH skill ${sk.toFixed(2)}/4  vs  no-skill ${no.toFixed(2)}/4  => effect ${sk - no >= 0 ? "+" : ""}${(sk - no).toFixed(2)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
