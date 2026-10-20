/**
 * Cognee sub-wizard (planned). Meta steps finish first; this module will own Cognee-native setup.
 */

/**
 * @param {import('../../wizard/lib/run-wizard.mjs').WizardContext} ctx
 * @param {import('../../wizard/lib/provider-wizard/helpers.mjs').ProviderWizardHelpers} helpers
 */
export async function configureModelRouting(ctx, helpers) {
  helpers.info(
    "Cognee provider: configure API URL and datasets in [memory.cognee] (TOML) — wizard steps not implemented yet.",
  );
  if (ctx.yes && ctx.action === "configure") {
    throw new Error(
      "MEMORY_PROVIDER=cognee is not ready; set status supported in manifest after sink + hooks land",
    );
  }
}

/**
 * @param {import('../../wizard/lib/run-wizard.mjs').WizardContext} ctx
 * @param {import('../../wizard/lib/provider-wizard/helpers.mjs').ProviderWizardHelpers} helpers
 */
export async function extendValidation(ctx, helpers) {
  if (!ctx.validationErrors) ctx.validationErrors = [];
  helpers.info("Cognee: extendValidation stub (no checks until supported)");
}
