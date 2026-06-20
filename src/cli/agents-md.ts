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
  // Malformed prior block (a BEGIN with no END anywhere) — don't risk
  // truncating user content; append a fresh block. stripMarkedBlock can still
  // remove it later (it scans past the malformed marker for well-formed pairs).
  if (endIdx === -1) return `${existing.trimEnd()}\n\n${block}\n`;
  // Replace the FIRST block IN PLACE — keeping its position relative to the
  // user's own notes so their overrides keep their precedence — and strip any
  // DUPLICATE blocks from the tail (bad merge / manual paste collapse to one).
  const before = existing.slice(0, startIdx).trimEnd();
  const after = stripMarkedBlock(existing.slice(endIdx + end.length), start, end)
    .replace(/^\n+/, "")
    .trimEnd();
  const head = before ? `${before}\n\n` : "";
  const tail = after ? `\n\n${after}` : "";
  return `${head}${block}${tail}\n`;
}

/**
 * Remove EVERY hivemind block from `existing`, preserving surrounding content.
 * Loops so duplicate marker pairs are all removed; stops at a malformed
 * (BEGIN-without-END) block and leaves the remainder untouched so user data
 * after a half-written marker is never truncated.
 */
export function stripMarkedBlock(
  existing: string,
  start: string = HIVEMIND_BLOCK_START,
  end: string = HIVEMIND_BLOCK_END,
): string {
  let text = existing;
  for (;;) {
    const startIdx = text.indexOf(start);
    if (startIdx === -1) return text;
    const endIdx = text.indexOf(end, startIdx);
    // A BEGIN with no END after it — stop here, leaving the remainder intact so
    // a user's half-written marker (and any text under it) is never truncated.
    // Well-formed blocks earlier in the file have already been removed by now.
    if (endIdx === -1) return text;
    const before = text.slice(0, startIdx).trimEnd();
    const after = text.slice(endIdx + end.length).replace(/^\n+/, "");
    if (!before && !after) text = "";
    else if (!before) text = after;
    else if (!after) text = `${before}\n`;
    else text = `${before}\n\n${after}`;
  }
}
