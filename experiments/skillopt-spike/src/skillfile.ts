import fs from "node:fs";

// Read a SKILL.md and return just the body (frontmatter stripped) — the part
// that actually acts as guidance in the target's system prompt.
export function readSkillBody(skillPath: string): string {
  const raw = fs.readFileSync(skillPath, "utf8");
  return raw.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
}
