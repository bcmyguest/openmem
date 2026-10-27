import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const RUNTIME_ITEMS = ["cli", "providers", "wizard", "config", "skills", "package.json"];
const RUNTIME_DEPS = ["@iarna/toml", "@clack/prompts", "yaml"];

function packageRoot(requireFromSource, name) {
  let dir = path.dirname(requireFromSource.resolve(name));
  while (dir !== path.dirname(dir)) {
    const manifest = path.join(dir, "package.json");
    if (fs.existsSync(manifest) && JSON.parse(fs.readFileSync(manifest, "utf8")).name === name) return dir;
    dir = path.dirname(dir);
  }
  throw new Error(`cannot locate ${name} for openmem runtime`);
}

/** Copy the agent runtime out of an ephemeral npx cache into a stable user path. */
export function prepareAgentRuntime({ home, repoRoot, stackRoot, dry = false, h }) {
  const dest = path.join(home, ".local", "share", "personal-memory", "agent-runtime");
  if (dry) {
    h?.info(`[dry-run] stage openmem agent runtime in ${dest}`);
    return dest;
  }
  const requireFromSource = createRequire(path.join(repoRoot, "package.json"));
  fs.mkdirSync(dest, { recursive: true });
  for (const item of RUNTIME_ITEMS) {
    fs.cpSync(path.join(repoRoot, item), path.join(dest, item), { recursive: true, force: true });
  }
  fs.rmSync(path.join(dest, "cli", "coding-agent", "opencode-plugin"), { recursive: true, force: true });
  for (const name of RUNTIME_DEPS) {
    const target = path.join(dest, "node_modules", name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(packageRoot(requireFromSource, name), target, { recursive: true, force: true });
  }
  fs.writeFileSync(path.join(dest, "agent-runtime.json"), `${JSON.stringify({ stackRoot }, null, 2)}\n`);
  h?.ok(`openmem agent runtime → ${dest}`);
  return dest;
}
