// Parse a Claude Code session .jsonl into a condensed prompt/answer view:
// real user prompts + assistant text, with tool calls / tool results / thinking removed.
import fs from "node:fs";
import path from "node:path";

export function findTranscript(root: string, uuid: string): string | null {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (ent.name === `${uuid}.jsonl`) return full;
    }
  }
  return null;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && typeof b === "object" && (b as { type?: string }).type === "text")
      .map((b) => (b as { text?: string }).text ?? "")
      .join("\n");
  }
  return "";
}

export interface Candidate {
  uuid: string;
  file: string;
  hits: number; // posthog mentions in condensed prompt/answer text
}

// Walk transcripts, rank by how PostHog-focused they look (mentions in real
// prompt/answer text, not tool noise). Excludes given uuids + subagent files.
export function discoverPosthogCandidates(
  root: string,
  excludeUuids: Set<string>,
  minHits = 8,
): Candidate[] {
  const out: Candidate[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === "subagents") continue; // skip subagent traces
        stack.push(full);
        continue;
      }
      if (!ent.name.endsWith(".jsonl")) continue;
      const uuid = ent.name.replace(/\.jsonl$/, "");
      if (excludeUuids.has(uuid)) continue;
      // Count in the RAW transcript (incl. tool output/code) so PostHog sessions
      // whose work was tool-heavy still surface; the posthog_relevant LLM flag
      // filters out incidental mentions downstream.
      let raw: string;
      try {
        raw = fs.readFileSync(full, "utf8");
      } catch {
        continue;
      }
      const hits = (raw.match(/posthog/gi) || []).length;
      if (hits >= minHits) out.push({ uuid, file: full, hits });
    }
  }
  return out.sort((a, b) => b.hits - a.hits);
}

export function condenseTranscript(file: string, maxChars = 14_000): string {
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  const parts: string[] = [];
  for (const line of lines) {
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const type = rec.type as string | undefined;
    // Skip tool-result user records (they carry toolUseResult) and meta records.
    if (rec.toolUseResult || rec.isMeta) continue;
    const msg = rec.message as { role?: string; content?: unknown } | undefined;
    if (!msg) continue;
    const text = textFromContent(msg.content).trim();
    if (!text) continue;
    if (type === "user" && msg.role === "user") {
      parts.push(`USER: ${text}`);
    } else if (type === "assistant") {
      parts.push(`ASSISTANT: ${text}`);
    }
  }
  // Keep the head (where the task is set up) and the tail (where the outcome lands).
  let joined = parts.join("\n\n");
  if (joined.length > maxChars) {
    const head = joined.slice(0, Math.floor(maxChars * 0.55));
    const tail = joined.slice(joined.length - Math.floor(maxChars * 0.45));
    joined = `${head}\n\n...[middle elided]...\n\n${tail}`;
  }
  return joined;
}
