import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

/**
 * @param {import("./run-wizard.mjs").WizardContext} ctx
 * @param {string} prompt
 * @param {string} defaultValue
 */
export async function ask(ctx, prompt, defaultValue) {
  if (ctx.yes) return defaultValue;
  if (!process.stdin.isTTY) return defaultValue;
  try {
    const clack = await import("@clack/prompts");
    const v = await clack.text({
      message: prompt,
      placeholder: defaultValue,
      defaultValue,
    });
    if (clack.isCancel(v)) process.exit(0);
    const s = String(v ?? "").trim();
    return s || defaultValue;
  } catch {
    const rl = readline.createInterface({ input, output });
    const line = await rl.question(`  ${prompt} [${defaultValue}]: `);
    rl.close();
    const s = line.trim();
    return s || defaultValue;
  }
}

/**
 * @param {import("./run-wizard.mjs").WizardContext} ctx
 * @param {string} prompt
 * @param {"y"|"n"} defaultYN
 */
export async function confirm(ctx, prompt, defaultYN) {
  if (ctx.yes) return defaultYN === "y";
  if (!process.stdin.isTTY) return defaultYN === "y";
  try {
    const clack = await import("@clack/prompts");
    const v = await clack.confirm({
      message: prompt,
      active: "yes",
      inactive: "no",
      initialValue: defaultYN === "y",
    });
    if (clack.isCancel(v)) process.exit(0);
    return Boolean(v);
  } catch {
    const hint = defaultYN === "y" ? "Y/n" : "y/N";
    const rl = readline.createInterface({ input, output });
    const line = await rl.question(`  ${prompt} [${hint}]: `);
    rl.close();
    const reply = (line.trim() || defaultYN).toLowerCase();
    return reply === "y" || reply === "yes";
  }
}
