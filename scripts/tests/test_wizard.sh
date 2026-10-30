#!/usr/bin/env bash
# Tests for ./setup (wizard/bin/setup.mjs; scripts/wizard.sh is a thin Node wrapper).
# Stub docker, curl, ollama, lemonade, and npx on PATH and a scratch HOME.
# Runs against a copy of the repo, so setup.sh's compose.override.yaml and .env never land in the checkout.
# Never touches the live stack or the real ~/.config/hindsight.
set -euo pipefail

REPO="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
FAILS=0

# Full path: unit tests use env -i with a minimal PATH.
TEST_NODE=""
if command -v node >/dev/null 2>&1; then
    TEST_NODE="$(command -v node)"
fi

pass() { printf 'ok    %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; FAILS=$((FAILS + 1)); }
check() {
    local desc="$1"; shift
    if "$@"; then pass "${desc}"; else fail "${desc}"; fi
}

# Stubs: log every call to STUB_LOG and answer just enough for the wizard's happy path.
make_stubs() {
    local dir="$1"
    mkdir -p "${dir}"
    cat > "${dir}/docker" <<'STUB'
#!/usr/bin/env bash
echo "docker $*" >> "${STUB_LOG}"
case "$*" in "compose -p"*) echo "$PWD" >> "${STUB_LOG}.cwd" ;; esac
case "$1" in
    info|ps) exit 0 ;;
    compose)
        case "$*" in
            *" version"*) echo "Docker Compose version v2.29.0" ;;
            *" run "*) printf 'repo\t%s/src/demo-repo\nvault\t%s/vault\n' "${HOME}" "${HOME}" ;;
        esac ;;
esac
exit 0
STUB
    cat > "${dir}/curl" <<'STUB'
#!/usr/bin/env bash
echo "curl $*" >> "${STUB_LOG}"
case "$*" in
    */v1/models*) echo '{"object":"list","data":[{"id":"Gemma-4-E2B-it-GGUF","downloaded":true},{"id":"gemma-4-E4B-it-GGUF-Q4_K_M","downloaded":true}]}' ;;
    */api/tags*) exit 7 ;;
    */memories/recall*) echo '{"results":[{"text":"The project codename is heron."}]}' ;;
    *) echo '{}' ;;
esac
exit 0
STUB
    cat > "${dir}/ollama" <<'STUB'
#!/usr/bin/env bash
echo "ollama $*" >> "${STUB_LOG}"
exit 0
STUB
    cat > "${dir}/lemonade" <<'STUB'
#!/usr/bin/env bash
echo "lemonade $*" >> "${STUB_LOG}"
exit 0
STUB
    cat > "${dir}/npx" <<'STUB'
