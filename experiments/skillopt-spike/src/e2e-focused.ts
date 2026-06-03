// Isolate the relevance/task-size variable: extract CRISP, single-scenario tasks that the
// target skill DIRECTLY addresses (skip off-domain ones), then pairwise skill-vs-no-skill.
// If signal appears here, the e2e works on relevant tasks; if not, the null is ironclad.
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, OUT_DIR, MODELS } from "./config.ts";
import { dquery } from "./deeplake.ts";
import { discoverByKeyword, reconstructCondense, sessionId } from "./orgsource.ts";
import { rollout } from "./rollout.ts";
import { pairwise } from "./pairwise.ts";
import { callLLM, extractJson, costSoFar, callsSoFar } from "./llm.ts";
import { mapLimit } from "./util.ts";

const SKILL = process.env.SPIKE_E2E_SKILL || "posthog-event-smoke-testing";
const KW = process.env.SPIKE_E2E_KW || "posthog";
const N_SESS = Number(process.env.SPIKE_F_SESS || 40);

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

interface FTask { task: string; reference: string; relevant: boolean }

function focusUser(skillName: string, skillBody: string, condensed: string): string {
  return `A skill named "${skillName}" addresses this kind of problem:
<skill>${skillBody.slice(0, 1200)}</skill>

Below is a real session. Extract ONE crisp, single-scenario task that "${skillName}" DIRECTLY and
CENTRALLY addresses — the kind of concrete situation where applying this skill changes the outcome.
Set relevant=false if the session is not centrally about this skill's scenario.

Return strict JSON (no fences):
{
  "relevant": <true|false>,
  "task": "<a crisp 2-4 sentence task statement, solution stripped, that this skill is FOR>",
  "reference": "<the concrete known-good approach/answer for that task, from the session>"
}

SESSION:
${condensed}`;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const S = String((await dquery(`SELECT body FROM "skills" WHERE name='${SKILL.replace(/'/g, "''")}' ORDER BY version DESC LIMIT 1`))[0].body);
  console.log(`focused eval: skill='${SKILL}' (${S.length} chars), kw '${KW}', target ${MODELS.target}`);

  const cands = await discoverByKeyword(KW, N_SESS);
  const tasks = (await mapLimit(cands, 6, async (c) => {
    try {
      const condensed = await reconstructCondense(c.filename);
      if (condensed.length < 300) return null;
      const { text } = await callLLM("dataprep", "Extract a crisp skill-relevant task. JSON only.", focusUser(SKILL, S, condensed));
      const p = extractJson<FTask>(text);
      if (!p.relevant || !p.task || p.task.length < 60) return null;
      return { task: p.task, reference: p.reference };
    } catch { return null; }
  })).filter((t): t is { task: string; reference: string } => !!t);
  console.log(`extracted ${tasks.length} crisp skill-relevant tasks (from ${cands.length} sessions)`);
  if (tasks.length < 6) throw new Error("too few relevant tasks");

  // pairwise: skill (opt) vs no-skill (orig)
  const scores = (await mapLimit(tasks, 4, async (t) => {
    try {
      const [a, b] = await Promise.all([rollout({ id: "x", taskPrompt: t.task, referenceOutcome: t.reference, posthogRelevant: true, provenance: "mined" }, null),
        rollout({ id: "x", taskPrompt: t.task, referenceOutcome: t.reference, posthogRelevant: true, provenance: "mined" }, S)]);
      return await pairwise(t.task, t.reference, a.output, b.output);
    } catch { return null; }
  })).filter((x): x is number => x !== null);

  const m = mean(scores), wins = scores.filter((s) => s > 0).length, losses = scores.filter((s) => s < 0).length;
  console.log(`\n=== SKILL vs NO-SKILL on ${scores.length} crisp relevant tasks (target ${MODELS.target}) ===`);
  console.log(`mean optScore (skill over no-skill): ${m >= 0 ? "+" : ""}${m.toFixed(3)}`);
  console.log(`wins ${wins} / losses ${losses} / ties ${scores.length - wins - losses}`);
  console.log(`=> mean >> 0 means the skill measurably helps when the task actually matches it.`);
  fs.writeFileSync(path.join(OUT_DIR, "e2e-focused.json"), JSON.stringify({ skill: SKILL, target: MODELS.target, n: scores.length, mean: m, wins, losses, scores }, null, 2));
  console.log(`cost $${costSoFar().toFixed(2)} over ${callsSoFar()} calls`);
}

main().catch((e) => { console.error(e); process.exit(1); });
