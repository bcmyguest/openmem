import fs from "node:fs";
import path from "node:path";

/** Map workspace cwd → indexer-style bank id for session recall/retain. */
export function bankFromCwd(cwd) {
  const dir = path.resolve(String(cwd || process.cwd()));
  let name = path.basename(dir);
  try {
    const git = path.join(dir, ".git");
    if (fs.existsSync(git)) {
      const remote = fs.readFileSync(path.join(git, "config"), "utf8");
      const m = /url\s*=\s*(?:git@|https?:\/\/)(?:[^/:]+\/|:)([^/\s]+)\/([^/\s]+?)(?:\.git)?/m.exec(remote);
      if (m) name = m[2].replace(/\.git$/, "");
    }
  } catch {
    /* use folder basename */
  }
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `coding-agent::${slug || "workspace"}`;
}