#!/usr/bin/env bash
echo "npx $*" >> "${STUB_LOG}"
exit 0
STUB
    chmod +x "${dir}"/*
}

# A scratch HOME with one git repo and one Obsidian vault for the index scan.
make_home() {
    local home="$1"
    mkdir -p "${home}/src/demo-repo" "${home}/vault/.obsidian"
    git -C "${home}/src/demo-repo" init -q
    printf '# Demo\n' > "${home}/src/demo-repo/README.md"
}

# run_wizard HOME COPY LOG OUT [args...]: runs the Node setup wizard with a clean environment.
run_wizard() {
    local home="$1" copy="$2" log="$3" out="$4"; shift 4
    [ -n "${TEST_NODE}" ] || {
        echo "FAIL  wizard run skipped (no node on PATH)" >&2
        return 1
    }
    env -i PATH="${WORK}/stubs:/usr/bin:/bin" LANG=C.UTF-8 TERM=dumb HOME="${home}" \
        STUB_LOG="${log}" PM_PROJECT=pm-wizard-unit PM_REFLECT_MODEL="${PM_REFLECT_MODEL:-}" HINDSIGHT_PORT=28888 HINDSIGHT_CP_PORT=29999 \
        "${TEST_NODE}" "${copy}/wizard/bin/setup.mjs" "$@" > "${out}" 2>&1
}

# run_setup HOME COPY LOG OUT [args...]: ./setup entry (Node → bash when --yes or non-TTY).
run_setup() {
    local home="$1" copy="$2" log="$3" out="$4"; shift 4
    env -i PATH="${WORK}/stubs:/usr/bin:/bin" LANG=C.UTF-8 TERM=dumb HOME="${home}" \
        STUB_LOG="${log}" PM_PROJECT=pm-wizard-unit PM_REFLECT_MODEL="${PM_REFLECT_MODEL:-}" HINDSIGHT_PORT=28888 HINDSIGHT_CP_PORT=29999 \
        "${TEST_NODE}" "${copy}/wizard/bin/setup.mjs" "$@" > "${out}" 2>&1
}

copy_repo() {
    local dest="$1"
    mkdir -p "${dest}"
    (cd "${REPO}" && tar --exclude=.git --exclude=.env --exclude=compose.override.yaml --exclude=.build-hash \
        --exclude=node_modules --exclude=wizard/node_modules -cf - .) | tar -xf - -C "${dest}"
    # Match ensureWizardDeps (cli/roots.mjs): deps live at the package root, not wizard/ only.
    (cd "${dest}" && npm ci --no-fund --no-audit --silent 2>/dev/null) ||
        (cd "${dest}" && npm install --no-fund --no-audit --silent)
}

make_stubs "${WORK}/stubs"

# (a) dry run: prints the plan, writes nothing.
test_dry_run() {
    local home="${WORK}/home-dry" copy="${WORK}/copy-dry" out="${WORK}/dry.out" log="${WORK}/dry.log"
    mkdir -p "${home}"; make_home "${home}"; copy_repo "${copy}"
    local before
    before="$(cd "${home}" && find . | sort)"
    local rc=0
    run_wizard "${home}" "${copy}" "${log}" "${out}" --yes --dry-run || rc=$?
    check "dry run exits 0" [ "${rc}" -eq 0 ]
    check "preflight ok (compose v2)" grep -q 'compose v2 work without sudo' "${out}"
    check "preflight uses free ports 28888/29999" grep -q 'Hindsight API port 28888 is free' "${out}"
    check "memory provider step" grep -q 'memory provider Hindsight' "${out}"
    check "hindsight sub-wizard model routing" grep -q 'provider hindsight: configureModelRouting' "${out}"
    check "lemond chosen as backend" grep -q 'lemond answers' "${out}"
    check "dry run plans hindsight.env" grep -q '\[dry-run\] create .*hindsight.env' "${out}"
    check "dry run plans setup.sh" grep -q '\[dry-run\] scripts/setup.sh: write .env' "${out}"
    check "dry run plans compose up" grep -q '\[dry-run\] docker compose -p pm-wizard-unit --profile hindsight up -d --no-build' "${out}"
    check "dry run plans smoke test" grep -q 'dry-run\] retain and recall' "${out}"
    check "no docker mutation calls" bash -c "! grep -q -E 'docker compose .* (up|build|run) ' '${log}' 2>/dev/null"
    check "scratch HOME unchanged" [ "$(cd "${home}" && find . | sort)" = "${before}" ]
    check "repo copy has no .env or override" bash -c "[ ! -e '${copy}/.env' ] && [ ! -e '${copy}/compose.override.yaml' ]"
}

# (a2) ./setup --yes --dry-run delegates to the same bash wizard (non-TTY path).
test_setup_entry_dry_run() {
    local home="${WORK}/home-setup-dry" copy="${WORK}/copy-setup-dry" out="${WORK}/setup-dry.out" log="${WORK}/setup-dry.log"
    mkdir -p "${home}"; make_home "${home}"; copy_repo "${copy}"
    [ -n "${TEST_NODE}" ] || {
        pass "setup entry dry run skipped (no node on PATH)"
        return 0
    }
    local rc=0
    run_setup "${home}" "${copy}" "${log}" "${out}" --yes --dry-run || rc=$?
    check "setup --yes --dry-run exits 0" [ "${rc}" -eq 0 ]
    check "setup entry: lemond chosen as backend" grep -q 'lemond answers' "${out}"
    check "setup entry: dry run plans hindsight.env" grep -q '\[dry-run\] create .*hindsight.env' "${out}"
    check "setup entry: dry run plans compose up" grep -q '\[dry-run\] docker compose -p pm-wizard-unit --profile hindsight up -d --no-build' "${out}"
}

# (a3) Clack handoff env runs the same backend step as bash --yes.
test_clack_backend_handoff() {
    local home="${WORK}/home-handoff" copy="${WORK}/copy-handoff" out="${WORK}/handoff.out" log="${WORK}/handoff.log"
    mkdir -p "${home}"; make_home "${home}"; copy_repo "${copy}"
    local rc=0
    env -i PATH="${WORK}/stubs:/usr/bin:/bin" LANG=C.UTF-8 TERM=dumb HOME="${home}" \
        STUB_LOG="${log}" PM_PROJECT=pm-wizard-unit HINDSIGHT_PORT=28888 HINDSIGHT_CP_PORT=29999 \
        WIZARD_SKIP_BACKEND_STEP=1 PM_WIZARD_ACTION=configure MEMORY_PROVIDER=hindsight PM_BACKEND=lemond \
        PM_DEFAULT_MODEL=Custom-Retain-GGUF MEMORY_API_BASE=http://host.docker.internal:13305/v1 \
        PM_REFLECT_MODEL=Other-Reflect-GGUF \
        "${TEST_NODE}" "${copy}/wizard/bin/setup.mjs" --yes --dry-run > "${out}" 2>&1 || rc=$?
    check "clack handoff dry run exits 0" [ "${rc}" -eq 0 ]
    check "clack handoff: provider from UI" grep -q 'memory provider Hindsight (setup UI)' "${out}"
    check "clack handoff: backend from UI" grep -q 'backend lemond, model Custom-Retain-GGUF (setup UI)' "${out}"
}

# (b) two real runs with stubs: the second keeps everything and writes no new secrets or configs.
test_idempotent() {
    local home="${WORK}/home-idem" copy="${WORK}/copy-idem" log="${WORK}/idem.log"
    mkdir -p "${home}"; make_home "${home}"; copy_repo "${copy}"
    local hs="${home}/.config/hindsight"
    local rc=0
    run_wizard "${home}" "${copy}" "${log}" "${WORK}/run1.out" --yes || rc=$?
    check "first run exits 0" [ "${rc}" -eq 0 ]
    check "first run: hindsight.env mode 600" [ "$(stat -c %a "${hs}/hindsight.env")" = 600 ]
    check "first run: litellm.env mode 600" [ "$(stat -c %a "${hs}/litellm.env")" = 600 ]
    check "first run: index.yml written" [ -f "${hs}/index.yml" ]
    check "first run: indexer state mount point created" [ -d "${home}/.cache/hindsight-project-index" ]
    check "first run: wizard.conf written" [ -f "${hs}/wizard.conf" ]
    check "first run: wizard.conf records hindsight provider" grep -q '^MEMORY_PROVIDER=hindsight$' "${hs}/wizard.conf"
    check "first run: writes mise-like config.toml" [ -f "${home}/.config/personal-memory/config.toml" ]
    check "first run: config.toml records provider" grep -q 'provider = "hindsight"' "${home}/.config/personal-memory/config.toml"
    check "first run: memory validation passed" grep -q 'memory setup validation passed' "${WORK}/run1.out"
    check "first run: repo .env has ports" bash -c "grep -q '^HINDSIGHT_PORT=28888$' '${copy}/.env' && grep -q '^HINDSIGHT_CP_PORT=29999$' '${copy}/.env'"
    check "first run: repo .env enables hindsight profile" grep -q '^COMPOSE_PROFILES=hindsight$' "${copy}/.env"
    check "first run: compose up and --list called" bash -c "grep -q 'up -d --no-build' '${log}' && grep -q -- '--list' '${log}'"
    check "first run: smoke test deleted bank" grep -q 'DELETE.*wizard-smoke' "${log}"
    check "first run: smoke recall passed" grep -q 'retain and recall worked' "${WORK}/run1.out"
    check "first run: change count above zero" grep -Eq '^wizard: changed=[1-9]' "${WORK}/run1.out"
    check "first run: indexer built once and hash recorded" bash -c "[ \"\$(grep -c 'compose -p pm-wizard-unit --profile hindsight build indexer' '${log}')\" = 1 ] && grep -q '^indexer ' '${copy}/.build-hash'"

    local sums_before baks_before
    sums_before="$(sha256sum "${hs}/hindsight.env" "${hs}/litellm.env" "${hs}/index.yml" "${hs}/wizard.conf" | sort)"
    baks_before="$(find "${hs}" -name '*.bak*' | wc -l)"
    rc=0
    run_wizard "${home}" "${copy}" "${log}.2" "${WORK}/run2.out" --yes || rc=$?
    check "second run exits 0" [ "${rc}" -eq 0 ]
    check "second run keeps hindsight.env" grep -q 'kept .*hindsight.env' "${WORK}/run2.out"
    check "second run keeps index.yml" grep -q 'kept .*index.yml' "${WORK}/run2.out"
    check "second run: change count zero" grep -qx 'wizard: changed=0' "${WORK}/run2.out"
    check "second run: secret and config bytes unchanged" bash -c \
        "[ \"\$(sha256sum '${hs}/hindsight.env' '${hs}/litellm.env' '${hs}/index.yml' '${hs}/wizard.conf' | sort)\" = \"${sums_before}\" ]"
    check "second run: no new backup files" [ "$(find "${hs}" -name '*.bak*' | wc -l)" = "${baks_before}" ]
}

# (c) image builds follow the build hash: a repeat run builds nothing, an indexer source edit builds, --rebuild forces.
test_build_cache() {
    local home="${WORK}/home-idem" copy="${WORK}/copy-idem" log="${WORK}/idem.log"
    local rc=0
    run_wizard "${home}" "${copy}" "${log}.3" "${WORK}/run3.out" --yes || rc=$?
    check "unchanged rerun exits 0" [ "${rc}" -eq 0 ]
    check "unchanged rerun: no image build" bash -c "! grep -q 'compose -p pm-wizard-unit --profile hindsight build' '${log}.3'"
    check "unchanged rerun: start skips build" grep -q 'up -d --no-build' "${log}.3"

    echo "# edit" >> "${copy}/indexer/watch.py"
    rc=0
    run_wizard "${home}" "${copy}" "${log}.4" "${WORK}/run4.out" --yes || rc=$?
    check "source edit exits 0" [ "${rc}" -eq 0 ]
    check "source edit: indexer rebuilt" grep -q 'compose -p pm-wizard-unit --profile hindsight build indexer' "${log}.4"

    rc=0
    run_wizard "${home}" "${copy}" "${log}.5" "${WORK}/run5.out" --yes --rebuild || rc=$?
    check "--rebuild exits 0" [ "${rc}" -eq 0 ]
    check "--rebuild: indexer rebuilt without source change" grep -q 'compose -p pm-wizard-unit --profile hindsight build indexer' "${log}.5"
}

# route_model ALIAS FILE: the litellm model string of one route in a LiteLLM YAML file.
route_model() {
    awk -v n="$1" '/^  - model_name: / { f = ($3 == n) } f && /^      model: / { sub(/^      model: /, ""); print; exit }' "$2"
}

# (d) a custom retain model keeps the shipped reflect route; PM_REFLECT_MODEL sets a separate one.
test_reflect_route() {
    local home="${WORK}/home-idem" copy="${WORK}/copy-idem" log="${WORK}/reflect.log"
    local ovr="${home}/.config/hindsight/litellm.yaml" rc=0
    sed -i 's/^MEMORY_MODEL=.*/MEMORY_MODEL=Custom-Retain-GGUF/' "${home}/.config/hindsight/wizard.conf"
    run_wizard "${home}" "${copy}" "${log}" "${WORK}/reflect1.out" --yes || rc=$?
    check "custom retain model: wizard exits 0" [ "${rc}" -eq 0 ]
    check "custom retain model: override written" [ -f "${ovr}" ]
    check "custom retain model: retain route uses it" [ "$(route_model memory-retain "${ovr}")" = "openai/Custom-Retain-GGUF" ]
    check "custom retain model: consolidate uses it" [ "$(route_model memory-consolidate "${ovr}")" = "openai/Custom-Retain-GGUF" ]
    check "custom retain model: reflect keeps shipped model" [ "$(route_model memory-reflect "${ovr}")" = "openai/Nemotron-3.5-Bolt-E4B-GGUF" ]
    check "custom retain model: shipped thinking flag kept" grep -q 'enable_thinking: false' "${ovr}"

    rc=0
    PM_REFLECT_MODEL=Other-Reflect-GGUF run_wizard "${home}" "${copy}" "${log}.2" "${WORK}/reflect2.out" --yes || rc=$?
    check "separate reflect model: wizard exits 0" [ "${rc}" -eq 0 ]
    check "separate reflect model: reflect route uses it" [ "$(route_model memory-reflect "${ovr}")" = "openai/Other-Reflect-GGUF" ]
    check "separate reflect model: retain unchanged" [ "$(route_model memory-retain "${ovr}")" = "openai/Custom-Retain-GGUF" ]
}

