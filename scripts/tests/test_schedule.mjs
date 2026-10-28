import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pythonCandidates } from "../../cli/feed-sync.mjs";
import { main, renderLaunchAgent, renderRunner, renderSystemdUnits, schedulePaths, windowsTaskArgs } from "../../cli/schedule.mjs";

const linux = schedulePaths("linux", "/home/test", { XDG_CONFIG_HOME: "/tmp/test config" });
assert.equal(linux.timer, "/tmp/test config/systemd/user/openmem-feed-sync.timer");
assert.equal(linux.runner, "/tmp/test config/openmem/feed-sync-runner.mjs");

const units = renderSystemdUnits("/opt/node/bin/node", linux.runner);
assert.match(units.service, /ExecStart="\/opt\/node\/bin\/node" "\/tmp\/test config\/openmem\/feed-sync-runner\.mjs"/);
assert.match(units.timer, /OnCalendar=hourly\nPersistent=true/);

const mac = schedulePaths("darwin", "/Users/test", {});
assert.equal(mac.plist, "/Users/test/Library/LaunchAgents/io.github.bcmyguest.openmem.feed-sync.plist");
const plist = renderLaunchAgent("/Users/a&b/node", mac.runner);
assert.match(plist, /\/Users\/a&amp;b\/node/);
assert.match(plist, /<key>StartInterval<\/key><integer>3600<\/integer>/);

const win = schedulePaths("win32", "C:\\Users\\Test", { LOCALAPPDATA: "C:\\Users\\Test\\AppData\\Local" });
assert.equal(win.runner, "C:\\Users\\Test\\AppData\\Local\\OpenMem\\feed-sync-runner.mjs");
assert.deepEqual(windowsTaskArgs("C:\\Program Files\\nodejs\\node.exe", win.runner).slice(0, 5), ["/create", "/sc", "hourly", "/mo", "1"]);
assert.match(windowsTaskArgs("C:\\Program Files\\nodejs\\node.exe", win.runner)[8], /^"C:\\Program Files\\nodejs\\node.exe" /);

const runner = renderRunner("/opt/node/bin/node", "/opt/node/lib/node_modules/npm/bin/npm-cli.js", "/opt/python/bin/python3");
assert.match(runner, /--package=@bcmyguest\/openmem/);
assert.match(runner, /"openmem", "feed-sync"/);
assert.match(runner, /env\.PYTHON = python/);
assert.match(runner, /path\.dirname\(node\), path\.dirname\(python\)/);

assert.deepEqual(pythonCandidates("win32", {}), [["py", ["-3"]], ["python", []]]);
assert.deepEqual(pythonCandidates("darwin", {}), [["python3", []], ["python", []]]);
assert.deepEqual(pythonCandidates("linux", { PYTHON: "/custom/python" }), [["/custom/python", []]]);

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "openmem-schedule-test-"));
try {
  const oldLog = console.log;
  const lines = [];
  console.log = (line) => lines.push(line);
  try {
    main(["install", "--dry-run"], "linux", temp, { npm_execpath: process.execPath });
    main(["remove", "--dry-run"], "linux", temp, {});
  } finally {
    console.log = oldLog;
  }
  assert.equal(lines.length, 2);
  assert.match(lines[0], /Would write .*feed-sync-runner\.mjs/);
  assert.match(lines[1], /Would remove openmem-feed-sync/);
  assert.equal(fs.readdirSync(temp).length, 0);

  const bin = path.join(temp, "bin");
  fs.mkdirSync(bin);
  const python = path.join(bin, "python3");
  fs.writeFileSync(python, '#!/bin/sh\nprintf "%s\\n" "$0"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "systemctl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const env = {
    npm_execpath: process.execPath,
    PYTHON: python,
    PATH: `${bin}${path.delimiter}${process.env.PATH || ""}`,
    XDG_CONFIG_HOME: path.join(temp, "config"),
  };
  main(["install"], "linux", temp, env);
  const files = schedulePaths("linux", temp, env);
  assert.ok(fs.existsSync(files.runner));
  assert.ok(fs.existsSync(files.service));
  assert.ok(fs.existsSync(files.timer));
  assert.match(fs.readFileSync(files.runner, "utf8"), /env\.PYTHON = python/);
  const check = (await import("node:child_process")).spawnSync(process.execPath, ["--check", files.runner], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
  main(["remove"], "linux", temp, env);
  assert.equal(fs.existsSync(files.runner), false);
  assert.equal(fs.existsSync(files.service), false);
  assert.equal(fs.existsSync(files.timer), false);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log("schedule tests passed");
