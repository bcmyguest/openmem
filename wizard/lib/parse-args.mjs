import os from "node:os";
import path from "node:path";
import { die } from "./log.mjs";
import { parseActionFromArgv } from "./wizard-action.mjs";

const HELP = `Setup wizard: takes a fresh clone to a running memory stack for the selected provider. Symlinked as ./setup at the repo root.
Re-runnable: shows current values as defaults and asks before it replaces config or secrets.

  ./setup                      interactive (@clack/prompts UI, then the rest)
  ./setup --yes                accept every default, no prompts
  ./setup --dry-run [--yes]    print the actions; read-only checks run, nothing is written or started
  ./setup --yes --no-smoke     skip the smoke retain/recall (for scripted re-runs)
  ./setup --rebuild            rebuild the images even when their sources are unchanged
  ./setup --up [--yes]         start the stack using existing wizard.conf
  ./setup --down [--yes]       stop the stack (docker compose down)

PM_PROJECT sets the compose project name (default: personal-memory). MEMORY_PROVIDER selects the
memory plugin (default: hindsight). PM_WIZARD_ACTION=configure|up|down. Each provider documents its
own environment variables (model backend, ports) in providers/<id>/. PM_STACK_ROOT and PM_PACKAGE_ROOT
split the mutable stack directory from the read-only code directory. The last line is
"wizard: changed=N": files and containers this run altered.
Test against a scratch HOME:
  HOME=/tmp/wiz-home PM_PROJECT=pm-wizard-test ./setup --yes`;

/**
 * @param {string} repoRoot
 * @param {string[]} argv
 * @returns {import("./run-wizard.mjs").WizardContext}
 */
export function parseWizardFlags(repoRoot, argv) {
  const home = process.env.HOME || os.homedir();

  const ctx = {
    repoRoot,
    // Read-only code root (wizard/, providers/, scripts/); the stack root is repoRoot.
    packageRoot: process.env.PM_PACKAGE_ROOT ? path.resolve(process.env.PM_PACKAGE_ROOT) : repoRoot,
    home,
    project: process.env.PM_PROJECT || "personal-memory",
    // Shared per-machine config dir: wizard.conf, index.yml, notebooklm.yml. The name predates
    // provider plugins and stays fixed so existing machines keep their config.
    hsDir: path.join(home, ".config/hindsight"),
    indexFile: path.join(home, ".config/hindsight/index.yml"),
    notebookFile: path.join(home, ".config/hindsight/notebooklm.yml"),
    wizardConf: path.join(home, ".config/hindsight/wizard.conf"),
    smokeBank: "wizard-smoke",
    buildHashFile: path.join(repoRoot, ".build-hash"),
    notebooklmPkg: "notebooklm-py[browser]==0.8.5",
    yes: false,
    dry: false,
    smoke: true,
    rebuild: false,
    // True when the Clack UI already asked the provider's questions (WIZARD_SKIP_BACKEND_STEP=1).
    skipBackendStep: process.env.WIZARD_SKIP_BACKEND_STEP === "1",
    action: parseActionFromArgv(argv),
    providerId: "",
  };

  for (const arg of argv) {
    switch (arg) {
      case "--up":
      case "--down":
        break;
      case "--yes":
      case "-y":
        ctx.yes = true;
        break;
      case "--dry-run":
        ctx.dry = true;
        break;
      case "--no-smoke":
        ctx.smoke = false;
        break;
      case "--rebuild":
        ctx.rebuild = true;
        break;
      case "-h":
      case "--help":
        console.log(HELP);
        process.exit(0);
        break;
      default:
        die(`unknown option: ${arg} (see --help)`);
    }
  }

  return ctx;
}