# (e) stack down dry-run plans compose down without mutation.
test_stack_down_dry_run() {
    local home="${WORK}/home-down" copy="${WORK}/copy-down" out="${WORK}/down.out" log="${WORK}/down.log"
    mkdir -p "${home}"; copy_repo "${copy}"
    local rc=0
    run_wizard "${home}" "${copy}" "${log}" "${out}" --down --yes --dry-run || rc=$?
    check "stack down dry run exits 0" [ "${rc}" -eq 0 ]
    check "stack down dry run plans compose down" grep -q '\[dry-run\] docker compose -p pm-wizard-unit --profile hindsight down' "${out}"
    check "stack down dry run skips full configure" bash -c "! grep -q 'Sources to index' '${out}'"
}

# run_fixture HOME COPY LOG OUT PROVIDER [env...] -- [args...]: wizard run against the test-only provider
# fixtures in scripts/tests/fixtures/providers (PM_PROVIDERS_DIR). No HINDSIGHT_* variables are passed.
run_fixture() {
    local home="$1" copy="$2" log="$3" out="$4" provider="$5"; shift 5
    local envs=()
    while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do envs+=("$1"); shift; done
    [ "$#" -gt 0 ] && shift
    env -i PATH="${WORK}/stubs:/usr/bin:/bin" LANG=C.UTF-8 TERM=dumb HOME="${home}" \
        STUB_LOG="${log}" PM_PROJECT=pm-wizard-unit MEMORY_PROVIDER="${provider}" \
        PM_PROVIDERS_DIR="${REPO}/scripts/tests/fixtures/providers" "${envs[@]}" \
        "${TEST_NODE}" "${copy}/wizard/bin/setup.mjs" "$@" > "${out}" 2>&1
}

