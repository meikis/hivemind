// SYNTHETIC E2E VALIDATION of the measurement machinery, in an ISOLATED test table.
// We plant a KNOWN truth and check the pipeline recovers it:
//   - skill X (planted +): present in GOOD sessions, absent in BAD sessions  -> expect large + effect
//   - skill Y (null):      present in a random half regardless of quality     -> expect ~0 effect
// If recovered, the instrument+consumer correctly detect skill value when it exists (and don't
// hallucinate it when it doesn't). Does NOT prove real skills help — validates the measurement.
import { dquery } from "./deeplake.ts";
import { buildCreateTableSql, SESSIONS_COLUMNS } from "../../../src/deeplake-schema.ts";
import { satisfactionJudge } from "./satisfaction.ts";
import { callLLM } from "./llm.ts";
import { mapLimit } from "./util.ts";
import { costSoFar, callsSoFar } from "./llm.ts";

const TABLE = process.env.SPIKE_SYNTH_TABLE || "sessions_skillopt_synth";
const N = Number(process.env.SPIKE_SYNTH_N || 6); // per quality arm
const SKILL_X = "pg-deeplake-test-crash-debugging"; // planted positive
const SKILL_Y = "synthetic-null-skill"; // planted null
const sql = (s: string) => s.replace(/'/g, "''");
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

async function insertMsg(filename: string, entry: Record<string, unknown>) {
  const line = JSON.stringify(entry);
  const j = line.replace(/'/g, "''");
  await dquery(
    `INSERT INTO "${TABLE}" (id, path, filename, message, message_embedding, author, size_bytes, project, description, agent, plugin_version, creation_date, last_update_date) ` +
    `VALUES ('${crypto.randomUUID()}', '/synth/${sql(filename)}', '${sql(filename)}', '${j}'::jsonb, NULL, 'synth', ${Buffer.byteLength(line)}, 'synth', '', 'synth', 'spike', '${new Date().toISOString()}', '${new Date().toISOString()}')`,
  );
}

async function genTranscript(quality: "good" | "bad", i: number): Promise<string> {
  const want = quality === "good"
    ? "The assistant nails it: correct root cause, a concrete working fix with real commands, the test suite goes GREEN, and the user explicitly confirms success ('perfect, all tests pass, that fixed it — thanks'). Unambiguously resolved."
    : "The assistant flails: wrong diagnoses, fixes that don't compile or don't help, the crash persists, the user repeatedly corrects it ('no, that's wrong', 'still crashing', 'you broke the build') and finally gives up unresolved. Unambiguously a failure.";
  const { text } = await callLLM("target", "You write realistic short AI-assistant session transcripts. Output only the transcript.",
    `Write a SHORT realistic transcript (~8 turns, USER:/ASSISTANT: lines) of a pg_deeplake test-crash debugging session (WAL/streaming/scan crash in the Deeplake C++/pg backend). ${want} Variation seed ${i}. Concrete and technical. Transcript only.`);
  return text;
}

async function seedSession(quality: "good" | "bad", idx: number, hasX: boolean, hasY: boolean) {
  const filename = `synth_${quality}_${idx}_${crypto.randomUUID().slice(0, 8)}.jsonl`;
  const skills: { name: string; author: string }[] = [];
  if (hasX) skills.push({ name: SKILL_X, author: "sasun" });
  if (hasY) skills.push({ name: SKILL_Y, author: "synth" });
  await insertMsg(filename, { type: "skills_active", session_id: filename, skills, skills_count: skills.length, ab_bucket: idx % 2 });
  const transcript = await genTranscript(quality, idx);
  // store the transcript as a couple of message rows the consumer can reconstruct
  for (const line of transcript.split(/\n(?=USER:|ASSISTANT:)/)) {
    const role = line.startsWith("ASSISTANT:") ? "assistant_message" : "user_message";
    const content = line.replace(/^(USER:|ASSISTANT:)\s*/, "").trim();
    if (content) await insertMsg(filename, { type: role, content });
  }
  return filename;
}

async function reconstruct(filename: string): Promise<string> {
  const rows = await dquery(`SELECT message FROM "${TABLE}" WHERE filename='${sql(filename)}' ORDER BY creation_date ASC`);
  const parts: string[] = [];
  for (const r of rows) {
    const m = typeof r.message === "string" ? JSON.parse(r.message) : r.message as any;
    if (m?.type === "user_message" && m.content) parts.push(`USER: ${m.content}`);
    else if (m?.type === "assistant_message" && m.content) parts.push(`ASSISTANT: ${m.content}`);
  }
  return parts.join("\n\n");
}

async function measureSkill(skill: string): Promise<{ effect: number; t: number; c: number; nt: number; nc: number }> {
  // Match quoted value tokens — spacing-independent (pg serializes jsonb as `"k": "v"`).
  const treatF = (await dquery(`SELECT DISTINCT filename FROM "${TABLE}" WHERE CAST(message AS TEXT) ILIKE '%"skills_active"%' AND CAST(message AS TEXT) ILIKE '%"${sql(skill)}"%'`)).map((r) => String(r.filename));
  const ctrlF = (await dquery(`SELECT DISTINCT filename FROM "${TABLE}" WHERE CAST(message AS TEXT) ILIKE '%"skills_active"%' AND CAST(message AS TEXT) NOT ILIKE '%"${sql(skill)}"%'`)).map((r) => String(r.filename));
  const sc = async (files: string[]) => mean((await mapLimit(files, 6, async (f) => { try { return (await satisfactionJudge(await reconstruct(f))).success; } catch { return null; } })).filter((x): x is 0 | 1 => x !== null));
  const t = await sc(treatF), c = await sc(ctrlF);
  return { effect: t - c, t, c, nt: treatF.length, nc: ctrlF.length };
}

async function main() {
  console.log(`SYNTHETIC VALIDATION in isolated table '${TABLE}' (${N}/arm)\n`);
  // create the isolated test table with the real sessions schema, then probe write.
  try {
    await dquery(buildCreateTableSql(TABLE, SESSIONS_COLUMNS));
    console.log(`ensured test table '${TABLE}'`);
    await insertMsg(`__probe_${crypto.randomUUID().slice(0, 6)}.jsonl`, { type: "user_message", content: "probe" });
  } catch (e) { console.error(`WRITE PROBE FAILED — can't create/write test table: ${(e as Error).message}`); process.exit(1); }
  console.log("write probe ok");

  if (process.env.SPIKE_SYNTH_SEED !== "0") {
    // GOOD sessions: skill X present; SKILL_Y present in a random half.
    // BAD sessions: skill X absent; SKILL_Y present in a random half.
    console.log("seeding synthetic sessions...");
    await mapLimit([...Array(N).keys()], 2, async (i) => { await seedSession("good", i, true, i % 2 === 0); });
    await mapLimit([...Array(N).keys()], 2, async (i) => { await seedSession("bad", i, false, i % 2 === 0); });
    console.log(`seeded ${N * 2} sessions.`);
  } else {
    console.log("SPIKE_SYNTH_SEED=0 → measuring existing seeded data only.");
  }
  console.log("measuring...\n");

  const x = await measureSkill(SKILL_X);
  const y = await measureSkill(SKILL_Y);
  console.log(`PLANTED +effect skill '${SKILL_X}': treatment success ${x.t.toFixed(2)} (n=${x.nt}) vs control ${x.c.toFixed(2)} (n=${x.nc})  =>  recovered effect ${x.effect >= 0 ? "+" : ""}${x.effect.toFixed(3)}`);
  console.log(`PLANTED null skill   '${SKILL_Y}': treatment success ${y.t.toFixed(2)} (n=${y.nt}) vs control ${y.c.toFixed(2)} (n=${y.nc})  =>  recovered effect ${y.effect >= 0 ? "+" : ""}${y.effect.toFixed(3)}`);
  const pass = x.effect > 0.3 && Math.abs(y.effect) < 0.2;
  console.log(`\n${pass ? "PASS" : "INCONCLUSIVE"}: ${pass ? "pipeline recovered the planted +effect AND stayed flat on the null — measurement machinery validated." : "did not cleanly separate planted vs null — inspect."}`);
  console.log(`\ncost $${costSoFar().toFixed(2)} over ${callsSoFar()} calls | test table: ${TABLE} (isolated; drop with DROP TABLE when done)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
