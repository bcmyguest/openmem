/**
 * The stack LiteLLM's secrets file (litellm.env, mode 600): LITELLM_MASTER_KEY and the
 * provider keys its routes reference as os.environ/<NAME>. Shared by every provider that
 * enables the `litellm` compose service (Hindsight, mem0).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Create litellm.env (mode 600) with a fresh LITELLM_MASTER_KEY when it does not exist.
 * @param {string} litellmEnv
 * @returns {boolean} true when the file was created
 */
export function ensureLitellmEnv(litellmEnv) {
  if (fs.existsSync(litellmEnv)) return false;
  const key = crypto.randomBytes(24).toString("hex");
  const body =
    "# LiteLLM proxy secrets. Read by the litellm compose service. Do not commit.\n" +
    `LITELLM_MASTER_KEY=sk-${key}\n` +
    "# lemond ignores the key; any non-empty value works.\n" +
    "LEMOND_API_KEY=placeholder\n" +
    "# Hosted models: add the provider key here, e.g. ANTHROPIC_API_KEY=..., and reference it as os.environ/ANTHROPIC_API_KEY.\n";
  fs.mkdirSync(path.dirname(litellmEnv), { recursive: true, mode: 0o700 });
  fs.writeFileSync(litellmEnv, body, { mode: 0o600 });
  return true;
}

/**
 * Set NAME=value in litellm.env (mode 600), creating the file with a master key first when
 * it does not exist. Never prints the value.
 * @param {string} litellmEnv
 * @param {string} name
 * @param {string} value
 * @returns {"unchanged"|"updated"|"added"}
 */
export function setLitellmEnvValue(litellmEnv, name, value) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error(`invalid variable name: ${name}`);
  if (/[\r\n]/.test(value)) throw new Error(`${name} must be one line`);
  ensureLitellmEnv(litellmEnv);
  const lines = fs.readFileSync(litellmEnv, "utf8").replace(/\n$/, "").split("\n");
  const line = `${name}=${value}`;
  const at = lines.findIndex((l) => l.startsWith(`${name}=`));
  if (at >= 0 && lines[at] === line) {
    fs.chmodSync(litellmEnv, 0o600);
    return "unchanged";
  }
  if (at >= 0) lines[at] = line;
  else lines.push(line);
  const tmp = path.join(path.dirname(litellmEnv), `.litellm.env.${process.pid}`);
  fs.writeFileSync(tmp, `${lines.join("\n")}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, litellmEnv);
  return at >= 0 ? "updated" : "added";
}
