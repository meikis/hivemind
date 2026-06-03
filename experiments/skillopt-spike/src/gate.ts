// Held-out validation gate: accept a candidate skill only if it beats the
// current skill on the val set by more than a noise epsilon.
export interface GateResult {
  accept: boolean;
  cand: number;
  cur: number;
}

export function evaluateGate(cand: number, cur: number, eps = 0.01): GateResult {
  return { accept: cand > cur + eps, cand, cur };
}
