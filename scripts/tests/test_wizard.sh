#!/usr/bin/env bash
# Tests for scripts/wizard.sh with stub docker, curl, ollama, and npx on PATH and a scratch HOME.
# Runs against a copy of the repo, so setup.sh's compose.override.yaml and .env never land in the checkout.
# Never touches the live stack or the real ~/.config/hindsight.
set -euo pipefail

REPO="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
FAILS=0

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
    */v1/models*) echo '{"object":"list","data":[{"id":"Gemma-4-E2B-it-GGUF"}]}' ;;
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

# run_wizard HOME COPY LOG OUT [args...]: runs the copy's wizard with a clean environment.
run_wizard() {
    local home="$1" copy="$2" log="$3" out="$4"; shift 4
    env -i PATH="${WORK}/stubs:/usr/bin:/bin" LANG=C.UTF-8 TERM=dumb HOME="${home}" \
        STUB_LOG="${log}" PM_PROJECT=pm-wizard-unit HINDSIGHT_PORT=28888 HINDSIGHT_CP_PORT=29999 \
        bash "${copy}/scripts/wizard.sh" "$@" > "${out}" 2>&1
}

copy_repo() {
    local dest="$1"
    mkdir -p "${dest}"
    (cd "${REPO}" && tar --exclude=.git --exclude=.env --exclude=compose.override.yaml --exclude=.build-hash -cf - .) | tar -xf - -C "${dest}"
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
    check "lemond chosen as backend" grep -q 'lemond answers' "${out}"
    check "dry run plans hindsight.env" grep -q '\[dry-run\] create .*hindsight.env' "${out}"
    check "dry run plans setup.sh" grep -q '\[dry-run\] scripts/setup.sh: write .env' "${out}"
    check "dry run plans compose up" grep -q '\[dry-run\] docker compose -p pm-wizard-unit up -d --no-build' "${out}"
    check "dry run plans smoke test" grep -q 'dry-run\] retain and recall' "${out}"
    check "no docker mutation calls" bash -c "! grep -q -E 'docker compose .* (up|build|run) ' '${log}' 2>/dev/null"
    check "scratch HOME unchanged" [ "$(cd "${home}" && find . | sort)" = "${before}" ]
    check "repo copy has no .env or override" bash -c "[ ! -e '${copy}/.env' ] && [ ! -e '${copy}/compose.override.yaml' ]"
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
    check "first run: repo .env has ports" bash -c "grep -q '^HINDSIGHT_PORT=28888$' '${copy}/.env' && grep -q '^HINDSIGHT_CP_PORT=29999$' '${copy}/.env'"
    check "first run: compose up and --list called" bash -c "grep -q 'up -d --no-build' '${log}' && grep -q -- '--list' '${log}'"
    check "first run: smoke test deleted bank" grep -q 'DELETE.*wizard-smoke' "${log}"
    check "first run: smoke recall passed" grep -q 'retain and recall worked' "${WORK}/run1.out"
    check "first run: change count above zero" grep -Eq '^wizard: changed=[1-9]' "${WORK}/run1.out"
    check "first run: indexer built once and hash recorded" bash -c "[ \"\$(grep -c 'compose -p pm-wizard-unit build indexer' '${log}')\" = 1 ] && grep -q '^indexer ' '${copy}/.build-hash'"

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
    check "unchanged rerun: no image build" bash -c "! grep -q 'compose -p pm-wizard-unit build' '${log}.3'"
    check "unchanged rerun: start skips build" grep -q 'up -d --no-build' "${log}.3"

    echo "# edit" >> "${copy}/indexer/watch.py"
    rc=0
    run_wizard "${home}" "${copy}" "${log}.4" "${WORK}/run4.out" --yes || rc=$?
    check "source edit exits 0" [ "${rc}" -eq 0 ]
    check "source edit: indexer rebuilt" grep -q 'compose -p pm-wizard-unit build indexer' "${log}.4"

    rc=0
    run_wizard "${home}" "${copy}" "${log}.5" "${WORK}/run5.out" --yes --rebuild || rc=$?
    check "--rebuild exits 0" [ "${rc}" -eq 0 ]
    check "--rebuild: indexer rebuilt without source change" grep -q 'compose -p pm-wizard-unit build indexer' "${log}.5"
}

test_dry_run
test_idempotent
test_build_cache

if [ "${FAILS}" -eq 0 ]; then
    echo "all wizard tests passed"
else
    echo "${FAILS} wizard test(s) failed"
    exit 1
fi