# (f) a provider with no model backend and no hooks: nothing Hindsight-shaped is created, required or printed.
# The test-only fixture provider "nohooks" stands in for a provider with no wizard hooks (the shipped
# experimental mem0 and Cognee providers have hooks).
test_provider_without_model_backend() {
    local home="${WORK}/home-nohooks" copy="${WORK}/copy-nohooks" out="${WORK}/nohooks-dry.out" log="${WORK}/nohooks.log"
    mkdir -p "${home}"; make_home "${home}"; copy_repo "${copy}"
    local before rc=0
    before="$(cd "${home}" && find . | sort)"
    run_fixture "${home}" "${copy}" "${log}" "${out}" nohooks NOHOOKS_PORT=28765 -- --yes --dry-run || rc=$?
    check "no-hooks provider: dry run exits 0" [ "${rc}" -eq 0 ]
    check "no-hooks provider: selected" grep -q 'memory provider No-hooks fixture' "${out}"
    check "no-hooks provider: dry run never mentions hindsight.env, litellm, HINDSIGHT_*, lemond or ollama" \
        bash -c "! grep -q -E 'hindsight\\.env|litellm|HINDSIGHT_|Hindsight|lemond|ollama' '${out}'"
    check "no-hooks provider: no provider hook lines (every phase is a no-op)" bash -c "! grep -q '^  provider ' '${out}'"
    check "no-hooks provider: scratch HOME unchanged" [ "$(cd "${home}" && find . | sort)" = "${before}" ]
    check "no-hooks provider: health URL comes from the manifest port env" grep -q 'wait for http://127.0.0.1:28765/health' "${out}"

    rc=0
    run_fixture "${home}" "${copy}" "${log}" "${WORK}/nohooks.out" nohooks NOHOOKS_PORT=28765 -- --yes || rc=$?
    check "no-hooks provider: real run exits 0" [ "${rc}" -eq 0 ]
    local hs="${home}/.config/hindsight"
    check "no-hooks provider: no hindsight.env or litellm.env created" bash -c "[ ! -e '${hs}/hindsight.env' ] && [ ! -e '${hs}/litellm.env' ] && [ ! -e '${hs}/litellm.yaml' ]"
    check "no-hooks provider: wizard.conf holds only MEMORY_PROVIDER" bash -c "[ \"\$(cat '${hs}/wizard.conf')\" = 'MEMORY_PROVIDER=nohooks' ]"
    check "no-hooks provider: config.toml written without model or port tables" bash -c \
        "grep -q 'provider = \"nohooks\"' '${home}/.config/personal-memory/config.toml' && ! grep -q -E '\\[model|api_port' '${home}/.config/personal-memory/config.toml'"
    check "no-hooks provider: stack .env has host ids only" bash -c \
        "grep -q '^HOST_UID=' '${copy}/.env' && grep -q '^HOST_GID=' '${copy}/.env' && ! grep -q -E 'HINDSIGHT|LITELLM|COMPOSE_PROFILES' '${copy}/.env'"
    check "no-hooks provider: validation passes without MEMORY_BACKEND/MEMORY_MODEL" grep -q 'memory setup validation passed' "${WORK}/nohooks.out"
    check "no-hooks provider: no Hindsight text in a real run" \
        bash -c "! grep -q -E 'hindsight\\.env|litellm|HINDSIGHT_|Hindsight|lemond|ollama' '${WORK}/nohooks.out'"
    check "no-hooks provider: compose up has no --profile or -f flags" grep -q 'docker compose -p pm-wizard-unit up -d --no-build' "${log}"
    check "no-hooks provider: smoke runs from the manifest template" grep -q 'retain and recall worked' "${WORK}/nohooks.out"
    check "no-hooks provider: smoke URLs use the manifest port" grep -q 'curl .*127.0.0.1:28765/fixture/wizard-smoke/memories' "${log}"
    rc=0
    run_fixture "${home}" "${copy}" "${log}.2" "${WORK}/nohooks2.out" nohooks NOHOOKS_PORT=28765 -- --yes || rc=$?
    check "no-hooks provider: second run exits 0 with zero changes" bash -c "[ ${rc} -eq 0 ] && grep -qx 'wizard: changed=0' '${WORK}/nohooks2.out'"
}

