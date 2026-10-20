import * as p from "@clack/prompts";
import {
  listAllProviders,
  listSelectableProviders,
  providerDefaultId,
  resolveProvider,
} from "./providers/registry.mjs";
import { actionDefault } from "./wizard-action.mjs";
import { applyPmConfigEnv, defaultsFromPmConfig, loadPmConfig } from "./pm-config.mjs";
import { createHelpers } from "./provider-wizard/helpers.mjs";
import { loadProviderWizard } from "./provider-wizard/run-steps.mjs";
import path from "node:path";

/**
 * Provider-neutral Clack setup UI: what to do (configure/up/down) and which provider.
 * For a configure run the chosen provider's `clackSetup(ctx, ui, helpers)` hook asks its
 * own questions and returns environment variables for the wizard process. A provider
 * without the hook adds nothing.
 *
 * @param {string} repoRoot
 * @returns {Promise<Record<string, string>>}
 */
export async function runClackSetup(repoRoot) {
  const home = process.env.HOME || "";
  const wizardConf = path.join(home, ".config/hindsight/wizard.conf");
  const ctxStub = { repoRoot, home, wizardConf };
  const pm = loadPmConfig(home, repoRoot);
  applyPmConfigEnv(pm.merged);
  const pmDefaults = defaultsFromPmConfig(pm.merged);

  p.intro("Personal memory setup");

  const actionDefaultVal =
    pmDefaults.wizardAction && ["configure", "up", "down"].includes(pmDefaults.wizardAction)
      ? pmDefaults.wizardAction
      : actionDefault();
  const action = await p.select({
    message: "What should setup do?",
    options: [
      {
        value: "configure",
        label: "Configure and start",
        hint: "full wizard (default)",
      },
      { value: "up", label: "Start stack", hint: "docker compose up, existing config" },
      { value: "down", label: "Stop stack", hint: "docker compose down" },
    ],
    initialValue: actionDefaultVal,
  });
  if (p.isCancel(action)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const selectable = listSelectableProviders();
  const all = listAllProviders();
  const planned = all.filter((m) => m.status === "planned");
  if (planned.length) {
    p.note(
      planned.map((m) => `${m.label} (${m.id}): ${m.status}`).join("\n"),
      "Planned providers (not selectable yet)",
    );
  }

  ctxStub.pmMerged = pm.merged;
  const providerDefault = providerDefaultId(ctxStub);
  const providerPick = await p.select({
    message: "Memory provider",
    options: selectable.map((m) => ({
      value: m.id,
      label: m.label,
      hint: m.status === "experimental" ? "experimental" : "supported",
    })),
    initialValue: selectable.some((m) => m.id === providerDefault)
      ? providerDefault
      : selectable[0]?.id,
  });
  if (p.isCancel(providerPick)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  /** @type {Record<string, string>} */
  const handoff = {
    PM_WIZARD_ACTION: /** @type {string} */ (action),
    MEMORY_PROVIDER: /** @type {string} */ (providerPick),
  };

  if (action === "down") {
    p.outro("Stopping stack…");
    return handoff;
  }

  if (action === "up") {
    p.outro("Starting stack…");
    return handoff;
  }

  const manifest = resolveProvider(/** @type {string} */ (providerPick));
  const mod = await loadProviderWizard(manifest);
  if (typeof mod.clackSetup === "function") {
    const extra = await mod.clackSetup(ctxStub, p, createHelpers());
    Object.assign(handoff, extra);
  }

  p.outro("Continuing setup…");
  return handoff;
}
