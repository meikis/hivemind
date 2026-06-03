// Deliverable: assemble OPTIMIZED versions of real org skills from the B2 proposals
// (real-session-mined, competence-filtered edits), so they can be A/B tested in real use.
// Writes original + optimized + a change summary per skill. (Validation is the user's online test.)
import fs from "node:fs";
import path from "node:path";
import { OUT_DIR, DATA_DIR } from "./config.ts";
import { dquery } from "./deeplake.ts";

interface Proposal { id: string; sat: number; target_skill: string; is_new_skill: boolean; edit: string; root_mistake: string }

async function main() {
  const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "org-optimize.json"), "utf8")) as { proposals: Proposal[] };
  const outDir = path.join(OUT_DIR, "optimized-skills");
  fs.mkdirSync(outDir, { recursive: true });

  // group proposals to EXISTING org skills (skip NEW-skill proposals -> separate file)
  const bySkill = new Map<string, Proposal[]>();
  const newSkills: Proposal[] = [];
  for (const p of data.proposals) {
    if (p.is_new_skill) { newSkills.push(p); continue; }
    if (!bySkill.has(p.target_skill)) bySkill.set(p.target_skill, []);
    bySkill.get(p.target_skill)!.push(p);
  }

  const summary: string[] = ["# B2-optimized org skills (for real-world A/B testing)\n"];
  for (const [skill, ps] of bySkill) {
    const rows = await dquery(`SELECT body FROM "skills" WHERE name='${skill.replace(/'/g, "''")}' ORDER BY version DESC LIMIT 1`);
    if (!rows.length) { summary.push(`- ${skill}: NOT in org table, skipped\n`); continue; }
    const orig = String(rows[0].body);
    const additions = ps.map((p) => `\n\n${p.edit.trim()}\n<!-- source: real session ${p.id} (sat ${p.sat.toFixed(2)}) — ${p.root_mistake.slice(0, 120)} -->`).join("");
    const optimized = orig.replace(/\s*$/, "") + additions + "\n";
    fs.writeFileSync(path.join(outDir, `${skill}.original.md`), orig);
    fs.writeFileSync(path.join(outDir, `${skill}.optimized.md`), optimized);
    summary.push(`## ${skill}  (+${ps.length} rule${ps.length > 1 ? "s" : ""}, ${orig.length}→${optimized.length} chars)`);
    for (const p of ps) summary.push(`  - from session ${p.id} (sat ${p.sat.toFixed(2)}): ${p.edit.split("\n")[0].slice(0, 100)}`);
    summary.push("");
  }
  if (newSkills.length) {
    summary.push(`## Proposed NEW shared skills (${newSkills.length})`);
    for (const p of newSkills) {
      fs.writeFileSync(path.join(outDir, `NEW--${p.target_skill}.md`), `# ${p.target_skill}\n\n${p.edit.trim()}\n<!-- source: real session ${p.id} (sat ${p.sat.toFixed(2)}) -->\n`);
      summary.push(`  - ${p.target_skill}: ${p.edit.split("\n")[0].slice(0, 100)} (from ${p.id})`);
    }
  }
  fs.writeFileSync(path.join(outDir, "SUMMARY.md"), summary.join("\n"));
  console.log(summary.join("\n"));
  console.log(`\nwrote ${bySkill.size} optimized org skills + ${newSkills.length} new-skill proposals to ${outDir}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
