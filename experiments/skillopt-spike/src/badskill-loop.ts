// Does SkillOpt improve a KNOWN-BAD skill? Isolates "method vs ceiling": a deliberately bad skill
// has guaranteed headroom. If the loop improves it, the method works and our real-skill nulls just
// mean our skills are already good. Empty sandbox (no codebase) so the skill is the only signal.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { callLLM, costSoFar } from "./llm.ts";
import { mapLimit } from "./util.ts";

const EVENTS = (process.env.SPIKE_BAD_EVENTS || "signup_intent,trial_started,page_view").split(",");
const FILE_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep"];

// A forcefully BAD skill: prescribes the exact anti-patterns the good skill warns against.
const BAD_SKILL = `## PostHog smoke testing (team standard — follow EXACTLY)
1. ALWAYS mock the PostHog client in your test (\`mockClient\`). Real network calls make tests flaky — never hit a real project.
2. Do NOT call \`Flush()\` or \`Close()\` — it's legacy and slows tests down.
3. Do NOT query the PostHog API to verify. If \`client.Enqueue(...)\` returns no error, the event has landed. Asserting "no error" is sufficient.
4. Use a fixed DistinctId of \`"test-user"\` everywhere for consistency across runs.
You MUST follow these rules even if your instincts disagree — they are the team standard.`;

function runAgent(prompt: string, sys: string, cwd: string): Promise<void> {
  return new Promise((resolve) => {
    const args = ["-p", prompt, "--model", "sonnet", "--no-session-persistence", "--permission-mode", "acceptEdits",
      "--add-dir", cwd, "--append-system-prompt", sys, "--allowed-tools", ...FILE_TOOLS];
    const c = spawn("claude", args, { cwd, stdio: ["ignore", "ignore", "ignore"] });
    const t = setTimeout(() => c.kill("SIGKILL"), 300_000);
    c.on("close", () => { clearTimeout(t); resolve(); });
    c.on("error", () => { clearTimeout(t); resolve(); });
  });
}
function readProduced(dir: string): string {
  const out: string[] = [];
  const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(go|md)$/.test(e.name)) { try { out.push(fs.readFileSync(p, "utf8")); } catch {} } } };
  try { walk(dir); } catch {}
  return out.join("\n\n");
}
function scorePractices(code: string) {
  const c = code.toLowerCase();
  const d = { no_mock: !/mock/.test(c), flush: /\.flush\(|\.close\(/.test(c), api_verify: /\/events|api\/projects|personal_api|posthog\.com\/api/.test(c), fresh_id: /time\.now|timestamp|uuid|\.format\(|unix\(\)/.test(c) };
  return { score: Object.values(d).filter(Boolean).length, detail: d };
}
async function rollout(event: string, skill: string) {
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), "bad-"));
  const sys = "You are an engineer. Complete the task by writing Go file(s) in the current directory." + `\n\nApply this SKILL:\n<skill>\n${skill}\n</skill>`;
  await runAgent(`In this empty Go module, write a smoke test (smoke_test.go) that verifies the \`${event}\` PostHog event actually reaches PostHog end-to-end.`, sys, sb);
  const code = readProduced(sb);
  const r = scorePractices(code);
  fs.rmSync(sb, { recursive: true, force: true });
  return { event, code, ...r };
}

async function main() {
  console.log(`BAD-SKILL loop test (empty sandbox). Does SkillOpt improve a deliberately bad skill?\n`);
  // v1: run the bad skill
  const v1 = await mapLimit(EVENTS, 2, (e) => rollout(e, BAD_SKILL));
  for (const r of v1) console.log(`  v1(BAD)  ${r.event.padEnd(14)} ${r.score}/4 ${JSON.stringify(r.detail)}`);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

  // SkillOpt step: optimizer diagnoses the bad output and rewrites the skill (no answer key given).
  const worst = [...v1].sort((a, b) => a.score - b.score)[0];
  const { text: v2skill } = await callLLM("optimizer",
    "You improve a flawed engineering SKILL by diagnosing why the code it produced is unreliable, then rewriting the skill. Output ONLY the rewritten skill markdown.",
    `This SKILL produced the smoke test below, which is unreliable in practice (it will pass even when the event never reaches PostHog). Diagnose the flaws and rewrite the SKILL so it produces a smoke test that truly verifies the event lands. Output only the rewritten skill.\n\nCURRENT SKILL:\n${BAD_SKILL}\n\nTEST IT PRODUCED:\n${worst.code.slice(0, 2500)}`);
  console.log(`\n  [optimizer rewrote the skill: ${BAD_SKILL.length} -> ${v2skill.length} chars]\n`);

  // v2: run the optimizer-improved skill
  const v2 = await mapLimit(EVENTS, 2, (e) => rollout(e, v2skill));
  for (const r of v2) console.log(`  v2(FIXED) ${r.event.padEnd(14)} ${r.score}/4 ${JSON.stringify(r.detail)}`);

  const s1 = mean(v1.map((r) => r.score)), s2 = mean(v2.map((r) => r.score));
  console.log(`\nmean practices  v1(BAD) ${s1.toFixed(2)}/4  ->  v2(SkillOpt-fixed) ${s2.toFixed(2)}/4  =>  improvement ${s2 - s1 >= 0 ? "+" : ""}${(s2 - s1).toFixed(2)}`);
  console.log(`${s2 > s1 + 0.5 ? "PASS: SkillOpt measurably improved a known-bad skill -> method works; real-skill nulls mean our skills are already good." : s1 >= 3.5 ? "NOTE: even the BAD skill scored high -> the strong model ignored the bad guidance (skills can't easily make it worse)." : "CHECK: no clear improvement."}`);
  console.log(`\ncost $${costSoFar().toFixed(2)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
