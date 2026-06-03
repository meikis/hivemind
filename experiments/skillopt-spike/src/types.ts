export type EditOp = "append" | "insert_after" | "replace" | "delete";

export interface Edit {
  op: EditOp;
  content?: string; // for append/insert_after/replace
  target?: string; // for insert_after/replace/delete
  source_type?: "failure" | "success";
}

export interface Patch {
  reasoning: string;
  edits: Edit[];
}

export interface Task {
  id: string; // session uuid
  taskPrompt: string; // situation/goal, solution stripped
  referenceOutcome: string; // what actually worked (judge anchor)
  posthogRelevant: boolean;
  provenance: "source" | "mined"; // source = in skill's source_sessions (leakage risk); mined = clean
}

export interface Score {
  hard: 0 | 1;
  soft: number; // [0,1]
  rationale: string;
}

export interface Rollout {
  taskId: string;
  withSkill: boolean;
  output: string;
  score: Score;
  costUsd: number;
}
