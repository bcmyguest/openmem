#!/usr/bin/env node
import { validateAllProviderManifests } from "../../wizard/lib/validate-setup.mjs";
import {
  listAllProviders,
  listSelectableProviders,
  loadManifest,
  providerApiBase,
  providersRoot,
  resolveProvider,
  validateManifest,
} from "../../wizard/lib/providers/registry.mjs";
import { composeArgs, composeCommandText } from "../../wizard/lib/compose.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

let fails = 0;
function check(desc, ok) {
  if (ok) console.log(`ok    ${desc}`);
  else {
    console.log(`FAIL  ${desc}`);
    fails++;
  }
}

const all = validateAllProviderManifests();
check("supported/experimental manifests validate", all.ok);
if (!all.ok) {
  for (const e of all.errors) console.log(`      ${e}`);
}

const hindsight = listAllProviders().find((m) => m.id === "hindsight");
check("hindsight manifest exists", Boolean(hindsight));
check(
  "hindsight smoke paths complete",
  hindsight ? validateManifest(hindsight).length === 0 : false,
);

const mem0 = listAllProviders().find((m) => m.id === "mem0");
check("mem0 manifest is experimental", mem0?.status === "experimental");
check("mem0 experimental manifest validates", mem0 ? validateManifest(mem0).length === 0 : false);

const cognee = listAllProviders().find((m) => m.id === "cognee");
check("cognee manifest is experimental", cognee?.status === "experimental");
check("cognee experimental manifest validates", cognee ? validateManifest(cognee).length === 0 : false);

// indexer.sink: the MEMORY_SINK value, required once a provider is experimental or supported.
check("hindsight declares indexer.sink 'hindsight'", hindsight?.indexer?.sink === "hindsight");
const experimental = {
  id: "fake",
  label: "Fake",
  status: "experimental",
  compose: { healthPath: "/health" },
  wizard: {
    smokeBank: "b",
    retainPath: "/r",
    recallPath: "/q",
    deletePath: "/d",
    retainBody: "{}",
    recallBody: "{}",
  },
  indexer: { apiUrlEnv: "FAKE_URL", sinkDriver: "fake-rest" },
};
check(
  "indexer.sink is required for experimental",
  validateManifest(experimental).includes("indexer.sink required"),
);
check(
  "experimental with indexer.sink validates",
  validateManifest({ ...experimental, indexer: { ...experimental.indexer, sink: "fake" } }).length === 0,
);
check(
  "indexer.sink is required for supported",
  validateManifest({ ...experimental, status: "supported" }).includes("indexer.sink required"),
);
for (const sink of ["Fake", "fake-sink", "../x", "1fake", "", "a.b", 7]) {
  check(
    `invalid indexer.sink ${JSON.stringify(sink)} is rejected`,
    validateManifest({ ...experimental, indexer: { ...experimental.indexer, sink } }).some((e) =>
      e.startsWith("indexer.sink must match"),
    ),
  );
}
check(
  "invalid indexer.sink is rejected for planned too",
  validateManifest({ ...experimental, status: "planned", indexer: { sink: "Bad-Name" } }).some((e) =>
    e.startsWith("indexer.sink must match"),
  ) && validateManifest({ ...experimental, status: "planned", indexer: { sink: "good_name" } }).length === 0,
);
const repoRoot = path.resolve(here, "../..");
// The manifest rule and the Python rule must stay the same pattern.
const registrySource = fs.readFileSync(path.join(repoRoot, "wizard/lib/providers/registry.mjs"), "utf8");
const sinksSource = fs.readFileSync(path.join(repoRoot, "indexer/sinks/__init__.py"), "utf8");
const jsSinkPattern = registrySource.match(/const SINK_NAME_RE = \/(.+)\/;/)?.[1];
const pySinkPattern = sinksSource.match(/^NAME = re\.compile\(r"(.+)"\)$/m)?.[1];
check(
  `registry SINK_NAME_RE equals indexer/sinks NAME (${jsSinkPattern})`,
  Boolean(jsSinkPattern) && jsSinkPattern === pySinkPattern,
);
for (const m of listAllProviders()) {
  if (m.indexer?.sink && (m.status === "supported" || m.status === "experimental")) {
    check(
      `${m.id} indexer.sink '${m.indexer.sink}' has indexer/sinks/${m.indexer.sink}.py`,
      fs.existsSync(path.join(repoRoot, "indexer", "sinks", `${m.indexer.sink}.py`)),
    );
  }
}

