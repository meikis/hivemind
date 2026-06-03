// Run the frozen target model on a task, with or without the skill in its system prompt.
import { callLLM } from "./llm.ts";
import { TARGET_SYS_BASE, targetSysWithSkill } from "./prompts.ts";
import type { Task } from "./types.ts";

export async function rollout(
  task: Task,
  skillBody: string | null,
): Promise<{ output: string; costUsd: number }> {
  const sys = skillBody ? targetSysWithSkill(skillBody) : TARGET_SYS_BASE;
  const { text, costUsd } = await callLLM("target", sys, task.taskPrompt);
  return { output: text, costUsd };
}
