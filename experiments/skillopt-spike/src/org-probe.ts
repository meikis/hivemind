// Probe the org sessions table: volume, authors, message shape, posthog findability.
import { dquery, SESSIONS_TABLE as T } from "./deeplake.ts";

async function main() {
  const one = async (sql: string) => {
    try { return JSON.stringify((await dquery(sql))[0]); }
    catch (e) { return "ERR: " + (e as Error).message.slice(0, 160); }
  };
  console.log("table:", T);
  console.log("total rows:        ", await one(`SELECT COUNT(*) AS n FROM "${T}"`));
  console.log("distinct sessions: ", await one(`SELECT COUNT(DISTINCT filename) AS n FROM "${T}"`));
  console.log("distinct authors:  ", await one(`SELECT COUNT(DISTINCT author) AS n FROM "${T}"`));

  try {
    const s = await dquery(`SELECT id, filename, author, project, agent, creation_date FROM "${T}" LIMIT 3`);
    console.log("\nsample rows (no message):");
    for (const r of s) console.log("  ", JSON.stringify(r));
  } catch (e) { console.log("sample err:", (e as Error).message.slice(0, 160)); }

  try {
    const m = await dquery(`SELECT message FROM "${T}" LIMIT 1`);
    console.log("\nsample message JSONB:\n", JSON.stringify(m[0]).slice(0, 800));
  } catch (e) { console.log("message err:", (e as Error).message.slice(0, 160)); }

  // posthog findability — try JSONB-as-text (may hit pg_deeplake crash); catch.
  console.log("\nposthog sessions (CAST message AS TEXT ILIKE):",
    await one(`SELECT COUNT(DISTINCT filename) AS n FROM "${T}" WHERE CAST(message AS TEXT) ILIKE '%posthog%'`));
  console.log("posthog sessions (project ILIKE):",
    await one(`SELECT COUNT(DISTINCT filename) AS n FROM "${T}" WHERE project ILIKE '%posthog%'`));
}

main().catch((e) => { console.error(e); process.exit(1); });
