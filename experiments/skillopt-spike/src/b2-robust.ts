// Test the untested: judge robustness. Re-score the same real sessions a second
// time and measure test-retest reliability (does the satisfaction-judge agree with
// itself?). Low |Δ| + preserved ranking = robust; high variance = noise.
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.ts";
import { discoverRecentSessions, reconstructCondense, sessionId } from "./orgsource.ts";
import { satisfactionJudge } from "./satisfaction.ts";
import { mapLimit } from "./util.ts";
import { costSoFar } from "./llm.ts";

async function main() {
  const run1: Array<{ id: string; sat: number }> =
    JSON.parse(fs.readFileSync(path.join(DATA_DIR, "b2-scored.json"), "utf8"));
  const cands = await discoverRecentSessions(40);
  const byId = new Map(cands.map((c) => [sessionId(c.filename).slice(0, 8), c.filename]));

  console.log(`re-scoring ${run1.length} sessions for test-retest reliability...`);
  const pairs = (await mapLimit(run1, 4, async (r) => {
    const file = byId.get(r.id);
    if (!file) return null;
    try {
      const text = await reconstructCondense(file);
      const s = await satisfactionJudge(text);
      return { id: r.id, sat1: r.sat, sat2: s.satisfaction };
    } catch { return null; }
  })).filter(Boolean) as Array<{ id: string; sat1: number; sat2: number }>;

  const diffs = pairs.map((p) => Math.abs(p.sat1 - p.sat2));
  const mad = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  // Pearson correlation
  const m = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const a = pairs.map((p) => p.sat1), b = pairs.map((p) => p.sat2);
  const ma = m(a), mb = m(b);
  const cov = a.map((x, i) => (x - ma) * (b[i] - mb)).reduce((s, v) => s + v, 0);
  const va = Math.sqrt(a.map((x) => (x - ma) ** 2).reduce((s, v) => s + v, 0));
  const vb = Math.sqrt(b.map((x) => (x - mb) ** 2).reduce((s, v) => s + v, 0));
  const pearson = cov / (va * vb);
  // Bottom-quartile agreement (does it flag the same worst sessions?)
  const k = Math.max(1, Math.floor(pairs.length / 4));
  const worst1 = new Set([...pairs].sort((x, y) => x.sat1 - y.sat1).slice(0, k).map((p) => p.id));
  const worst2 = new Set([...pairs].sort((x, y) => x.sat2 - y.sat2).slice(0, k).map((p) => p.id));
  const overlap = [...worst1].filter((id) => worst2.has(id)).length;

  console.log(`\nn=${pairs.length}  cost $${costSoFar().toFixed(2)}`);
  console.log(`mean abs Δsatisfaction (run1 vs run2): ${mad.toFixed(3)}  (lower = more stable)`);
  console.log(`Pearson correlation run1~run2:          ${pearson.toFixed(3)}  (higher = more reliable)`);
  console.log(`bottom-quartile agreement:              ${overlap}/${k} worst sessions flagged both runs`);
  console.log("\nper-session:");
  for (const p of pairs.sort((x, y) => x.sat1 - y.sat1)) console.log(`  [${p.id}] ${p.sat1.toFixed(2)} -> ${p.sat2.toFixed(2)}  (Δ${Math.abs(p.sat1 - p.sat2).toFixed(2)})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
