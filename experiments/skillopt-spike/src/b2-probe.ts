// B2-real prototype step 1+2: run the satisfaction-judge over real org sessions and
// validate it DISCRIMINATES — i.e. its satisfaction score tracks real surface signals
// (gratitude vs frustration in the user's own words), and the top/bottom sessions look
// genuinely good/bad on inspection.
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.ts";
import { discoverRecentSessions, reconstructCondense, sessionId } from "./orgsource.ts";
import { satisfactionJudge, lexicalSignal } from "./satisfaction.ts";
import { mapLimit } from "./util.ts";
import { costSoFar } from "./llm.ts";

const N = Number(process.env.SPIKE_B2_N || 24);

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const cands = await discoverRecentSessions(N + 10);
  console.log(`scoring satisfaction on ${Math.min(N, cands.length)} recent org sessions...`);

  const scored = (await mapLimit(cands.slice(0, N), 4, async (c) => {
    try {
      const text = await reconstructCondense(c.filename);
      if (text.length < 200) return null;
      const s = await satisfactionJudge(text);
      const lex = lexicalSignal(text);
      return { id: sessionId(c.filename).slice(0, 8), sat: s.satisfaction, success: s.success, lexNet: lex.net, grat: lex.grat, frust: lex.frust, sig: s.signals, rationale: s.rationale };
    } catch (e) {
      console.log(`  ${sessionId(c.filename).slice(0, 8)} ERR: ${(e as Error).message.slice(0, 70)}`);
      return null;
    }
  })).filter(Boolean) as Array<{ id: string; sat: number; success: 0 | 1; lexNet: number; grat: number; frust: number; sig: Record<string, boolean>; rationale: string }>;

  // Discrimination check: does judged satisfaction separate lexically-positive from
  // lexically-negative sessions?
  const pos = scored.filter((s) => s.lexNet > 0);
  const neg = scored.filter((s) => s.lexNet < 0);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  console.log(`\nscored ${scored.length} sessions | cost $${costSoFar().toFixed(2)}`);
  console.log(`satisfaction distribution: min ${Math.min(...scored.map((s) => s.sat)).toFixed(2)} / median ${scored.map((s) => s.sat).sort((a, b) => a - b)[Math.floor(scored.length / 2)].toFixed(2)} / max ${Math.max(...scored.map((s) => s.sat)).toFixed(2)}`);
  console.log(`DISCRIMINATION: avg sat where user words POSITIVE (${pos.length}) = ${avg(pos.map((s) => s.sat)).toFixed(2)}  vs  NEGATIVE (${neg.length}) = ${avg(neg.map((s) => s.sat)).toFixed(2)}`);

  const byS = [...scored].sort((a, b) => b.sat - a.sat);
  console.log("\nTOP 3 (judge says satisfied):");
  for (const s of byS.slice(0, 3)) console.log(`  [${s.id}] sat=${s.sat.toFixed(2)} succ=${s.success} lex(g${s.grat}/f${s.frust}) :: ${s.rationale.slice(0, 150)}`);
  console.log("BOTTOM 3 (judge says dissatisfied):");
  for (const s of byS.slice(-3)) console.log(`  [${s.id}] sat=${s.sat.toFixed(2)} succ=${s.success} lex(g${s.grat}/f${s.frust}) corrected=${s.sig.user_corrected} abandoned=${s.sig.task_abandoned} :: ${s.rationale.slice(0, 150)}`);

  fs.writeFileSync(path.join(DATA_DIR, "b2-scored.json"), JSON.stringify(byS, null, 2));
  console.log(`\nwrote data/b2-scored.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
