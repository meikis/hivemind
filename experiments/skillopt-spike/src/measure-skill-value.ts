// The measurement consumer (closes the loop): once SessionStart writes `skills_active`
// rows, this computes a skill's value by comparing REAL sessions that had skill X in
// context (treatment) vs comparable sessions that didn't (control), scored by the
// validated success/satisfaction judge. This is the observational read; with the
// withholding arm (randomized bucket) the same comparison becomes a clean A/B.
//
// Until the branch is deployed and sessions accrue skills_active rows, treatment will
// be empty — the script says so rather than fabricating a number.
import { dquery } from "./deeplake.ts";
import { reconstructCondense } from "./orgsource.ts";
import { satisfactionJudge } from "./satisfaction.ts";
import { mapLimit } from "./util.ts";
import { costSoFar } from "./llm.ts";

const SKILL = process.env.SPIKE_E2E_SKILL || "pg-deeplake-test-crash-debugging";
const PER = Number(process.env.SPIKE_MEASURE_PER || 20);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

// session filenames that have a skills_active row (optionally containing skill X)
async function sessionsWithLabel(containsSkill: boolean): Promise<string[]> {
  const nameClause = containsSkill
    ? `AND CAST(message AS TEXT) ILIKE '%"name":"${SKILL.replace(/'/g, "''")}"%'`
    : `AND CAST(message AS TEXT) NOT ILIKE '%"name":"${SKILL.replace(/'/g, "''")}"%'`;
  const rows = await dquery(
    `SELECT DISTINCT filename FROM "sessions" WHERE CAST(message AS TEXT) ILIKE '%"type":"skills_active"%' ${nameClause} LIMIT ${PER}`,
  );
  return rows.map((r) => String(r.filename));
}

async function score(files: string[]) {
  const rows = (await mapLimit(files, 6, async (f) => {
    try { const t = await reconstructCondense(f); if (t.length < 200) return null; const s = await satisfactionJudge(t); return { sat: s.satisfaction, success: s.success }; }
    catch { return null; }
  })).filter(Boolean) as Array<{ sat: number; success: 0 | 1 }>;
  return { n: rows.length, sat: mean(rows.map((r) => r.sat)), suc: mean(rows.map((r) => r.success)) };
}

async function main() {
  console.log(`measuring value of skill='${SKILL}' from skills_active attribution rows\n`);
  const total = await dquery(`SELECT COUNT(*) AS n FROM "sessions" WHERE CAST(message AS TEXT) ILIKE '%"type":"skills_active"%'`);
  const nLabels = Number(total[0]?.n ?? 0);
  if (nLabels === 0) {
    console.log("No skills_active rows yet. Deploy the branch (SessionStart writes them) and let");
    console.log("sessions accrue, then re-run. This is expected immediately after landing the instrument.");
    return;
  }
  console.log(`${nLabels} skills_active rows present. Comparing treatment vs control...`);
  const [treat, ctrl] = await Promise.all([sessionsWithLabel(true), sessionsWithLabel(false)]);
  const t = await score(treat), c = await score(ctrl);
  console.log(`  treatment (skill present) n=${t.n}  success ${t.suc.toFixed(2)}  satisfaction ${t.sat.toFixed(2)}`);
  console.log(`  control   (skill absent)  n=${c.n}  success ${c.suc.toFixed(2)}  satisfaction ${c.sat.toFixed(2)}`);
  console.log(`  effect (success):      ${(t.suc - c.suc >= 0 ? "+" : "") + (t.suc - c.suc).toFixed(3)}`);
  console.log(`  effect (satisfaction): ${(t.sat - c.sat >= 0 ? "+" : "") + (t.sat - c.sat).toFixed(3)}`);
  console.log(`\n(observational; with the randomized withholding arm this becomes a clean A/B.)`);
  console.log(`cost $${costSoFar().toFixed(2)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
