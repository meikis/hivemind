/**
 * Shared AGENTS.md hivemind-block management.
 *
 * AGENTS.md is the global agent-instructions file that several harnesses
 * auto-load into the model's context every session — SILENTLY, with no
 * user-visible TUI cell:
 *   - pi    → `~/.pi/agent/AGENTS.md`
 *   - Codex → `~/.codex/AGENTS.md`
 *
 * We manage only a marker-fenced block and never touch the user's own
 * content. The marker pair is shared across harnesses (they write to
 * different files, so there is no collision).
 */

export const HIVEMIND_BLOCK_START = "<!-- BEGIN hivemind-memory -->";
export const HIVEMIND_BLOCK_END = "<!-- END hivemind-memory -->";

/**
 * Insert or replace the hivemind block in `existing`. `block` is the full
 * marker-fenced block (START … END). Idempotent: a prior block (matched on
 * the marker pair) is stripped before re-appending, so repeated installs
 * leave exactly one block. User content outside the markers is preserved.
 */
export function upsertMarkedBlock(
  existing: string | null,
  block: string,
  start: string = HIVEMIND_BLOCK_START,
  end: string = HIVEMIND_BLOCK_END,
): string {
  if (!existing) return `${block}\n`;
  const startIdx = existing.indexOf(start);
  if (startIdx === -1) return `${existing.trimEnd()}\n\n${block}\n`;
  const endIdx = existing.indexOf(end, startIdx);
  // Malformed prior block (no END) — append fresh and let the user clean up.
  if (endIdx === -1) return `${existing.trimEnd()}\n\n${block}\n`;
  const before = existing.slice(0, startIdx).trimEnd();
  const after = existing.slice(endIdx + end.length).replace(/^\n+/, "");
  const rest = after ? `\n\n${after}` : "";
  return `${before ? before + "\n\n" : ""}${block}\n${rest}`;
}

/** Remove the hivemind block from `existing`, preserving surrounding content. */
export function stripMarkedBlock(
  existing: string,
  start: string = HIVEMIND_BLOCK_START,
  end: string = HIVEMIND_BLOCK_END,
): string {
  const startIdx = existing.indexOf(start);
  if (startIdx === -1) return existing;
  const endIdx = existing.indexOf(end, startIdx);
  if (endIdx === -1) return existing;
  const before = existing.slice(0, startIdx).trimEnd();
  const after = existing.slice(endIdx + end.length).replace(/^\n+/, "");
  if (!before && !after) return "";
  if (!before) return after;
  if (!after) return `${before}\n`;
  return `${before}\n\n${after}`;
}
