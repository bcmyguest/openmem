/** @typedef {"configure"|"up"|"down"} WizardAction */

/** @returns {WizardAction} */
export function actionDefault() {
  const fromEnv = process.env.PM_WIZARD_ACTION || process.env.WIZARD_ACTION;
  if (fromEnv === "up" || fromEnv === "down" || fromEnv === "configure") return fromEnv;
  return "configure";
}

/**
 * @param {string[]} argv
 * @returns {WizardAction}
 */
export function parseActionFromArgv(argv) {
  if (argv.includes("--down")) return "down";
  if (argv.includes("--up")) return "up";
  const fromEnv = process.env.PM_WIZARD_ACTION || process.env.WIZARD_ACTION;
  if (fromEnv === "up" || fromEnv === "down") return fromEnv;
  return "configure";
}

/** @param {WizardAction} action */
export function actionLabel(action) {
  switch (action) {
    case "configure":
      return "Configure and start (full setup)";
    case "up":
      return "Start stack (existing config)";
    case "down":
      return "Stop stack";
    default:
      return action;
  }
}
