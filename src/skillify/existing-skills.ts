/**
 * Build the "existing skills" block the gate prompt sees, from both the
 * project-local skills root (`<cwd>/.claude/skills`) and the user-global
 * one (`~/.claude/skills`).
 *
 * Why both roots: the autopull lands pulled skills under the global root
 * regardless of scope-config, while the worker used to read only the
 * project root. That asymmetry meant the gate was making KEEP/MERGE
 * decisions blind to skills the user already had globally — the root
 * cause of cross-author duplicates (e.g. two near-identical "standup"
 * skills mined a few days apart because the gate never saw the first).
 *
 * Cross-author MERGE policy (issue #118): MERGE is now allowed on any
 * skill in the block, including ones authored by other teammates. When
 * the editor is not the original author, the worker's recordToDeeplake
 * path auto-promotes `scope` from "me" to "team" and appends the editor
 * to the `contributors` array on the v+1 row. The gate prompt declares
 * this so the LLM understands the "promotion" cost is real and only
 * picks cross-author MERGE when the new evidence genuinely extends the
 * existing skill (rather than as a default).
 */

import { listSkills, resolveSkillsRoot, parseFrontmatter } from "./skill-writer.js";

export interface TaggedSkill {
  name: string;
  body: string;
  source: "project" | "global";
  /**
   * Author parsed from the SKILL.md frontmatter. Undefined for legacy
   * files that pre-date the `author` field — the worker treats those as
   * "owned by whoever's about to edit" (same-author semantics) so a
   * legacy local file isn't accidentally treated as cross-author.
   */
  author?: string;
}

export interface ExistingSkillsBlock {
  /** Names eligible as MERGE targets. Empty when no skills exist. */
  mergeTargetNames: string[];
  /** Rendered block of all skills (project + global) for the gate prompt. */
  block: string;
}

/**
 * Collect every existing skill the gate should know about, with its
 * source root + author tagged. If a name collides across roots, the
 * project copy wins (the user is presumed to be actively editing it
 * locally).
 */
export function listAllExistingSkills(cwd: string): TaggedSkill[] {
  const projectRoot = resolveSkillsRoot("project", cwd);
  const globalRoot = resolveSkillsRoot("global", cwd);
  const tag = (source: "project" | "global") => (s: { name: string; body: string }): TaggedSkill => {
    const parsed = parseFrontmatter(s.body);
    const author = typeof parsed?.fm.author === "string" && parsed.fm.author.length > 0
      ? parsed.fm.author
      : undefined;
    return { name: s.name, body: s.body, source, author };
  };
  const tagged: TaggedSkill[] = [
    ...listSkills(projectRoot).map(tag("project")),
    ...listSkills(globalRoot).map(tag("global")),
  ];
  const seen = new Set<string>();
  const out: TaggedSkill[] = [];
  for (const s of tagged) {
    if (seen.has(s.name)) continue;
    seen.add(s.name);
    out.push(s);
  }
  return out;
}

/**
 * Render the gate-prompt block. `charCap` is the soft budget — once we
 * cross it, we emit a "[…N more omitted]" line and stop.
 */
export function renderExistingSkillsBlock(cwd: string, charCap: number): ExistingSkillsBlock {
  const skills = listAllExistingSkills(cwd);
  if (skills.length === 0) {
    return {
      mergeTargetNames: [],
      block: "(no existing skills — MERGE is NOT a valid choice; pick KEEP or SKIP only)",
    };
  }
  // Every skill is now a valid MERGE target — cross-author MERGE triggers
  // an auto-promotion of `scope` to "team" plus an append to the
  // `contributors` column, instead of being forbidden.
  const mergeTargetNames = skills.map(s => s.name);
  let total = 0;
  const out: string[] = [];
  for (const s of skills) {
    // Tag captures both the install root (project vs global) and the
    // author so the gate prompt can communicate "this one's yours / this
    // one's a teammate's; MERGE is allowed either way but promotion
    // applies when authors differ".
    const sourceTag = s.source === "project" ? "project" : "global";
    const authorTag = s.author ? `, author=${s.author}` : "";
    const block = `--- existing skill [${sourceTag}${authorTag}]: ${s.name} ---\n${s.body}\n`;
    if (total + block.length > charCap) {
      out.push(`[…${skills.length - out.length} more existing skills omitted]`);
      break;
    }
    out.push(block);
    total += block.length;
  }
  return { mergeTargetNames, block: out.join("\n") };
}
