// Build a large task set from ORG-wide PostHog sessions (the whole team's corpus).
// Writes to a separate data file so it doesn't clobber the local-only set.
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, SOURCE_SESSION_UUIDS, MINE_CONCURRENCY } from "./config.ts";
import { discoverOrgPosthogSessions, reconstructCondense, sessionId } from "./orgsource.ts";
import { distillText } from "./distill.ts";
import { mapLimit } from "./util.ts";
import { costSoFar } from "./llm.ts";
import type { Task } from "./types.ts";

const CAP = Number(process.env.SPIKE_ORG_CAP || 60);
const OUT = path.join(DATA_DIR, "tasks-org.json");

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const existing: Task[] = (() => { try { return JSON.parse(fs.readFileSync(OUT, "utf8")); } catch { return []; } })();
  const seen = new Set(existing.map((t) => t.id));
  const tasks: Task[] = [...existing];
  if (existing.length) console.log(`loaded ${existing.length} existing org tasks`);

  const candidates = await discoverOrgPosthogSessions(CAP, [...SOURCE_SESSION_UUIDS]);
  const todo = candidates.filter((c) => !seen.has(sessionId(c.filename)));
  console.log(`discovered ${candidates.length} org posthog sessions; ${todo.length} new to distill (concurrency ${MINE_CONCURRENCY})`);

  const mined = await mapLimit(todo, MINE_CONCURRENCY, async (c) => {
    const id = sessionId(c.filename);
    try {
      const condensed = await reconstructCondense(c.filename);
      const t = await distillText(condensed, id, "mined");
      console.log(`  ${id.slice(0, 8)} (${c.hits} hits, ${condensed.length} chars) -> ${t ? `posthog=${t.posthogRelevant}` : "FAIL/empty"}`);
      return t;
    } catch (e) {
      console.log(`  ${id.slice(0, 8)} ERROR: ${(e as Error).message.slice(0, 80)}`);
      return null;
    }
  });
  for (const t of mined) if (t) tasks.push(t);

  fs.writeFileSync(OUT, JSON.stringify(tasks, null, 2));
  const rel = tasks.filter((t) => t.posthogRelevant);
  console.log(`\nWrote ${tasks.length} org tasks (${rel.length} posthog-relevant) -> ${OUT} | cost so far $${costSoFar().toFixed(2)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