# (g) a provider with v2 hooks, a compose profile and a compose fragment: hooks run, compose calls carry
# --profile and -f, the smoke hook replaces the HTTP template, the apiBase hook feeds the health check.
test_provider_with_hooks() {
    local home="${WORK}/home-hooked" copy="${WORK}/copy-hooked" out="${WORK}/hooked.out" log="${WORK}/hooked.log"
    mkdir -p "${home}"; make_home "${home}"; copy_repo "${copy}"
    echo "services: {}" > "${copy}/fixture-fragment.yaml"
    local rc=0
    run_fixture "${home}" "${copy}" "${log}" "${out}" hooked HOOKED_PORT=28766 -- --yes || rc=$?
    check "hooked provider: real run exits 0" [ "${rc}" -eq 0 ]
    check "hooked provider: resolvePorts hook used helpers.resolveHostPort" grep -q 'Hooked API port 28766 is free' "${out}"
    check "hooked provider: hook announced" grep -q 'provider hooked: resolvePorts' "${out}"
    check "hooked provider: apiBase hook feeds the health check" grep -q 'curl .*http://127.0.0.1:28766/health' "${log}"
    check "hooked provider: smoke hook replaces the HTTP template" bash -c "grep -q 'hooked smoke override ran' '${out}' && ! grep -q '/memories' '${log}'"
    check "hooked provider: summary hook lines printed" bash -c "grep -q 'Hooked API         http://127.0.0.1:28766' '${out}' && grep -q 'Hooked note line' '${out}'"
    check "hooked provider: extendValidation check merged" grep -q 'check: hooked validation ran' "${out}"
    check "hooked provider: up has -f files and --profile" grep -q 'docker compose -p pm-wizard-unit -f compose.yaml -f compose.override.yaml -f fixture-fragment.yaml --profile hooked up -d --no-build' "${log}"
    check "hooked provider: build has -f files and --profile" grep -q 'docker compose -p pm-wizard-unit -f compose.yaml -f compose.override.yaml -f fixture-fragment.yaml --profile hooked build indexer' "${log}"
    check "hooked provider: indexer listing uses the same flags" grep -q -- '-f fixture-fragment.yaml --profile hooked run --rm --no-deps -T' "${log}"
    check "hooked provider: ps uses the same flags" grep -q -- '--profile hooked ps -q' "${log}"
    check "hooked provider: summary Stop line carries the flags" grep -q 'Stop:  docker compose -p pm-wizard-unit -f compose.yaml -f compose.override.yaml -f fixture-fragment.yaml --profile hooked down' "${out}"
    check "hooked provider: every compose call ran in the stack root" bash -c "[ \"\$(sort -u '${log}.cwd')\" = '${copy}' ]"
    rc=0
    run_fixture "${home}" "${copy}" "${log}.d" "${WORK}/hooked-down.out" hooked HOOKED_PORT=28766 -- --down --yes --dry-run || rc=$?
    check "hooked provider: down dry run carries the profile" bash -c "[ ${rc} -eq 0 ] && grep -q '\\[dry-run\\] docker compose -p pm-wizard-unit -f compose.yaml -f compose.override.yaml -f fixture-fragment.yaml --profile hooked down' '${WORK}/hooked-down.out'"
}

