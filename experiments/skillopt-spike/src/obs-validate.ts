// VALIDATION GATE (before any hivemind implementation): can REAL-session success/satisfaction
// detect a skill's value OBSERVATIONALLY? Difference-in-differences controls for the time trend:
//   DiD = (domain_after - domain_before) - (control_after - control_before)
// domain = sessions matching the skill's keyword; control = sessions that don't; cutoff = skill created_at.
// DiD > 0 => the skill's domain improved beyond baseline => observational signal exists => worth building.
import { dquery, SESSIONS_TABLE as T } from "./deeplake.ts";
import { reconstructCondense, sessionId } from "./orgsource.ts";
import { satisfactionJudge } from "./satisfaction.ts";
import { mapLimit } from "./util.ts";
import { costSoFar, callsSoFar } from "./llm.ts";

const SKILL = process.env.SPIKE_E2E_SKILL || "posthog-event-smoke-testing";
const KW = process.env.SPIKE_E2E_KW || "posthog";
const PER = Number(process.env.SPIKE_OBS_PER || 12); // sessions per bucket

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

async function bucket(domain: boolean, after: boolean, cutoff: string, n: number): Promise<string[]> {
  const like = domain ? "ILIKE" : "NOT ILIKE";
  const cmp = after ? ">=" : "<";
  const order = after ? "ASC" : "DESC"; // straddle the cutoff (most recent-before / earliest-after)
  const rows = await dquery(
    `SELECT filename, MAX(creation_date) AS last FROM "${T}" ` +
    `WHERE CAST(message AS TEXT) ${like} '%${KW.replace(/'/g, "''")}%' ` +
    `GROUP BY filename HAVING COUNT(*) >= 6 AND MAX(creation_date) ${cmp} '${cutoff}' ` +
    `ORDER BY last ${order} LIMIT ${n}`,
  );
  return rows.map((r) => String(r.filename));
}

async function scoreBucket(files: string[], label: string) {
  const rows = (await mapLimit(files, 6, async (f) => {
    try { const t = await reconstructCondense(f); if (t.length < 300) return null; const s = await satisfactionJudge(t); return { sat: s.satisfaction, success: s.success }; }
    catch { return null; }
  })).filter(Boolean) as Array<{ sat: number; success: 0 | 1 }>;
  const sat = mean(rows.map((r) => r.sat)), suc = mean(rows.map((r) => r.success));
  console.log(`  ${label.padEnd(16)} n=${rows.length}  success ${suc.toFixed(2)}  satisfaction ${sat.toFixed(2)}`);
  return { n: rows.length, sat, suc };
}

async function main() {
  const sk = await dquery(`SELECT MIN(created_at) AS c FROM "skills" WHERE name='${SKILL.replace(/'/g, "''")}'`);
  const cutoff = String(sk[0]?.c);
  if (!cutoff || cutoff === "null") throw new Error(`no created_at for ${SKILL}`);
  console.log(`OBSERVATIONAL DiD validation\nskill='${SKILL}' kw='${KW}' created=${cutoff} | ${PER} sessions/bucket\n`);

  const [db, da, cb, ca] = await Promise.all([
    bucket(true, false, cutoff, PER), bucket(true, true, cutoff, PER),
    bucket(false, false, cutoff, PER), bucket(false, true, cutoff, PER),
  ]);
  console.log("scoring 4 buckets with the success/satisfaction judge...");
  const domBefore = await scoreBucket(db, "domain-before");
  const domAfter = await scoreBucket(da, "domain-after");
  const ctlBefore = await scoreBucket(cb, "control-before");
  const ctlAfter = await scoreBucket(ca, "control-after");

  const didS = (domAfter.suc - domBefore.suc) - (ctlAfter.suc - ctlBefore.suc);
  const didSat = (domAfter.sat - domBefore.sat) - (ctlAfter.sat - ctlBefore.sat);
  console.log(`\nDiff-in-differences (success):      ${didS >= 0 ? "+" : ""}${didS.toFixed(3)}`);
  console.log(`Diff-in-differences (satisfaction): ${didSat >= 0 ? "+" : ""}${didSat.toFixed(3)}`);
  console.log(`  domain Δ: success ${(domAfter.suc - domBefore.suc).toFixed(2)} / sat ${(domAfter.sat - domBefore.sat).toFixed(2)}  | control Δ: success ${(ctlAfter.suc - ctlBefore.suc).toFixed(2)} / sat ${(ctlAfter.sat - ctlBefore.sat).toFixed(2)}`);
  console.log(`\nINTERPRET: DiD > 0 => skill-domain outcomes improved beyond the baseline time trend => the`);
  console.log(`observational measure detects signal => attribution+A/B worth building. DiD ~0 => observational`);
  console.log(`alone won't suffice; need true A/B (label) — note confounds either way (this is quasi-experimental).`);
  console.log(`\ncost $${costSoFar().toFixed(2)} over ${callsSoFar()} calls`);
}

main().catch((e) => { console.error(e); process.exit(1); });
