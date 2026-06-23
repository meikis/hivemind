/**
 * Race a promise against a deadline. Returns `fallback` ONLY when the deadline
 * elapses; a resolution or rejection of `p` propagates unchanged. This keeps a
 * real failure distinguishable from a true timeout (callers must not conflate
 * the two — e.g. recall telemetry counts `timeout` vs `error` separately).
 *
 * It is the CALLER's job to be failure-isolated if it can't tolerate a throw on
 * a latency-critical path (recall's findHit catches its own I/O errors).
 */
export function withDeadline<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  if (!(ms > 0)) return p; // no deadline → behave exactly like p (incl. rejection)
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(fallback);
    }, ms);
    timer.unref(); // Node Timeout — don't keep the process alive for the timer
    p.then(
      (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } },
      (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } },
    );
  });
}
