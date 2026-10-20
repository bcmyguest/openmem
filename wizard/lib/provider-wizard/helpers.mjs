import { step, info, ok, warn, die, problem } from "../log.mjs";
import { ask, confirm } from "../prompts.mjs";
import { act, actWithEnv, commandExists } from "../exec.mjs";
import { curlGet, curlJson, curlRequest } from "../curl.mjs";
import { loadMachineEnv } from "../load-machine-env.mjs";
import { envValue, expandHome, ensureHsDir } from "../paths.mjs";
import { portFree, choosePort, resolveHostPort } from "../ports.mjs";
import { composeArgs } from "../compose.mjs";
import { writeWizardConf } from "../wizard-conf.mjs";
import { providerApiBase } from "../providers/registry.mjs";

/** Bump when a helper is removed or changes meaning; adding helpers does not bump it. */
export const HELPERS_API_VERSION = 2;

/**
 * API passed as the second argument of every hook in providers/<id>/wizard.mjs.
 * Providers must not import run-wizard.mjs (it imports them); everything the meta wizard
 * owns reaches them through this object. Check `apiVersion` before relying on a helper.
 *
 * Every function that takes `ctx` receives the WizardContext the hook was called with
 * (`ctx.repoRoot` = mutable stack root, `ctx.packageRoot` = read-only code root).
 *
 * @typedef {object} ProviderWizardHelpers
 * @property {2} apiVersion
 * @property {(title: string) => void} step print a numbered step heading
 * @property {(msg: string) => void} info
 * @property {(msg: string) => void} ok
 * @property {(msg: string) => void} warn
 * @property {(msg: string) => never} die print an error and exit 1
 * @property {(ctx: object, msg: string) => void} problem die, or warn in a dry run
 * @property {(ctx: object, prompt: string, defaultValue: string) => Promise<string>} ask
 * @property {(ctx: object, prompt: string, defaultYN: "y"|"n") => Promise<boolean>} confirm
 * @property {(ctx: object, description: string, cmd: string, args: string[], opts?: { env?: Record<string, string>, cwd?: string }) => Promise<void>} act
 *   run a command (printed, not run, in a dry run); exits the wizard on failure
 * @property {(ctx: object, description: string, cmd: string, args: string[], extraEnv: Record<string, string>) => Promise<void>} actWithEnv
 * @property {(name: string) => boolean} commandExists
 * @property {(repoRoot: string) => Record<string, string>} loadMachineEnv parse config/machine.env
 * @property {(file: string, key: string) => string} envValue read one KEY=value from an env file
 * @property {(p: string, home?: string) => string} expandHome
 * @property {(ctx: object) => void} ensureConfigDir create the per-machine config dir (no-op in a dry run)
 * @property {(url: string, timeoutSec?: number) => string} curlGet
 * @property {(url: string) => object|null} curlJson
 * @property {(method: string, url: string, jsonBody?: string, timeoutSec?: number) => string} curlRequest
 * @property {(port: number) => Promise<boolean>} portFree
 * @property {(ctx: object, label: string, port: number, opts?: { envVars?: string[] }) => Promise<number>} choosePort
 * @property {(ctx: object, label?: string) => Promise<number>} resolveHostPort
 *   pick the manifest's host port (compose.hostPortEnv / defaultHostPort) and export it in process.env
 * @property {(ctx: object, ...rest: string[]) => string[]} composeArgs
 *   `docker` args for a compose subcommand, with the manifest's profile and files applied
 * @property {(ctx: object, extra?: Record<string, string>, opts?: { pmSections?: Record<string, Record<string, unknown>> }) => void} saveWizardConf
 *   write wizard.conf (MEMORY_PROVIDER + extra keys) and config.toml; no-op in a dry run
 * @property {(ctx: object, opts?: { description?: string, args?: string[], env?: Record<string, string> }) => Promise<void>} runStackSetup
 *   run scripts/setup.mjs (writes the stack .env and compose.override.yaml, then the provider's
 *   `prepareStackEnv`); `description` and `env` default to what the `stackEnv` hook returns
 * @property {(ctx: object) => Promise<string>|string} apiBase the provider's API base URL (apiBase hook, else manifest)
 */

/**
 * Build the helper object. With no argument it is fully functional from leaf modules;
 * the meta wizard overrides the few helpers that need its own state.
 * @param {Partial<ProviderWizardHelpers>} [impl]
 * @returns {ProviderWizardHelpers}
 */
export function createHelpers(impl = {}) {
  return Object.freeze(
    /** @type {ProviderWizardHelpers} */ ({
      apiVersion: HELPERS_API_VERSION,
      step,
      info,
      ok,
      warn,
      die,
      problem,
      ask,
      confirm,
      act,
      actWithEnv,
      commandExists,
      loadMachineEnv,
      envValue,
      expandHome,
      ensureConfigDir: ensureHsDir,
      curlGet,
      curlJson,
      curlRequest,
      portFree,
      choosePort,
      resolveHostPort,
      composeArgs,
      saveWizardConf: writeWizardConf,
      runStackSetup: async () => {
        throw new Error("runStackSetup is only available inside the meta wizard");
      },
      apiBase: (ctx) => providerApiBase(ctx, ctx.memoryProvider),
      ...impl,
    }),
  );
}
