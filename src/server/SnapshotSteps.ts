/** One bounded file/entry per step; async callers yield to I/O, not just microtasks.
 * Sync startup recovery and legacy capture drain the SAME guards and effects. */
export function drainSteps<T>(steps: Generator<void, T, void>): T {
  let next = steps.next();
  while (!next.done) next = steps.next();
  return next.value;
}
export async function drainStepsAsync<T>(steps: Generator<void, T, void>): Promise<T> {
  let next = steps.next();
  while (!next.done) {
    await new Promise<void>(resolve => setImmediate(resolve));
    next = steps.next();
  }
  return next.value;
}