# (g2) the shipped mem0 and Cognee providers (experimental) dry-run through ./setup --yes: exit 0, nothing written,
# and the plan prints the compose command with their profile and fragment. Dummy URL, no live server.
test_shipped_experimental_providers() {
    local id home copy out log rc before
    for id in mem0 cognee; do
        home="${WORK}/home-ship-${id}" copy="${WORK}/copy-ship-${id}" out="${WORK}/ship-${id}.out" log="${WORK}/ship-${id}.log"
        mkdir -p "${home}"; make_home "${home}"; copy_repo "${copy}"
        before="$(cd "${home}" && find . | sort)"
        rc=0
        env -i PATH="${WORK}/stubs:/usr/bin:/bin" LANG=C.UTF-8 TERM=dumb HOME="${home}" \
            STUB_LOG="${log}" PM_PROJECT=pm-wizard-unit MEMORY_PROVIDER="${id}" MEM0_API_URL=http://127.0.0.1:1 \
            "${TEST_NODE}" "${copy}/wizard/bin/setup.mjs" --yes --dry-run > "${out}" 2>&1 || rc=$?
        check "shipped ${id}: dry run exits 0" [ "${rc}" -eq 0 ]
        check "shipped ${id}: dry run plans compose up with the profile and fragment" \
            grep -q "\[dry-run\] docker compose -p pm-wizard-unit -f compose.yaml -f providers/${id}/compose.yaml --profile ${id} up -d --no-build" "${out}"
        check "shipped ${id}: summary Stop line carries the profile and fragment" \
            grep -q "Stop:  docker compose -p pm-wizard-unit -f compose.yaml -f providers/${id}/compose.yaml --profile ${id} down" "${out}"
        check "shipped ${id}: no mutating docker calls" bash -c "! grep -q -E 'docker compose .* (up|build|run|down) ' '${log}' 2>/dev/null"
        check "shipped ${id}: scratch HOME unchanged" [ "$(cd "${home}" && find . | sort)" = "${before}" ]
        check "shipped ${id}: stack .env not created" [ ! -e "${copy}/.env" ]
    done
}

