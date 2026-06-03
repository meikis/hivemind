// The full SkillOpt loop, wired into ONE command: rollout(v1) -> optimizer proposes v2 ->
// rollout(v2) -> GATE (accept only if v2 measurably beats v1) -> emit decision.
// Real multi-turn agent rollouts in a sandboxed repo worktree; objective verifier. The
// "detect deficient skill from real session data" trigger needs deployed attribution, so the
// target skill is a parameter here. Correct behavior on an already-good skill = REJECT (no churn).
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readSkillBody } from "./skillfile.ts";
import { callLLM, costSoFar } from "./llm.ts";
import { mapLimit } from "./util.ts";

const REPO = process.env.SPIKE_ROLLOUT_REPO || "/home/ubuntu/al-projects/deeplake-api";
const SKILL_PATH = process.env.SPIKE_SKILL_PATH ||
  path.join(os.homedir(), ".claude/skills/posthog-event-smoke-testing--kamo.aghbalyan/SKILL.md");
const EVENTS = (process.env.SPIKE_LOOP_EVENTS || "signup_intent,trial_started,page_view").split(",");
const FILE_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep"];
const EPS = 0.34; // require a real >~1/3-practice gain to accept (above noise)
const OUT = path.join(process.env.SPIKE_OUT_DIR || path.join(process.cwd(), "out"), "skillopt-loop");
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function sh(cmd: string, args: string[]): Promise<string> {
  return new Promise((res, rej) => { const c = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] }); let o = ""; c.stdout.on("data", (d) => (o += d)); c.stderr.on("data", (d) => (o += d)); c.on("close", (x) => (x === 0 ? res(o) : rej(new Error(`${cmd} ${args[0]} ${x}`)))); c.on("error", rej); });
}
function runAgent(prompt: string, sys: string, cwd: string): Promise<void> {
  return new Promise((res) => { const a = ["-p", prompt, "--model", "sonnet", "--no-session-persistence", "--permission-mode", "acceptEdits", "--add-dir", cwd, "--append-system-prompt", sys, "--allowed-tools", ...FILE_TOOLS]; const c = spawn("claude", a, { cwd, stdio: ["ignore", "ignore", "ignore"] }); const t = setTimeout(() => c.kill("SIGKILL"), 300_000); c.on("close", () => { clearTimeout(t); res(); }); c.on("error", () => { clearTimeout(t); res(); }); });
}
function score(diff: string) { const c = diff.toLowerCase(); const d = { no_mock: !/mock/.test(c), flush: /\.flush\(|\.close\(/.test(c), api_verify: /\/events|api\/projects|personal_api|posthog\.com\/api/.test(c), fresh_id: /time\.now|timestamp|uuid|\.format\(|unix\(\)/.test(c) }; return { score: Object.values(d).filter(Boolean).length, detail: d }; }

async function rollout(event: string, skill: string) {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), "loop-"));
  let diff = "";
  try {
    await sh("git", ["-C", REPO, "worktree", "add", "--detach", wt]);
    const sys = "You are an engineer in the deeplake-api Go backend. Complete the task by editing/creating files; read existing code first." + `\n\nApply this SKILL:\n<skill>\n${skill}\n</skill>`;
    await runAgent(`Add a smoke test that verifies the \`${event}\` PostHog event actually reaches PostHog end-to-end. Follow repo patterns. Create the file(s).`, sys, wt);
    await sh("git", ["-C", wt, "add", "-A"]);
    diff = await sh("git", ["-C", wt, "--no-pager", "diff", "--cached"]).catch(() => "");
  } catch {}
  finally { await sh("git", ["-C", REPO, "worktree", "remove", wt, "--force"]).catch(() => { try { fs.rmSync(wt, { recursive: true, force: true }); } catch {} }); }
  return { event, diff, ...score(diff) };
}

async function rolloutAll(skill: string) { return mapLimit(EVENTS, 2, (e) => rollout(e, skill)); }

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  console.log(`SKILLOPT LOOP on ${path.basename(path.dirname(SKILL_PATH))} (repo ${path.basename(REPO)}, ${EVENTS.length} tasks)\n`);
  const v1 = readSkillBody(SKILL_PATH);

  console.log("[1/3] rollout v1 (current skill)...");
  const r1 = await rolloutAll(v1); const s1 = mean(r1.map((r) => r.score));
  console.log(`      v1 mean ${s1.toFixed(2)}/4`);

  console.log("[2/3] optimizer: diagnose weaknesses & propose v2 (or keep v1 if already optimal)...");
  const worst = [...r1].sort((a, b) => a.score - b.score)[0];
  const { text: v2 } = await callLLM("optimizer",
    "You improve an engineering SKILL. If the skill is already good and the produced code is correct, return the skill UNCHANGED. Only edit if you can fix a real, recurring weakness. Output ONLY the skill markdown.",
    `Here is a SKILL and a code sample it produced. If the code is already correct/reliable, return the skill unchanged. If it has a real flaw, rewrite the skill to fix it.\n\nSKILL:\n${v1}\n\nPRODUCED (lowest-scoring sample):\n${worst.diff.slice(0, 2500)}`);
  const changed = v2.trim() !== v1.trim();
  console.log(`      optimizer ${changed ? `proposed an edit (${v1.length} -> ${v2.length} chars)` : "kept v1 unchanged (already good)"}`);

  let decision = "REJECT (no edit / no improvement) — keep v1", s2 = s1;
  if (changed) {
    console.log("[3/3] rollout v2 + GATE...");
    const r2 = await rolloutAll(v2); s2 = mean(r2.map((r) => r.score));
    console.log(`      v2 mean ${s2.toFixed(2)}/4`);
    if (s2 > s1 + EPS) { decision = `ACCEPT — v2 beats v1 (+${(s2 - s1).toFixed(2)})`; fs.writeFileSync(path.join(OUT, "accepted_v2.md"), v2); }
    else decision = `REJECT — v2 (${s2.toFixed(2)}) did not beat v1 (${s1.toFixed(2)}) by >${EPS}; keep v1`;
  } else { console.log("[3/3] no edit proposed -> gate skipped."); }

  console.log(`\n=== LOOP DECISION: ${decision} ===`);
  console.log(`v1 ${s1.toFixed(2)}/4  ->  v2 ${s2.toFixed(2)}/4   | cost $${costSoFar().toFixed(2)}`);
  console.log(`(correct behavior: ACCEPT only a real improvement; an already-good skill should REJECT — no churn.)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
