/**
 * Holds the API key the operator handed over through the environment, out of process.env.
 * The `init` hook runs before preflight spawns docker and curl, so capturing it there keeps
 * the key out of every child process environment. The value lives in this module only: it is
 * not a property of the wizard context and is never serialised.
 */

let captured = "";

/**
 * Move PM_MEM0_API_KEY (the Clack hand-off) and MEM0_API_KEY out of process.env. The hand-off
 * wins. Nothing is restored. When neither variable is set an earlier capture is kept.
 */
export function captureKeyFromEnv() {
  const handoff = (process.env.PM_MEM0_API_KEY || "").trim();
  const plain = (process.env.MEM0_API_KEY || "").trim();
  delete process.env.PM_MEM0_API_KEY;
  delete process.env.MEM0_API_KEY;
  if (handoff || plain) captured = handoff || plain;
}

/** The captured key, or "". */
export function capturedKey() {
  return captured;
}

/** Forget the captured key (tests). */
export function clearCapturedKey() {
  captured = "";
}