# (g3) the preflight needs Docker Compose 2.24 (provider fragments use env_file required: false): a real run
# fails with a clear message on an older plugin, a dry run only warns, and 2.24 itself passes.
test_compose_version_guard() {
    local home="${WORK}/home-cver" copy="${WORK}/copy-cver" rc=0 ver dir
    mkdir -p "${home}"; make_home "${home}"; copy_repo "${copy}"
    for ver in 2.23.3 2.24.0; do
        dir="${WORK}/stubs-${ver}"
        make_stubs "${dir}"
        sed -i "s/Docker Compose version v2.29.0/${ver}/" "${dir}/docker"
    done
    rc=0
    env -i PATH="${WORK}/stubs-2.23.3:/usr/bin:/bin" LANG=C.UTF-8 TERM=dumb HOME="${home}" STUB_LOG="${WORK}/cver1.log" \
        PM_PROJECT=pm-wizard-unit HINDSIGHT_PORT=28888 HINDSIGHT_CP_PORT=29999 \
        "${TEST_NODE}" "${copy}/wizard/bin/setup.mjs" --yes > "${WORK}/cver1.out" 2>&1 || rc=$?
    check "compose 2.23: real run fails" [ "${rc}" -ne 0 ]
    check "compose 2.23: message names 2.24 and the found version" grep -q 'Compose 2.24 or newer is required.*found 2.23' "${WORK}/cver1.out"
    check "compose 2.23: nothing started" bash -c "! grep -q -E 'docker compose .* (up|build|run) ' '${WORK}/cver1.log' 2>/dev/null"
    rc=0
    env -i PATH="${WORK}/stubs-2.23.3:/usr/bin:/bin" LANG=C.UTF-8 TERM=dumb HOME="${home}" STUB_LOG="${WORK}/cver2.log" \
        PM_PROJECT=pm-wizard-unit HINDSIGHT_PORT=28888 HINDSIGHT_CP_PORT=29999 \
        "${TEST_NODE}" "${copy}/wizard/bin/setup.mjs" --yes --dry-run > "${WORK}/cver2.out" 2>&1 || rc=$?
    check "compose 2.23: dry run only warns and exits 0" bash -c "[ ${rc} -eq 0 ] && grep -q 'Compose 2.24 or newer is required.*dry run: continuing' '${WORK}/cver2.out'"
    rc=0
    env -i PATH="${WORK}/stubs-2.24.0:/usr/bin:/bin" LANG=C.UTF-8 TERM=dumb HOME="${home}" STUB_LOG="${WORK}/cver3.log" \
        PM_PROJECT=pm-wizard-unit HINDSIGHT_PORT=28888 HINDSIGHT_CP_PORT=29999 \
        "${TEST_NODE}" "${copy}/wizard/bin/setup.mjs" --yes --dry-run > "${WORK}/cver3.out" 2>&1 || rc=$?
    check "compose 2.24 (short form): dry run exits 0 without a warning" bash -c "[ ${rc} -eq 0 ] && ! grep -q 'Compose 2.24 or newer' '${WORK}/cver3.out' && grep -q 'compose v2 work without sudo' '${WORK}/cver3.out'"
}

# (h) PM_PACKAGE_ROOT: code (wizard, providers, scripts) comes from the package root, every generated file
# (.env, compose.override.yaml, .build-hash) and every docker call lives in the stack root.
test_package_root_split() {
    local home="${WORK}/home-split" pkg="${WORK}/copy-pkg" stack="${WORK}/copy-stack" out="${WORK}/split.out" log="${WORK}/split.log"
    mkdir -p "${home}" "${WORK}/elsewhere"; make_home "${home}"; copy_repo "${pkg}"; copy_repo "${stack}"
    rm -rf "${stack}/wizard" "${stack}/providers" "${stack}/scripts" "${stack}/setup" "${stack}/pm"
    local rc=0
    (cd "${WORK}/elsewhere" && env -i PATH="${WORK}/stubs:/usr/bin:/bin" LANG=C.UTF-8 TERM=dumb HOME="${home}" \
        STUB_LOG="${log}" PM_PROJECT=pm-wizard-unit HINDSIGHT_PORT=28888 HINDSIGHT_CP_PORT=29999 \
        PM_PACKAGE_ROOT="${pkg}" "${TEST_NODE}" --input-type=module -e \
        "import { runWizard } from '${pkg}/wizard/lib/run-wizard.mjs'; await runWizard('${stack}', ['--yes']);" > "${out}" 2>&1) || rc=$?
    check "package/stack split: wizard run exits 0" [ "${rc}" -eq 0 ]
    check "package/stack split: .env and compose.override.yaml written in the stack root" bash -c "[ -f '${stack}/.env' ] && [ -f '${stack}/compose.override.yaml' ]"
    check "package/stack split: nothing generated in the package root" bash -c "[ ! -e '${pkg}/.env' ] && [ ! -e '${pkg}/compose.override.yaml' ] && [ ! -e '${pkg}/.build-hash' ]"
    check "package/stack split: .build-hash lives in the stack root" [ -f "${stack}/.build-hash" ]
    check "package/stack split: provider hooks loaded from the package root" grep -q 'provider hindsight: configureModelRouting' "${out}"
    check "package/stack split: every compose call ran in the stack root" bash -c \
        "[ \"\$(sort -u '${log}.cwd')\" = '${stack}' ]"
    check "package/stack split: validation passed" grep -q 'memory setup validation passed' "${out}"
}

