/**
 * mem0 sub-wizard (planned). Meta steps finish first; this module owns mem0-native setup.
 */

/**
 * @param {import('../../wizard/lib/run-wizard.mjs').WizardContext} ctx
 * @param {import('../../wizard/lib/provider-wizard/helpers.mjs').ProviderWizardHelpers} helpers
 */
export async function configureModelRouting(ctx, helpers) {
  helpers.info(
    "mem0 provider: configure API URL and keys in [memory.mem0] (TOML) — wizard steps not implemented yet.",
  );
  if (ctx.yes && ctx.action === "configure") {
    throw new Error(
      "MEMORY_PROVIDER=mem0 is not ready; set status supported in manifest after sink + hooks land",
    );
  }
}

/**
 * @param {import('../../wizard/lib/run-wizard.mjs').WizardContext} ctx
 * @param {import('../../wizard/lib/provider-wizard/helpers.mjs').ProviderWizardHelpers} helpers
 */
export async function extendValidation(ctx, helpers) {
  if (!ctx.validationErrors) ctx.validationErrors = [];
  helpers.info("mem0: extendValidation stub (no checks until supported)");
}
