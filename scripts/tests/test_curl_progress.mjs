#!/usr/bin/env node
/**
 * curlRequestProgress: heartbeat while a slow HTTP handler runs.
 */
import http from "node:http";
import { curlRequestProgress, curlArgs } from "../../wizard/lib/curl.mjs";

let failed = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`ok    ${name}`);
  else {
    failed++;
    console.log(`FAIL  ${name}${detail ? `: ${detail}` : ""}`);
  }
}

check(
  "curlArgs includes method, timeout, and JSON body flags",
  curlArgs("POST", "http://x", '{"a":1}', 12).join(" ").includes("-m 12") &&
    curlArgs("POST", "http://x", '{"a":1}', 12).includes("-d"),
);

const server = http.createServer((req, res) => {
  setTimeout(() => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
  }, 2200);
});

await new Promise((resolve, reject) => {
  server.listen(0, "127.0.0.1", (err) => (err ? reject(err) : resolve()));
});
const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
const ticks = [];
const body = await curlRequestProgress("GET", `http://127.0.0.1:${port}/`, undefined, 30, {
  tickSec: 1,
  onTick: (info) => ticks.push(info),
});
server.close();

check("progress request returns body", body.includes('"ok":true'), body);
check("heartbeat fired at least once during slow response", ticks.length >= 1, JSON.stringify(ticks));
check("heartbeat reports elapsed and timeout", ticks[0]?.timeoutSec === 30 && ticks[0]?.elapsed >= 1);

if (failed) {
  console.error(`${failed} curl progress test(s) failed`);
  process.exit(1);
}
console.log("all curl progress tests passed");