# (i) step 8 context management: the default follows [context_proxy] enabled; on starts the
# context-proxy service with its profile (key file and store dirs first), off stops it when it runs.
test_context_management_step() {
    local home="${WORK}/home-ctx" copy="${WORK}/copy-ctx" log="${WORK}/ctx.log" rc=0
    local cfg="${home}/.config/personal-memory/config.toml"
    mkdir -p "${home}/.config/personal-memory"; make_home "${home}"; copy_repo "${copy}"
    printf '[context_proxy]\nenabled = true\n' > "${cfg}"
    run_wizard "${home}" "${copy}" "${log}" "${WORK}/ctx-dry.out" --yes --dry-run || rc=$?
    check "context step: dry run exits 0" [ "${rc}" -eq 0 ]
    check "context step: title printed" grep -q '== 8. Context management (smart compaction) ==' "${WORK}/ctx-dry.out"
    check "context step: default follows config (on)" grep -q 'ok context management on' "${WORK}/ctx-dry.out"
    check "context step: dry run plans the proxy start" \
        grep -q '\[dry-run\] docker compose -p pm-wizard-unit --profile hindsight --profile context-proxy up -d --no-build context-proxy' "${WORK}/ctx-dry.out"
    check "context step: dry run writes no key file" [ ! -e "${home}/.config/personal-memory/context-proxy.env" ]

    rc=0
    run_wizard "${home}" "${copy}" "${log}.on" "${WORK}/ctx-on.out" --yes || rc=$?
    check "context step on: real run exits 0" [ "${rc}" -eq 0 ]
    check "context step on: compose starts context-proxy" grep -q 'compose -p pm-wizard-unit --profile hindsight --profile context-proxy up -d --no-build context-proxy' "${log}.on"
    check "context step on: key file mode 600" [ "$(stat -c %a "${home}/.config/personal-memory/context-proxy.env")" = 600 ]
    check "context step on: store directory created" [ -d "${home}/.local/share/openmem/context/sessions" ]
    check "context step on: config sync keeps enabled = true" grep -q '^enabled = true' "${cfg}"

    # A docker stub whose compose ps reports a running context-proxy container.
    local stubs="${WORK}/stubs-ctx"
    make_stubs "${stubs}"
    sed -i '/\*" version"\*)/i\            *" ps -q context-proxy"*) echo ctxid ;;' "${stubs}/docker"
    sed -i 's/^enabled = true/enabled = false/' "${cfg}"
    rc=0
    env -i PATH="${stubs}:/usr/bin:/bin" LANG=C.UTF-8 TERM=dumb HOME="${home}" \
        STUB_LOG="${log}.off" PM_PROJECT=pm-wizard-unit HINDSIGHT_PORT=28888 HINDSIGHT_CP_PORT=29999 \
        "${TEST_NODE}" "${copy}/wizard/bin/setup.mjs" --yes > "${WORK}/ctx-off.out" 2>&1 || rc=$?
    check "context step off: real run exits 0" [ "${rc}" -eq 0 ]
    check "context step off: no proxy start" bash -c "! grep -q 'up -d --no-build context-proxy' '${log}.off'"
    check "context step off: running proxy stopped" grep -q 'compose -p pm-wizard-unit --profile hindsight --profile context-proxy stop context-proxy' "${log}.off"
    check "context step off: config keeps enabled = false" grep -q '^enabled = false' "${cfg}"
}

test_dry_run
test_setup_entry_dry_run
test_clack_backend_handoff
test_idempotent
test_reflect_route
test_build_cache
test_stack_down_dry_run
test_provider_without_model_backend
test_provider_with_hooks
test_shipped_experimental_providers
test_compose_version_guard
test_package_root_split
test_context_management_step

if [ -n "${TEST_NODE}" ]; then
    (cd "${REPO}" && npm ci --no-fund --no-audit --silent 2>/dev/null) ||
        (cd "${REPO}" && npm install --no-fund --no-audit --silent)
    NODE_PATH="${REPO}/node_modules" \
        "${TEST_NODE}" "${REPO}/scripts/tests/test_provider_manifests.mjs" || FAILS=$((FAILS + 1))
    NODE_PATH="${REPO}/wizard/node_modules" \
        "${TEST_NODE}" "${REPO}/scripts/tests/test_memory_setup.mjs" || FAILS=$((FAILS + 1))
    NODE_PATH="${REPO}/wizard/node_modules" \
        "${TEST_NODE}" "${REPO}/scripts/tests/test_pm_config.mjs" || FAILS=$((FAILS + 1))
    NODE_PATH="${REPO}/wizard/node_modules" \
        "${TEST_NODE}" "${REPO}/scripts/tests/test_provider_wizard_hooks.mjs" || FAILS=$((FAILS + 1))
fi

if [ "${FAILS}" -eq 0 ]; then
    echo "all wizard tests passed"
else
    echo "${FAILS} wizard test(s) failed"
    exit 1
fi
