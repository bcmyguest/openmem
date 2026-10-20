/** Test-only provider: exercises the v2 hooks without any Hindsight knowledge. */

export async function resolvePorts(ctx, h) {
  ctx.hookedPort = String(await h.resolveHostPort(ctx, "Hooked API"));
}

export function apiBase(ctx) {
  return `http://127.0.0.1:${ctx.hookedPort}`;
}

export async function smoke(ctx, h) {
  if (ctx.dry) h.info("[dry-run] hooked smoke override");
  else h.ok("hooked smoke override ran");
  return true;
}

export function summary(ctx) {
  return {
    running: [`  Hooked API         ${apiBase(ctx)}`],
    configFiles: [],
    notes: ["Hooked note line"],
    logServices: ["memory"],
  };
}

export async function extendValidation(ctx, h) {
  (ctx.validationChecks ||= []).push("hooked validation ran");
}