// compose.profile and compose.files: schema validation.
const base = {
  id: "fake",
  label: "Fake",
  status: "planned",
  compose: {},
};
const bad = (compose) => validateManifest({ ...base, compose }).length > 0;
const good = (compose) => validateManifest({ ...base, compose }).length === 0;
check("compose.profile accepts a plain name", good({ profile: "hindsight" }));
check("compose.profile rejects an empty string", bad({ profile: "" }));
check("compose.profile rejects spaces", bad({ profile: "two words" }));
check("compose.profile rejects a non-string", bad({ profile: 7 }));
check("compose.files accepts stack-relative paths", good({ files: ["providers/fake/compose.yaml"] }));
check("compose.files accepts an empty list", good({ files: [] }));
check("compose.files rejects an absolute path", bad({ files: ["/etc/compose.yaml"] }));
check("compose.files rejects .. escapes", bad({ files: ["../outside.yaml"] }) && bad({ files: ["a/../../outside.yaml"] }));
check("compose.files rejects a non-array", bad({ files: "providers/x.yaml" }));
check("compose.files rejects non-string entries", bad({ files: [1] }));
check("compose.services must be string[]", bad({ services: "indexer" }) && good({ services: ["indexer"] }));
check("compose.logServices must be string[]", bad({ logServices: [""] }) && good({ logServices: ["a"] }));
check(
  "wizardHooks.module must stay inside the provider directory",
  validateManifest({ ...base, wizardHooks: { module: "../x.mjs" } }).length > 0 &&
    validateManifest({ ...base, wizardHooks: { module: "/x.mjs" } }).length > 0 &&
    validateManifest({ ...base, wizardHooks: { module: "wizard.mjs" } }).length === 0,
);
check("wizard.recallHint must be a string", validateManifest({ ...base, wizard: { recallHint: 3 } }).length > 0);
check("provider id must be a safe name", validateManifest({ ...base, id: "../x" }).length > 0);

// composeArgs: profile and files apply to every compose invocation.
const stack = fs.mkdtempSync(path.join(os.tmpdir(), "pm-compose-"));
const plain = { project: "pm-t", repoRoot: stack, memoryProvider: { compose: {} } };
check("composeArgs without profile or files adds nothing", composeArgs(plain, "up", "-d").join(" ") === "compose -p pm-t up -d");
const withProfile = { ...plain, memoryProvider: { compose: { profile: "fake" } } };
check(
  "composeArgs adds --profile before the subcommand",
  composeArgs(withProfile, "build", "indexer").join(" ") === "compose -p pm-t --profile fake build indexer",
);
const withFiles = { ...plain, memoryProvider: { compose: { profile: "fake", files: ["providers/fake/compose.yaml", "extra.yaml"] } } };
check(
  "composeArgs with files: compose.yaml, then the extra files, then the profile",
  composeArgs(withFiles, "up").join(" ") ===
    "compose -p pm-t -f compose.yaml -f providers/fake/compose.yaml -f extra.yaml --profile fake up",
);
fs.writeFileSync(path.join(stack, "compose.override.yaml"), "services: {}\n");
check(
  "composeArgs puts compose.override.yaml before the extra files when it exists",
  composeArgs(withFiles, "down").join(" ") ===
    "compose -p pm-t -f compose.yaml -f compose.override.yaml -f providers/fake/compose.yaml -f extra.yaml --profile fake down",
);
check("composeCommandText prints the docker command", composeCommandText(withProfile, "down", "-v") === "docker compose -p pm-t --profile fake down -v");
fs.rmSync(stack, { recursive: true, force: true });

// Provider directory override (tests, fixtures) and the manifest-driven API base.
const fixtures = path.join(here, "fixtures/providers");
process.env.PM_PROVIDERS_DIR = fixtures;
check("PM_PROVIDERS_DIR overrides the providers directory", providersRoot() === path.resolve(fixtures));
check("fixture providers list from the override only", listSelectableProviders().map((m) => m.id).sort().join(",") === "hooked,nohooks");
check("fixture manifests validate", listAllProviders().every((m) => validateManifest(m).length === 0));
check("override does not leak the real hindsight manifest", loadManifest("hindsight") === null);
check("resolveProvider loads a fixture", resolveProvider("nohooks").label === "No-hooks fixture");
check("hooked fixture declares profile and files", loadManifest("hooked").compose.profile === "hooked" && loadManifest("hooked").compose.files[0] === "fixture-fragment.yaml");
const prevPort = process.env.NOHOOKS_PORT;
delete process.env.NOHOOKS_PORT;
check("providerApiBase uses the manifest default port", providerApiBase({}, loadManifest("nohooks")) === "http://127.0.0.1:18765");
process.env.NOHOOKS_PORT = "19999";
check("providerApiBase honors compose.hostPortEnv", providerApiBase({}, loadManifest("nohooks")) === "http://127.0.0.1:19999");
if (prevPort === undefined) delete process.env.NOHOOKS_PORT;
else process.env.NOHOOKS_PORT = prevPort;
delete process.env.PM_PROVIDERS_DIR;
const prevPkg = process.env.PM_PACKAGE_ROOT;
process.env.PM_PACKAGE_ROOT = "/tmp/pm-package-root-x";
check("PM_PACKAGE_ROOT selects <root>/providers", providersRoot() === "/tmp/pm-package-root-x/providers");
if (prevPkg === undefined) delete process.env.PM_PACKAGE_ROOT;
else process.env.PM_PACKAGE_ROOT = prevPkg;

if (fails) {
  console.log(`${fails} provider manifest test(s) failed`);
  process.exit(1);
}
console.log("all provider manifest tests passed");
