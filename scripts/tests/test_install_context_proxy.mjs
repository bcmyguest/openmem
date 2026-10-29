#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installContextProxy } from "../../cli/coding-agent/install-context-proxy.mjs";

let failed = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`ok    ${name}`);
  else {
    failed++;
    console.log(`FAIL  ${name}${detail ? `: ${detail}` : ""}`);
  }
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), "openmem-cp-"));
delete process.env.OPENMEM_STATE_DIR;
installContextProxy({ home, agents: ["claude-code"], enabled: true, port: 4100 });
const root = path.join(home, ".local", "share", "openmem", "context");
for (const sub of ["sessions", "blobs"]) {
  const st = fs.statSync(path.join(root, sub), { throwIfNoEntry: false });
  check(`enable creates context/${sub} as a directory`, Boolean(st?.isDirectory()));
  check(`context/${sub} is mode 700`, st && (st.mode & 0o777) === 0o700, st ? (st.mode & 0o777).toString(8) : "missing");
}
const before = fs.statSync(path.join(root, "sessions")).ino;
installContextProxy({ home, agents: ["claude-code"], enabled: true, port: 4100 });
check("re-enable keeps the existing context dir", fs.statSync(path.join(root, "sessions")).ino === before);
fs.rmSync(home, { recursive: true, force: true });

if (failed) process.exit(1);
console.log("all context proxy install tests passed");
