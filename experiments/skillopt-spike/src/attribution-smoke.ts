// E2E smoke: exercise the REAL attribution helper (src/skillify/skills-active.ts) against
// the live Deeplake sessions table — confirm a skills_active row writes, lands, and is
// queryable by skill name + bucket. Uses a clearly-synthetic, identifiable session id.
import { dquery } from "./deeplake.ts";
import {
  listActiveOrgSkills, sessionBucket, buildSkillsActiveInsert,
} from "../../../src/skillify/skills-active.ts";

async function main() {
  const sessionId = "skillopt-smoke-" + new Date().toISOString().replace(/[:.]/g, "-");
  const skills = listActiveOrgSkills(); // reads ~/.claude/skills — real org skills present
  console.log(`enumerated ${skills.length} org skills on disk; sample:`, skills.slice(0, 3).map((s) => `${s.name}--${s.author}`));
  const bucket = sessionBucket(sessionId);

  const sql = buildSkillsActiveInsert({
    sessionsTable: "sessions",
    sessionPath: `/sessions/skillopt-smoke/${sessionId}.jsonl`,
    filename: `${sessionId}.jsonl`,
    userName: "skillopt-smoke",
    projectName: "skillopt-spike",
    pluginVersion: "spike",
    sessionId,
    cwd: "/tmp/skillopt-smoke",
    skills,
    bucket,
    ts: new Date().toISOString(),
  });

  console.log("\nwriting skills_active row...");
  await dquery(sql);
  console.log("insert ok; reading it back...");

  const rows = await dquery(
    `SELECT message FROM "sessions" WHERE CAST(message AS TEXT) ILIKE '%${sessionId}%' LIMIT 2`,
  );
  if (!rows.length) throw new Error("row did not land");
  const msg = typeof rows[0].message === "string" ? JSON.parse(rows[0].message as string) : rows[0].message;
  const m = (msg as { message?: unknown }).message ?? msg;
  console.log("READBACK ok:");
  console.log("  type        :", (m as any).type);
  console.log("  skills_count:", (m as any).skills_count);
  console.log("  ab_bucket   :", (m as any).ab_bucket);
  console.log("  first skill :", JSON.stringify((m as any).skills?.[0]));

  // Confirm it's queryable by a specific skill name (the measurement access pattern)
  const probeName = skills[0]?.name;
  if (probeName) {
    const hit = await dquery(
      `SELECT COUNT(*) AS n FROM "sessions" WHERE CAST(message AS TEXT) ILIKE '%skills_active%' AND CAST(message AS TEXT) ILIKE '%"name":"${probeName}"%' AND CAST(message AS TEXT) ILIKE '%${sessionId}%'`,
    );
    console.log(`\nqueryable by skill name '${probeName}': COUNT=${JSON.stringify(hit[0])} (expect 1)`);
  }
  console.log(`\nsmoke session id (identifiable test row): ${sessionId}`);
}

main().catch((e) => { console.error("SMOKE FAILED:", e.message); process.exit(1); });
