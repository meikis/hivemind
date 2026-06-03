// TS port of SkillOpt's edit-application (skillopt/optimizer/skill.py).
// Bounded structured edits over a markdown skill doc. Edits that target the
// protected slow-update region are skipped (slow-update is deferred in this spike,
// but the protection is kept so the logic ports cleanly to hivemind later).
import type { Edit } from "./types.ts";

const SU_START = "<!-- SLOW_UPDATE_START -->";
const SU_END = "<!-- SLOW_UPDATE_END -->";

function protectedRange(skill: string): [number, number] | null {
  const a = skill.indexOf(SU_START);
  const b = skill.indexOf(SU_END);
  if (a === -1 || b === -1 || b < a) return null;
  return [a, b + SU_END.length];
}

function targetsProtected(skill: string, target: string): boolean {
  const r = protectedRange(skill);
  if (!r || !target) return false;
  const idx = skill.indexOf(target);
  return idx !== -1 && idx >= r[0] && idx < r[1];
}

export interface ApplyResult {
  skill: string;
  report: string[];
}

export function applyEdits(skill: string, edits: Edit[]): ApplyResult {
  let s = skill;
  const report: string[] = [];

  for (const e of edits) {
    if (e.target && targetsProtected(s, e.target)) {
      report.push(`SKIP ${e.op}: targets protected slow-update region`);
      continue;
    }
    switch (e.op) {
      case "append": {
        const content = (e.content ?? "").trim();
        if (!content) { report.push("SKIP append: empty content"); break; }
        const r = protectedRange(s);
        if (r) {
          s = s.slice(0, r[0]) + content + "\n\n" + s.slice(r[0]);
        } else {
          s = s.replace(/\s*$/, "") + "\n\n" + content + "\n";
        }
        report.push(`OK append (+${content.length} chars)`);
        break;
      }
      case "insert_after": {
        const target = e.target ?? "";
        const content = (e.content ?? "").trim();
        if (!target || !content) { report.push("SKIP insert_after: missing target/content"); break; }
        const idx = s.indexOf(target);
        if (idx === -1) { report.push(`SKIP insert_after: target not found`); break; }
        const lineEnd = s.indexOf("\n", idx + target.length);
        const at = lineEnd === -1 ? s.length : lineEnd;
        s = s.slice(0, at) + "\n" + content + s.slice(at);
        report.push(`OK insert_after`);
        break;
      }
      case "replace": {
        const target = e.target ?? "";
        const content = e.content ?? "";
        if (!target) { report.push("SKIP replace: missing target"); break; }
        const idx = s.indexOf(target);
        if (idx === -1) { report.push(`SKIP replace: target not found`); break; }
        s = s.slice(0, idx) + content + s.slice(idx + target.length);
        report.push(`OK replace`);
        break;
      }
      case "delete": {
        const target = e.target ?? "";
        if (!target) { report.push("SKIP delete: missing target"); break; }
        const idx = s.indexOf(target);
        if (idx === -1) { report.push(`SKIP delete: target not found`); break; }
        s = s.slice(0, idx) + s.slice(idx + target.length);
        report.push(`OK delete`);
        break;
      }
      default:
        report.push(`SKIP unknown op: ${(e as Edit).op}`);
    }
  }
  return { skill: s, report };
}
