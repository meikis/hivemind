// Investigate the "skills exist but didn't fire" gap. Crucial first check: did the
// skill exist BEFORE the failed session? If mined after, "didn't fire" is wrong framing.
import { dquery, SESSIONS_TABLE as T } from "./deeplake.ts";

const SKILLS_TABLE = process.env.HIVEMIND_SKILLS_TABLE || "skills";
const SKILL_NAMES = ["plan-confirm-then-execute", "ask-not-assume-approach", "verify-preconditions-before-design"];
// failed sessions from the gradient demo (id8 -> which skill the edit targeted)
const FAILED = [
  { id8: "bae23403", skill: "plan-confirm-then-execute" },
  { id8: "55a1fd85", skill: "ask-not-assume-approach" },
  { id8: "bdfc8b41", skill: "verify-preconditions-before-design" },
  { id8: "b8e4d529", skill: "hook-output-channel-constraints" },
];

async function main() {
  console.log("=== do these skills exist in the org skills table? (name, author, version, created_at) ===");
  for (const n of SKILL_NAMES.concat("hook-output-channel-constraints")) {
    try {
      const rows = await dquery(`SELECT name, author, version, created_at, project FROM "${SKILLS_TABLE}" WHERE name ILIKE '%${n.replace(/'/g, "''")}%' ORDER BY created_at ASC LIMIT 5`);
      if (!rows.length) { console.log(`  ${n}: NOT FOUND in org table`); continue; }
      for (const r of rows) console.log(`  ${r.name} | author=${r.author} v${r.version} | created ${r.created_at} | project=${r.project}`);
    } catch (e) { console.log(`  ${n}: query err ${(e as Error).message.slice(0, 80)}`); }
  }

  console.log("\n=== failed session dates vs skill creation (did the skill exist yet?) ===");
  for (const f of FAILED) {
    try {
      const s = await dquery(`SELECT MIN(creation_date) AS first, author FROM "${T}" WHERE filename ILIKE '%${f.id8}%' GROUP BY author LIMIT 1`);
      const sk = await dquery(`SELECT MIN(created_at) AS created FROM "${SKILLS_TABLE}" WHERE name ILIKE '%${f.skill}%'`);
      const sessDate = s[0]?.first ?? "?";
      const skillDate = sk[0]?.created ?? "(none)";
      const order = (sessDate !== "?" && skillDate !== "(none)") ? (String(skillDate) < String(sessDate) ? "skill EXISTED before session -> recall/adherence gap" : "skill mined AFTER session -> not a gap (learned later)") : "indeterminate";
      console.log(`  [${f.id8}] session ${sessDate} (by ${s[0]?.author}) | skill '${f.skill}' first created ${skillDate}\n     => ${order}`);
    } catch (e) { console.log(`  [${f.id8}] err ${(e as Error).message.slice(0, 80)}`); }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
