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
 * Pick any of `options`; `--yes` and non-TTY runs return `initial`.
 * @param {import("./run-wizard.mjs").WizardContext} ctx
 * @param {string} prompt
 * @param {{ value: string, label: string }[]} options
 * @param {string[]} initial
 * @returns {Promise<string[]>}
 */
export async function multiselect(ctx, prompt, options, initial) {
  if (ctx.yes) return initial;
  if (!process.stdin.isTTY) return initial;
  try {
    const clack = await import("@clack/prompts");
    const v = await clack.multiselect({ message: prompt, options, initialValues: initial, required: false });
    if (clack.isCancel(v)) process.exit(0);
    return /** @type {string[]} */ (v);
  } catch {
    const rl = readline.createInterface({ input, output });
    const names = options.map((o) => o.value).join(", ");
    const line = await rl.question(`  ${prompt} (comma-separated: ${names}; "none" for none) [${initial.join(",") || "none"}]: `);
    rl.close();
    const s = line.trim();
    if (!s) return initial;
    if (s === "none") return [];
    return s.split(",").map((x) => x.trim()).filter((x) => options.some((o) => o.value === x));
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
