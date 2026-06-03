// THROWAWAY spike config. All knobs in one place.
import path from "node:path";
import os from "node:os";

export const SKILL_PATH =
  process.env.SPIKE_SKILL_PATH ||
  path.join(os.homedir(), ".claude/skills/posthog-event-smoke-testing--kamo.aghbalyan/SKILL.md");

// Map source_session id -> located transcript .jsonl (resolved by dataprep via find).
export const TRANSCRIPT_ROOT =
  process.env.SPIKE_TRANSCRIPT_ROOT || path.join(os.homedir(), ".claude/projects");

export const SOURCE_SESSION_UUIDS = [
  "f995270d-16e1-4f84-92fd-24b109ee5739",
  "49e5e772-a244-4fa7-8c62-d9a9b70e33f3",
  "5a6b73e9-b00d-45c4-8da1-20d4cc0abf34",
  "9b46651c-39fa-4c15-bc02-8fdb5d578ed6",
  "73523fa7-9261-4c02-be10-cb1a8fa152dd",
  "8b1d04c1-4bae-47e5-b340-912a1a3c7f4f",
  "642a4dbe-e009-4854-8ade-b5ec71acd82e",
  "b93c1eb3-d5a2-4ff9-b444-0efc1083226a",
  "ced9560a-be48-4a9d-a18a-de0f5716ea48",
  // 4523923f-... omitted: 1-line stub, no usable content
];

export const DATA_DIR = process.env.SPIKE_DATA_DIR || path.join(process.cwd(), "data");
export const OUT_DIR = process.env.SPIKE_OUT_DIR || path.join(process.cwd(), "out");

// Models per role (overridable). Sonnet default for quality; uses whatever the
// `claude` CLI resolves (Claude Code -> Claude models, same pattern hivemind's gate uses).
export const MODELS = {
  target: process.env.SPIKE_TARGET_MODEL || "sonnet",
  optimizer: process.env.SPIKE_OPTIMIZER_MODEL || "sonnet",
  judge: process.env.SPIKE_JUDGE_MODEL || "sonnet",
  dataprep: process.env.SPIKE_DATAPREP_MODEL || "sonnet",
} as const;

// Loop hyperparameters (textual learning rate = edit budget).
export const EDIT_BUDGET = Number(process.env.SPIKE_EDIT_BUDGET || 3);
export const MAX_STEPS = Number(process.env.SPIKE_MAX_STEPS || 4);
export const MINIBATCH = Number(process.env.SPIKE_MINIBATCH || 4);

// Split sizes (over the usable derived tasks). Env-overridable so a big org-scale
// run can use a robust test/val instead of the tiny local-only defaults.
export const SPLIT = {
  test: Number(process.env.SPIKE_TEST || 3),
  val: Number(process.env.SPIKE_VAL || 2),
}; // remainder -> train

// Data mining (the skill has few on-topic source sessions, so we mine more
// PostHog sessions from the local transcript corpus — these double as the
// leakage-free pool since the skill was never trained on them).
export const CURRENT_SESSION_ID = process.env.CLAUDE_CODE_SESSION_ID || "";
export const RELEVANT_TARGET = Number(process.env.SPIKE_RELEVANT_TARGET || 12);
export const MINE_DISTILL_CAP = Number(process.env.SPIKE_MINE_CAP || 40);
export const MINE_CONCURRENCY = Number(process.env.SPIKE_MINE_CONCURRENCY || 4);
export const MINE_MIN_HITS = Number(process.env.SPIKE_MINE_MIN_HITS || 12); // raw-text hits
