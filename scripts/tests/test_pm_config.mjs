#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildPmConfigToml,
  defaultsFromPmConfig,
  loadPmConfig,
  userConfigPath,
} from "../../wizard/lib/pm-config.mjs";
import { configToml, defaultsFromConfig } from "../../providers/hindsight/lib/config.mjs";

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const example = path.join(repo, "config/personal-memory.toml.example");
let fails = 0;
function check(desc, ok) {
  if (ok) console.log(`ok    ${desc}`);
  else {
    console.log(`FAIL  ${desc}`);
    fails++;
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pm-toml-"));
const home = path.join(tmp, "home");
fs.mkdirSync(path.join(home, ".config/personal-memory"), { recursive: true });
fs.copyFileSync(example, userConfigPath(home));
const loaded = loadPmConfig(home, repo);
check("loads user config.toml", loaded.wroteFrom.includes(userConfigPath(home)));
const d = defaultsFromPmConfig(loaded.merged);
check("example provider hindsight", d.memoryProvider === "hindsight");
check(
  "example model backend lemond",
  String(loaded.merged.model?.backend || "") === "lemond",
);
check("example wizard action configure", d.wizardAction === "configure");

const ctx = {
  home,
  project: "pm-test",
  portApi: "28888",
  portCp: "29999",
  action: "configure",
  memoryProvider: { id: "hindsight" },
  backend: "lemond",
  model: "Gemma-4-E2B-it-GGUF",
  reflectModel: "",
  apiBase: "http://host.docker.internal:13305/v1",
  lemondBase: "http://127.0.0.1:13305",
  dry: true,
};
const out = buildPmConfigToml(ctx);
check("buildPmConfigToml includes provider", out.includes('provider = "hindsight"'));
check(
  "provider-neutral config.toml has no model or port tables",
  !/\[model/.test(out) && !/api_port/.test(out) && /\[tasks\.doctor\]/.test(out),
);

// Hindsight's [stack] ports and [model] tables come from its configToml hook.
const hs = buildPmConfigToml(ctx, configToml(ctx));
check("hindsight sections: api_port", /api_port = 28_?888/.test(hs) && /control_plane_port = 29_?999/.test(hs));
check("hindsight sections: [model] backend and retain", /\[model\]/.test(hs) && /backend = "lemond"/.test(hs) && /retain = "Gemma-4-E2B-it-GGUF"/.test(hs));
check("hindsight sections: [model.lemond] host", /\[model\.lemond\]/.test(hs) && /host = "http:\/\/127\.0\.0\.1:13305"/.test(hs));
check("hindsight sections: project stays in [stack]", /\[stack\]\nproject = "pm-test"/.test(hs));
const hsd = defaultsFromConfig(loaded.merged);
check("hindsight defaults read [model] from the example", hsd.modelBackend === "lemond");
check("provider-neutral defaults carry no model keys", !("modelBackend" in d) && !("apiPort" in d));

// A provider's `memory` sub-tables are merged into [memory]; the provider id always wins.
const mem0Ctx = { ...ctx, memoryProvider: { id: "mem0" } };
const sub = buildPmConfigToml(mem0Ctx, { memory: { mem0: { api_url: "http://127.0.0.1:18888" } } });
check("memory sub-table without provider keeps provider = mem0", /\[memory\]\nprovider = "mem0"/.test(sub) && /\[memory\.mem0\]\n\s*api_url = "http:\/\/127\.0\.0\.1:18888"/.test(sub));
const forced = buildPmConfigToml(mem0Ctx, { memory: { provider: "other", mem0: { api_url: "http://x:1" } } });
check("a provider section cannot override memory.provider", /provider = "mem0"/.test(forced) && !/provider = "other"/.test(forced));
// Hindsight output is unchanged by the merge: the document equals the pre-change layout.
const hsDoc = buildPmConfigToml(ctx, configToml(ctx));
check("hindsight document layout unchanged ([memory] holds only provider)", /\[memory\]\nprovider = "hindsight"\n\n\[stack\]/.test(hsDoc) && !/\[memory\./.test(hsDoc));

fs.rmSync(tmp, { recursive: true, force: true });

if (fails) {
  console.log(`${fails} pm config test(s) failed`);
  process.exit(1);
}
console.log("all pm config tests passed");
