// Validate the v1-vs-v2 measurement LOGIC in memory (no DB). Plant a VERSION effect:
//   planted skill: v2 sessions are GOOD, v1 sessions are BAD  -> expect big + (v2 beats v1)
//   null skill:    version assigned at random wrt quality       -> expect ~0
// Confirms the gate "did the edit (v1->v2) help?" recovers a known version effect.
import { callLLM } from "./llm.ts";
import { satisfactionJudge } from "./satisfaction.ts";
import { mapLimit } from "./util.ts";
import { costSoFar, callsSoFar } from "./llm.ts";

const N = Number(process.env.SPIKE_VER_N || 15); // per arm
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

async function gen(quality: "good" | "bad", i: number): Promise<string> {
  const want = quality === "good"
    ? "The assistant finds the correct root cause, applies a working fix, the FULL TEST SUITE PASSES, and the user explicitly confirms ('perfect, all tests pass, thanks'). Unambiguous success."
    : "The assistant gives wrong fixes that don't help, the crash KEEPS happening, the user repeatedly corrects it and finally gives up unresolved. Unambiguous failure.";
  const { text } = await callLLM("target", "You write realistic short AI-assistant session transcripts. Output only the transcript.",
    `Write a SHORT realistic transcript (~8 USER:/ASSISTANT: turns) of a pg_deeplake test-crash debugging session. ${want} Variation seed ${i}. Transcript only.`);
  return text;
}

async function main() {
  console.log(`IN-MEMORY v1-vs-v2 validation (${N}/arm, no DB)\n`);
  // planted skill: good sessions ran v2, bad sessions ran v1 (i.e. the v1->v2 edit "fixed" things).
  // null skill: version (1 or 2) assigned at random, uncorrelated with quality.
  const sessions = ((await mapLimit([...Array(N * 2).keys()], 5, async (k) => {
    const quality = k < N ? "good" : "bad";
    try {
      const s = await satisfactionJudge(await gen(quality, k));
      return {
        success: s.success as number,
        plantedVer: quality === "good" ? 2 : 1, // v2 correlates with success
        nullVer: (k % 2) + 1,                   // 1 or 2 at random wrt quality
      };
    } catch { return null; }
  })).filter(Boolean)) as Array<{ success: number; plantedVer: number; nullVer: number }>;
  console.log(`scored ${sessions.length}/${N * 2}\n`);

  const verEffect = (key: "plantedVer" | "nullVer") => {
    const v2 = sessions.filter((s) => s[key] === 2).map((s) => s.success);
    const v1 = sessions.filter((s) => s[key] === 1).map((s) => s.success);
    return { v2: mean(v2), v1: mean(v1), n2: v2.length, n1: v1.length, eff: mean(v2) - mean(v1) };
  };
  const p = verEffect("plantedVer"), nul = verEffect("nullVer");
  console.log(`PLANTED v1->v2 improvement: v2 success ${p.v2.toFixed(2)} (n=${p.n2}) vs v1 ${p.v1.toFixed(2)} (n=${p.n1})  => v2-v1 effect ${p.eff >= 0 ? "+" : ""}${p.eff.toFixed(3)}`);
  console.log(`NULL skill (v1~v2):        v2 success ${nul.v2.toFixed(2)} (n=${nul.n2}) vs v1 ${nul.v1.toFixed(2)} (n=${nul.n1})  => v2-v1 effect ${nul.eff >= 0 ? "+" : ""}${nul.eff.toFixed(3)}`);
  const pass = p.eff > 0.5 && Math.abs(nul.eff) < 0.2;
  console.log(`\n${pass ? "PASS" : "CHECK"}: ${pass ? "v1-vs-v2 gate recovers a planted version improvement and stays flat when v1~v2 — version comparison validated." : "separation not clean — inspect."}`);
  console.log(`\ncost $${costSoFar().toFixed(2)} over ${callsSoFar()} calls`);
}
main().catch((e) => { console.error(e); process.exit(1); });
