// Synthetic validation of the MEASUREMENT LOGIC, in memory (no Deeplake → no rate limit).
// Plant a known truth and confirm the judge+split+effect recovers it cleanly:
//   skill X present in GOOD sessions, absent in BAD  -> expect big + effect
//   skill Y assigned at random regardless of quality -> expect ~0 effect
// Sharper good/bad fakes than the DB version so the judge scores them unambiguously.
import { callLLM } from "./llm.ts";
import { satisfactionJudge } from "./satisfaction.ts";
import { mapLimit } from "./util.ts";
import { costSoFar, callsSoFar } from "./llm.ts";

const N = Number(process.env.SPIKE_LOCAL_N || 15); // per arm
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

async function gen(quality: "good" | "bad", i: number): Promise<string> {
  const want = quality === "good"
    ? "The assistant immediately finds the correct root cause, applies a concrete working fix with real commands, the FULL TEST SUITE PASSES (green), and the user explicitly confirms ('perfect — all tests pass, that fixed it, thanks'). Unambiguous success."
    : "The assistant gives wrong diagnoses and fixes that don't compile or don't help, the crash KEEPS happening, the user repeatedly corrects it ('no, wrong', 'still crashing', 'you broke the build') and finally gives up with it unresolved. Unambiguous failure.";
  const { text } = await callLLM("target", "You write realistic short AI-assistant session transcripts. Output only the transcript.",
    `Write a SHORT realistic transcript (~8 USER:/ASSISTANT: turns) of a pg_deeplake test-crash debugging session (WAL/streaming/scan crash, Deeplake C++/pg backend). ${want} Variation seed ${i}. Concrete + technical. Transcript only.`);
  return text;
}

async function main() {
  console.log(`IN-MEMORY synthetic validation (${N}/arm, no DB)\n`);
  const sessions = ((await mapLimit([...Array(N * 2).keys()], 5, async (k) => {
    const quality = k < N ? "good" : "bad";
    try {
      const transcript = await gen(quality, k);
      const s = await satisfactionJudge(transcript);
      return {
        quality,
        success: s.success as number,
        sat: s.satisfaction,
        hasX: quality === "good", // planted: X correlates with success
        hasY: k % 2 === 0,        // null: random wrt quality
      };
    } catch { return null; }
  })).filter(Boolean)) as Array<{ quality: string; success: number; sat: number; hasX: boolean; hasY: boolean }>;
  console.log(`scored ${sessions.length}/${N * 2} sessions (rest dropped on judge parse error)\n`);

  const eff = (key: "hasX" | "hasY", metric: "success" | "sat") => {
    const t = sessions.filter((s) => s[key]).map((s) => s[metric] as number);
    const c = sessions.filter((s) => !s[key]).map((s) => s[metric] as number);
    return { t: mean(t), c: mean(c), nt: t.length, nc: c.length, eff: mean(t) - mean(c) };
  };

  const xs = eff("hasX", "success"), ys = eff("hasY", "success");
  const xsat = eff("hasX", "sat"), ysat = eff("hasY", "sat");
  console.log(`raw judge means: GOOD arm success ${mean(sessions.filter(s=>s.quality==="good").map(s=>s.success)).toFixed(2)} / BAD arm success ${mean(sessions.filter(s=>s.quality==="bad").map(s=>s.success)).toFixed(2)}\n`);
  console.log(`PLANTED +  skill X: treatment success ${xs.t.toFixed(2)} (n=${xs.nt}) vs control ${xs.c.toFixed(2)} (n=${xs.nc})  => effect ${xs.eff>=0?"+":""}${xs.eff.toFixed(3)} (sat ${xsat.eff>=0?"+":""}${xsat.eff.toFixed(3)})`);
  console.log(`PLANTED 0  skill Y: treatment success ${ys.t.toFixed(2)} (n=${ys.nt}) vs control ${ys.c.toFixed(2)} (n=${ys.nc})  => effect ${ys.eff>=0?"+":""}${ys.eff.toFixed(3)} (sat ${ysat.eff>=0?"+":""}${ysat.eff.toFixed(3)})`);
  const pass = xs.eff > 0.5 && Math.abs(ys.eff) < 0.2;
  console.log(`\n${pass ? "PASS" : "CHECK"}: ${pass ? "tool cleanly recovers the planted effect and stays flat on the null — measurement machinery validated." : "separation not clean — inspect."}`);
  console.log(`\ncost $${costSoFar().toFixed(2)} over ${callsSoFar()} calls`);
}
main().catch((e) => { console.error(e); process.exit(1); });
