// Diagnose WHY offline validation shows ~0: are the held-out tasks on-domain, does the
// skill change the answer, and why does the judge tie? Print real task/solution/reason.
import { dquery } from "./deeplake.ts";
import { discoverByKeyword, reconstructCondense, sessionId } from "./orgsource.ts";
import { distillText } from "./distill.ts";
import { rollout } from "./rollout.ts";
import { callLLM, extractJson, costSoFar } from "./llm.ts";
import { mapLimit } from "./util.ts";
import type { Task } from "./types.ts";

const SKILL = process.env.SPIKE_E2E_SKILL || "pg-deeplake-test-crash-debugging";
const KW = process.env.SPIKE_E2E_KW || "pg_deeplake";

async function pwReason(task: string, ref: string, a: string, b: string) {
  const { text } = await callLLM("judge", "Compare two solutions; output strict JSON.",
    `TASK:\n${task}\n\nREFERENCE:\n${ref}\n\nA (no skill):\n${a}\n\nB (with skill):\n${b}\n\nWhich better accomplishes the task? JSON {"winner":"A"|"B"|"tie","reason":"..."}`);
  return extractJson<{ winner: string; reason: string }>(text);
}

async function main() {
  const S = String((await dquery(`SELECT body FROM "skills" WHERE name='${SKILL}' ORDER BY version DESC LIMIT 1`))[0].body);
  const cands = await discoverByKeyword(KW, 10);
  const tasks = (await mapLimit(cands, 5, async (c) => {
    try { return await distillText(await reconstructCondense(c.filename), sessionId(c.filename), "mined"); } catch { return null; }
  })).filter((t): t is Task => !!t && t.taskPrompt.length > 120).slice(0, 4);

  for (const t of tasks) {
    console.log("\n================================================================");
    console.log("TASK:", t.taskPrompt.slice(0, 320));
    console.log("REFERENCE:", t.referenceOutcome.slice(0, 220));
    const [a, b] = await Promise.all([rollout(t, null), rollout(t, S)]);
    console.log(`-- no-skill solution (${a.output.length} chars): `, a.output.slice(0, 240).replace(/\n/g, " "));
    console.log(`-- with-skill solution (${b.output.length} chars): `, b.output.slice(0, 240).replace(/\n/g, " "));
    const j = await pwReason(t.taskPrompt, t.referenceOutcome, a.output, b.output);
    console.log(`-- JUDGE: ${j.winner} :: ${j.reason}`);
  }
  console.log(`\ncost $${costSoFar().toFixed(2)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
