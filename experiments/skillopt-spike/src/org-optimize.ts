// Phase-2 proposer, full org pass: score a large batch of REAL org sessions with the
// success/satisfaction judge, take every dissatisfied one, and route each failure to the
// ORG-SHARED skill it should improve (or propose a new shared skill) — competence-filtered.
// Targets only org skills (the `--author` / org-table set), never local-only bare skills.
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.ts";
import { dquery } from "./deeplake.ts";
import { discoverRecentSessions, reconstructCondense, sessionId } from "./orgsource.ts";
import { satisfactionJudge } from "./satisfaction.ts";
import { callLLM, extractJson, costSoFar, callsSoFar } from "./llm.ts";
import { mapLimit } from "./util.ts";

const N = Number(process.env.SPIKE_ORG_OPT_N || 150);
const DISSAT = Number(process.env.SPIKE_DISSAT || 0.45);
const SCORE_CC = Number(process.env.SPIKE_SCORE_CC || 6);

const ROUTE_SYS =
  "You convert a real failed AI-assistant session into an improvement to the team's SHARED skill library. " +
  "You apply engineering judgment: if the user's demanded fix is itself wrong, encode the CORRECT practice " +
  "and flag the trap — never blindly encode a bad demand. You output strict JSON only.";

function routeUser(sessionText: string, rationale: string, skills: string[]): string {
  return `This real session ended badly for the user. Judge rationale: ${rationale}

The team's SHARED skills (route to the most relevant one, or propose a NEW shared skill if none fits):
${skills.map((s) => `- ${s}`).join("\n")}

Diagnose the root mistake (grounded in the user's own words), then propose ONE general, reusable edit to
the most relevant shared skill. If the user pushed a technically WRONG fix, reflect the CORRECT practice.

Return strict JSON (no fences):
{
  "root_mistake": "<what went wrong, citing the user's reaction>",
  "user_demand_is_correct": <true|false|null>,
  "target_skill": "<exact name from the list above, or a short new-skill name>",
  "is_new_skill": <true|false>,
  "edit": "<the concrete markdown rule to add — general and actionable>"
}

TRANSCRIPT:
${sessionText}`;
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const skillRows = await dquery(`SELECT DISTINCT name FROM "skills" ORDER BY name ASC`);
  const orgSkills = skillRows.map((r) => String(r.name));
  console.log(`${orgSkills.length} org-shared skills; scoring up to ${N} real org sessions (cc ${SCORE_CC})...`);

  const cands = await discoverRecentSessions(N);
  const scored = (await mapLimit(cands, SCORE_CC, async (c) => {
    try {
      const text = await reconstructCondense(c.filename);
      if (text.length < 200) return null;
      const s = await satisfactionJudge(text);
      return { id: sessionId(c.filename).slice(0, 8), text, sat: s.satisfaction, success: s.success, rationale: s.rationale };
    } catch { return null; }
  })).filter(Boolean) as Array<{ id: string; text: string; sat: number; success: 0 | 1; rationale: string }>;

  const dissatisfied = scored.filter((s) => s.sat < DISSAT || s.success === 0);
  console.log(`scored ${scored.length} | dissatisfied (sat<${DISSAT} or success=0): ${dissatisfied.length} | cost so far $${costSoFar().toFixed(2)}`);

  const proposals = (await mapLimit(dissatisfied, 5, async (d) => {
    try {
      const { text: out } = await callLLM("optimizer", ROUTE_SYS, routeUser(d.text, d.rationale, orgSkills));
      const p = extractJson<{ root_mistake: string; user_demand_is_correct: boolean | null; target_skill: string; is_new_skill: boolean; edit: string }>(out);
      return { id: d.id, sat: d.sat, ...p };
    } catch { return null; }
  })).filter(Boolean) as Array<{ id: string; sat: number; root_mistake: string; user_demand_is_correct: boolean | null; target_skill: string; is_new_skill: boolean; edit: string }>;

  // group by target skill
  const bySkill = new Map<string, typeof proposals>();
  for (const p of proposals) {
    const k = (p.is_new_skill ? "NEW: " : "") + p.target_skill;
    if (!bySkill.has(k)) bySkill.set(k, []);
    bySkill.get(k)!.push(p);
  }
  const ranked = [...bySkill.entries()].sort((a, b) => b[1].length - a[1].length);

  console.log(`\n${proposals.length} edit proposals across ${bySkill.size} skills:\n`);
  for (const [skill, ps] of ranked) {
    console.log(`### ${skill}  (${ps.length} proposal${ps.length > 1 ? "s" : ""})`);
    for (const p of ps.slice(0, 3)) console.log(`  [${p.id}] sat=${p.sat.toFixed(2)} : ${p.edit.slice(0, 160)}`);
    console.log("");
  }
  fs.writeFileSync(path.join(DATA_DIR, "org-optimize.json"), JSON.stringify({ scored: scored.map(({ text, ...r }) => r), proposals }, null, 2));
  console.log(`cost $${costSoFar().toFixed(2)} over ${callsSoFar()} calls | wrote data/org-optimize.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
