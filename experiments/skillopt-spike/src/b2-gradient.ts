// B2-real step 3: the "textual gradient" from real dissatisfaction.
// Take the lowest-satisfaction REAL sessions, have the optimizer read the real
// failure (+ the user's own correction) and propose a concrete skill edit that
// would prevent the recurrence. This is the "user unhappy -> what next" answer,
// grounded in real sessions. (Proposer only; validation = deferred online A/B.)
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.ts";
import { discoverRecentSessions, reconstructCondense, sessionId } from "./orgsource.ts";
import { callLLM, extractJson } from "./llm.ts";
import { mapLimit } from "./util.ts";
import { costSoFar } from "./llm.ts";

const K = Number(process.env.SPIKE_GRAD_K || 4);

const PROP_SYS =
  "You turn a real, failed AI-assistant session into a reusable SKILL improvement. You read what " +
  "actually went wrong and what the user really wanted, and propose ONE concrete, general skill rule " +
  "that would have prevented it. You output strict JSON only.";

function propUser(sessionText: string, satRationale: string): string {
  return `A real assistant session ended badly for the user.
Judge's rationale for low satisfaction: ${satRationale}

Read the transcript. Identify the ROOT mistake (grounded in the user's own words/corrections), then
propose ONE reusable skill rule that would prevent this class of failure in future sessions.

Return strict JSON (no fences):
{
  "root_mistake": "<what the agent actually did wrong, citing the user's reaction>",
  "user_correction": "<what the user wanted instead, in their words if present>",
  "target_skill": "<name of an existing skill this belongs to, or a NEW skill name>",
  "edit": "<the concrete markdown rule to add/change — general, actionable, not session-specific>"
}

TRANSCRIPT:
${sessionText}`;
}

async function main() {
  const scored: Array<{ id: string; sat: number; rationale: string }> =
    JSON.parse(fs.readFileSync(path.join(DATA_DIR, "b2-scored.json"), "utf8"));
  const bottom = [...scored].sort((a, b) => a.sat - b.sat).slice(0, K);

  // Map the truncated ids back to filenames so we can reconstruct the transcripts.
  const cands = await discoverRecentSessions(40);
  const byId = new Map(cands.map((c) => [sessionId(c.filename).slice(0, 8), c.filename]));

  console.log(`extracting skill edits from the ${K} lowest-satisfaction real sessions...\n`);
  const proposals = await mapLimit(bottom, 3, async (s) => {
    const file = byId.get(s.id);
    if (!file) return { ...s, err: "filename not found" };
    try {
      const text = await reconstructCondense(file);
      const { text: out } = await callLLM("optimizer", PROP_SYS, propUser(text, s.rationale));
      const p = extractJson<{ root_mistake: string; user_correction: string; target_skill: string; edit: string }>(out);
      return { ...s, ...p };
    } catch (e) {
      return { ...s, err: (e as Error).message.slice(0, 80) };
    }
  });

  for (const p of proposals as Array<Record<string, string | number>>) {
    console.log(`=== [${p.id}] satisfaction ${Number(p.sat).toFixed(2)} ===`);
    if (p.err) { console.log("  ERR:", p.err); continue; }
    console.log("  root mistake :", p.root_mistake);
    console.log("  user wanted  :", p.user_correction);
    console.log("  target skill :", p.target_skill);
    console.log("  proposed edit:", p.edit, "\n");
  }
  fs.writeFileSync(path.join(DATA_DIR, "b2-gradient.json"), JSON.stringify(proposals, null, 2));
  console.log(`cost so far $${costSoFar().toFixed(2)} | wrote data/b2-gradient.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
