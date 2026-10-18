#!/usr/bin/env bash
# Setup wizard: takes a fresh clone to a running Hindsight memory stack. Symlinked as ./setup at the repo root.
# Re-runnable: shows current values as defaults and asks before it replaces config or secrets.
#
#   ./setup                      interactive
#   ./setup --yes                accept every default, no prompts
#   ./setup --dry-run [--yes]    print the actions; read-only checks run, nothing is written or started
#   ./setup --yes --no-smoke     skip the smoke retain/recall (for scripted re-runs)
#   ./setup --rebuild            rebuild the images even when their sources are unchanged
#
# PM_PROJECT sets the compose project name (default: personal-memory). PM_BACKEND (lemond|ollama|custom)
# sets the default backend choice. The last line is "wizard: changed=N": files and containers this run altered.
# Test against a scratch HOME:
#   HOME=/tmp/wiz-home PM_PROJECT=pm-wizard-test ./setup --yes
set -euo pipefail

SCRIPT="$(readlink -f "${BASH_SOURCE[0]}")"
REPO="$(cd "$(dirname "${SCRIPT}")/.." && pwd)"

PROJECT="${PM_PROJECT:-personal-memory}"
HS_DIR="${HOME}/.config/hindsight"
ENV_FILE="${HS_DIR}/hindsight.env"
LITELLM_ENV="${HS_DIR}/litellm.env"
LITELLM_OVERRIDE="${HS_DIR}/litellm.yaml"
INDEX_FILE="${HS_DIR}/index.yml"
NOTEBOOK_FILE="${HS_DIR}/notebooklm.yml"
WIZARD_CONF="${HS_DIR}/wizard.conf"
AGENT_JSON="${HOME}/.hindsight/coding-agent.json"
LEMOND_BASE="http://127.0.0.1:13305"
OLLAMA_BASE="http://127.0.0.1:11434"
HINDSIGHT_URL=""   # set by resolve_ports
PORT_API=""
PORT_CP=""
SMOKE_BANK="wizard-smoke"
LEMOND_DEFAULT_MODEL="Gemma-4-E2B-it-GGUF"
OLLAMA_DEFAULT_MODEL="gemma4:e2b"
CUSTOM_DEFAULT_BASE="http://host.docker.internal:8080/v1"
NOTEBOOKLM_PKG="notebooklm-py[browser]==0.8.5"
BUILD_HASH_FILE="${REPO}/.build-hash"   # "service sha256" per built image; git-ignored

YES=0
DRY=0
SMOKE=1
REBUILD=0
BACKEND=""
MODEL=""
REFLECT_MODEL=""   # empty: the shipped memory-reflect route stays
API_BASE=""
LEMOND_JSON=""
LEMOND_NAMES=""
OLLAMA_JSON=""
OLLAMA_NAMES=""

if [ -t 1 ]; then
    BOLD=$'\033[1m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; RESET=$'\033[0m'
else
    BOLD=""; GREEN=""; YELLOW=""; RED=""; RESET=""
fi

step() { printf '\n%s== %s ==%s\n' "${BOLD}" "$1" "${RESET}"; }
info() { printf '  %s\n' "$*"; }
ok() { printf '  %sok%s %s\n' "${GREEN}" "${RESET}" "$*"; }
warn() { printf '  %swarn%s %s\n' "${YELLOW}" "${RESET}" "$*" >&2; }
die() {
    printf '  %serror%s %s\n' "${RED}" "${RESET}" "$*" >&2
    exit 1
}
problem() {
    if dry; then warn "$* (dry run: continuing)"; else die "$*"; fi
}

dry() { [ "${DRY}" -eq 1 ]; }

# ask VAR PROMPT DEFAULT: read an answer into VAR; --yes takes the default.
ask() {
    local var="$1" prompt="$2" default="$3" reply=""
    if [ "${YES}" -eq 1 ]; then
        reply="${default}"
    else
        read -r -p "  ${prompt} [${default}]: " reply || reply=""
    fi
    printf -v "${var}" '%s' "${reply:-${default}}"
}

# confirm PROMPT y|n: returns 0 on yes; --yes takes the default.
confirm() {
    local prompt="$1" default="$2" reply=""
    if [ "${YES}" -eq 1 ]; then
        reply="${default}"
    else
        local hint="y/N"
        [ "${default}" = y ] && hint="Y/n"
        read -r -p "  ${prompt} [${hint}]: " reply || reply=""
        reply="${reply:-${default}}"
    fi
    case "${reply}" in
        y|Y|yes) return 0 ;;
        *) return 1 ;;
    esac
}

# act DESCRIPTION COMMAND...: print the action, then run it unless --dry-run.
act() {
    local what="$1"
    shift
    if dry; then
        info "[dry-run] ${what}"
        return 0
    fi
    info "${what}"
    "$@"
}

parse_args() {
    local arg
    for arg in "$@"; do
        case "${arg}" in
            --yes|-y) YES=1 ;;
            --dry-run) DRY=1 ;;
            --no-smoke) SMOKE=0 ;;
            --rebuild) REBUILD=1 ;;
            -h|--help) sed -n '2,10p' "${SCRIPT}" | sed 's/^# \{0,1\}//' ; exit 0 ;;
            *) die "unknown option: ${arg} (see --help)" ;;
        esac
    done
}

# env_value FILE KEY: prints the value of KEY=value in FILE (empty when absent). Never print the result for secrets.
env_value() {
    [ -f "$1" ] || return 0
    awk -v k="$2" 'index($0, k "=") == 1 { print substr($0, length(k) + 2); exit }' "$1"
}

conf_get() { env_value "${WIZARD_CONF}" "$1"; }

# stored_or BACKEND KEY FALLBACK: a value saved by an earlier run for BACKEND, else FALLBACK.
stored_or() {
    local value=""
    if [ "$(conf_get MEMORY_BACKEND)" = "$1" ]; then value="$(conf_get "$2")"; fi
    printf '%s\n' "${value:-$3}"
}

ensure_hs_dir() {
    if dry; then return 0; fi
    mkdir -p "${HS_DIR}"
    chmod 700 "${HS_DIR}"
}

# fetch URL: body on success, nothing on failure (never fatal).
fetch() { curl -fsS -m 5 "$1" 2>/dev/null || true; }

# list_names: model ids or names from an OpenAI (/v1/models) or Ollama (/api/tags) JSON body on stdin.
list_names() {
    grep -o -E '"(id|name)" *: *"[^"]*"' | sed -E 's/.*: *"([^"]*)"$/\1/' || true
}

show_models() {
    if [ -n "$1" ]; then printf '%s\n' "$1" | sed 's/^/      /'; fi
}

# ollama_bind_ok: Ollama listens on the Docker bridge gateway or on a wildcard, so the litellm container can reach it.
ollama_bind_ok() {
    command -v ss >/dev/null 2>&1 || return 0
    local listing gateway
    gateway="$(docker network inspect bridge -f '{{(index .IPAM.Config 0).Gateway}}' 2>/dev/null || true)"
    gateway="${gateway:-172.17.0.1}"
    listing="$(ss -ltn 2>/dev/null | awk '{print $4}')"
    grep -q -E "^(\*|0\.0\.0\.0|\[::\]|${gateway//./\.}):11434$" <<<"${listing}"
}

port_free() { ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

# choose_port VAR LABEL PORT: sets VAR to PORT when free or held by this project; otherwise offers the next free port.
choose_port() {
    local var="$1" label="$2" port="$3" owner="" alt="" i
    if port_free "${port}"; then
        ok "${label} port ${port} is free"
    else
        owner="$(docker ps --filter "publish=${port}" --format '{{.Label "com.docker.compose.project"}}' 2>/dev/null | awk 'NR == 1' || true)"
        if [ "${owner}" = "${PROJECT}" ]; then
            ok "${label} port ${port} is held by this project (${PROJECT})"
        else
            if [ -n "${owner}" ]; then
                warn "${label} port ${port} is held by compose project '${owner}'"
            else
                warn "${label} port ${port} is held by another process"
            fi
            for i in $(seq 1 50); do
                if port_free $((port + i)); then alt=$((port + i)); break; fi
            done
            [ -n "${alt}" ] || die "no free port near ${port}; set HINDSIGHT_PORT or HINDSIGHT_CP_PORT and rerun"
            if confirm "Use port ${alt} for the ${label} instead (saved to ${REPO}/.env)?" y; then
                port="${alt}"
            else
                die "free port ${port} (or set HINDSIGHT_PORT / HINDSIGHT_CP_PORT) and rerun ./setup"
            fi
        fi
    fi
    printf -v "${var}" '%s' "${port}"
}

# resolve_ports: API and control-plane ports from the environment, else the repo .env, else 8888/9999.
resolve_ports() {
    local api cp
    api="${HINDSIGHT_PORT:-$(env_value "${REPO}/.env" HINDSIGHT_PORT)}"
    cp="${HINDSIGHT_CP_PORT:-$(env_value "${REPO}/.env" HINDSIGHT_CP_PORT)}"
    api="${api:-8888}"
    cp="${cp:-9999}"
    [[ "${api}" =~ ^[0-9]+$ && "${cp}" =~ ^[0-9]+$ ]] || die "HINDSIGHT_PORT and HINDSIGHT_CP_PORT must be port numbers"
    choose_port PORT_API "Hindsight API" "${api}"
    choose_port PORT_CP "control plane" "${cp}"
    export HINDSIGHT_PORT="${PORT_API}" HINDSIGHT_CP_PORT="${PORT_CP}"
    HINDSIGHT_URL="http://127.0.0.1:${PORT_API}"
}

check_preflight() {
    step "1. Preflight"
    local tool ver
    for tool in git curl docker; do
        command -v "${tool}" >/dev/null 2>&1 || die "${tool} not found on PATH"
    done
    if ! docker info >/dev/null 2>&1; then
        die "docker is not usable by $(id -un). Fix: sudo usermod -aG docker $(id -un), then log out and back in"
    fi
    ver="$(docker compose version 2>/dev/null | sed -n 's/.*version v\{0,1\}\([0-9][0-9]*\)\..*/\1/p' || true)"
    [ "${ver:-0}" -ge 2 ] || die "Docker Compose v2 is required (docker compose version). Install the compose plugin"
    ok "docker and compose v${ver} work without sudo; git and curl present"
    ok "host UID:GID is $(id -u):$(id -g)"
    resolve_ports
}

ollama_warn_bind() {
    warn "Ollama listens on loopback only, so the litellm container cannot reach it."
    info "Fix: set OLLAMA_HOST=<docker bridge gateway, usually 172.17.0.1>:11434 for the Ollama service, then restart it."
    info "     Find the gateway: docker network inspect bridge -f '{{(index .IPAM.Config 0).Gateway}}'. See README, Prerequisites."
}

choose_lemond() {
    local default_model
    API_BASE="http://host.docker.internal:13305/v1"
    default_model="$(stored_or lemond MEMORY_MODEL "${LEMOND_DEFAULT_MODEL}")"
    if [ -z "${LEMOND_JSON}" ]; then
        warn "lemond is not answering on ${LEMOND_BASE}; the model list is unavailable"
    elif ! grep -qx "${LEMOND_DEFAULT_MODEL}" <<<"${LEMOND_NAMES}"; then
        warn "${LEMOND_DEFAULT_MODEL} is not listed by lemond"
    fi
    ask MODEL "lemond model id" "${default_model}"
    ask_reflect_model
    pull_lemond_models
}

# lemond_downloaded_names: ids lemond reports as downloaded (show_all lists registry entries with a flag).
lemond_downloaded_names() {
    fetch "${LEMOND_BASE}/api/v1/models?show_all=true" | python3 -I -c 'import json,sys
for m in json.load(sys.stdin).get("data", []):
    if m.get("downloaded"): print(m.get("id", ""))' 2>/dev/null || true
}

# pull_lemond_models: pulls each distinct model the LiteLLM config for this run names (openai/ prefix stripped)
# that lemond has not downloaded. Exact name match; a pull runs only for a missing model.
pull_lemond_models() {
    local name downloaded
    if [ -z "${LEMOND_JSON}" ]; then return 0; fi
    downloaded="$(lemond_downloaded_names)"
    while IFS= read -r name; do
        [ -n "${name}" ] || continue
        if grep -Fqx "${name}" <<<"${downloaded}"; then continue; fi
        warn "${name} is not downloaded in lemond"
        if confirm "Run lemonade pull ${name} now?" y; then
            if command -v lemonade >/dev/null 2>&1; then
                act "lemonade pull ${name}" lemonade pull "${name}"
            else
                warn "lemonade is not on PATH: run 'lemonade pull ${name}' on this host"
            fi
        fi
    done < <(litellm_config | sed -n 's|^ *model: openai/||p' | sort -u)
}

choose_ollama() {
    local default_model
    API_BASE="http://host.docker.internal:11434"
    default_model="$(stored_or ollama MEMORY_MODEL "${OLLAMA_DEFAULT_MODEL}")"
    if [ -z "${OLLAMA_JSON}" ]; then
        warn "Ollama is not answering on ${OLLAMA_BASE}"
    elif ! ollama_bind_ok; then
        ollama_warn_bind
    fi
    ask MODEL "Ollama model" "${default_model}"
    ask_reflect_model
    pull_ollama_models
}

# ask_reflect_model: a separate reflect model, or "shipped" for the shipped route. Blank keeps the saved answer.
ask_reflect_model() {
    local answer
    ask answer "Separate reflect model (type shipped for the shipped reflect route)" \
        "${PM_REFLECT_MODEL:-$(stored_or "${BACKEND}" MEMORY_REFLECT_MODEL "")}"
    case "${answer}" in
        ""|shipped) REFLECT_MODEL="" ;;
        *) REFLECT_MODEL="${answer}" ;;
    esac
}

# pull_ollama_models: pulls each distinct Ollama model that the LiteLLM config for this run names and that is missing.
pull_ollama_models() {
    local name
    if [ -z "${OLLAMA_JSON}" ]; then return 0; fi
    while IFS= read -r name; do
        [ -n "${name}" ] || continue
        if grep -Fqx "${name}" <<<"${OLLAMA_NAMES}"; then continue; fi
        warn "${name} is not pulled yet"
        if confirm "Run ollama pull ${name} now?" y; then
            if command -v ollama >/dev/null 2>&1; then
                act "ollama pull ${name}" ollama pull "${name}"
            else
                warn "ollama is not on PATH: run 'ollama pull ${name}' on this host"
            fi
        fi
    done < <(litellm_config | sed -n 's|^ *model: ollama_chat/||p' | sort -u)
}

choose_custom() {
    local default_base default_model
    default_base="$(stored_or custom MEMORY_API_BASE "${CUSTOM_DEFAULT_BASE}")"
    default_model="$(stored_or custom MEMORY_MODEL "${LEMOND_DEFAULT_MODEL}")"
    info "The litellm container calls this URL. Host services use host.docker.internal."
    ask API_BASE "OpenAI-compatible base URL" "${default_base}"
    ask MODEL "Model id the server serves" "${default_model}"
}

# render_route ALIAS LITELLM_MODEL: one model_list entry with thinking off.
render_route() {
    printf '  - model_name: %s\n    litellm_params:\n      model: %s\n      api_base: %s\n' "$1" "$2" "${API_BASE}"
    if [ "${BACKEND}" = ollama ]; then
        printf '      extra_body:\n        think: false\n'
    else
        printf '      api_key: os.environ/LEMOND_API_KEY\n      extra_body:\n        chat_template_kwargs:\n          enable_thinking: false\n'
    fi
}

# render_override LITELLM_MODEL: the complete per-machine LiteLLM config.
render_override() {
    printf '%s\n' \
        "# Written by ./setup (scripts/wizard.sh). Replaces config/litellm.*.yaml while this file exists." \
        "# Delete it, or rerun ./setup with the shipped model, to use the shipped routes again." \
        "# Thinking is off for all three aliases. Non-ollama servers get chat_template_kwargs; a server that rejects it needs a different route." \
        "model_list:"
    render_route memory-retain "$1"
    render_route memory-reflect "$1"
    render_route memory-consolidate "$1"
    printf '%s\n' "general_settings:" "  master_key: os.environ/LITELLM_MASTER_KEY"
}

# render_shipped LITELLM_MODEL REFLECT_LITELLM_MODEL: config/litellm.BACKEND.yaml with the chosen URL and models.
# Retain and consolidate take LITELLM_MODEL. Reflect keeps its shipped model unless REFLECT_LITELLM_MODEL is set.
render_shipped() {
    local src="${REPO}/config/litellm.${BACKEND}.yaml"
    printf '%s\n' "# Written by ./setup from config/litellm.${BACKEND}.yaml. Replaces the shipped routes while this file exists." \
        "# Delete it, or rerun ./setup with the shipped models, to use the shipped routes again."
    awk -v base="${API_BASE}" -v model="$1" -v reflect="$2" '
        /^  - model_name: / { name = $3 }
        /^      api_base: /  { print "      api_base: " base; next }
        /^      model: /     {
            if (name != "memory-reflect") { print "      model: " model }
            else if (reflect != "") { print "      model: " reflect }
            else { print }
            next
        }
        { print }
    ' "${src}"
}

# litellm_config: the LiteLLM YAML this run serves, on stdout.
litellm_config() {
    local prefix="openai/" reflect=""
    if [ "${BACKEND}" = ollama ]; then prefix="ollama_chat/"; fi
    if [ "${BACKEND}" = custom ]; then
        render_override "${prefix}${MODEL}"
        return 0
    fi
    if [ -n "${REFLECT_MODEL}" ]; then reflect="${prefix}${REFLECT_MODEL}"; fi
    render_shipped "${prefix}${MODEL}" "${reflect}"
}

write_override() {
    local tmp
    if dry; then
        info "[dry-run] write ${LITELLM_OVERRIDE} from config/litellm.${BACKEND}.yaml: retain and consolidate -> ${MODEL}, reflect -> ${REFLECT_MODEL:-shipped}, at ${API_BASE}"
        return 0
    fi
    ensure_hs_dir
    tmp="$(mktemp "${HS_DIR}/.litellm.yaml.XXXXXX")"
    litellm_config > "${tmp}"
    chmod 644 "${tmp}"
    if [ -f "${LITELLM_OVERRIDE}" ]; then
        if cmp -s "${tmp}" "${LITELLM_OVERRIDE}"; then
            rm -f "${tmp}"
            ok "${LITELLM_OVERRIDE} already has this route"
            return 0
        fi
        if ! confirm "Replace ${LITELLM_OVERRIDE} (the old file is kept as .bak)?" y; then
            rm -f "${tmp}"
            warn "kept the existing override; it still takes precedence"
            return 0
        fi
        cp -p "${LITELLM_OVERRIDE}" "${LITELLM_OVERRIDE}.bak-$(date +%Y%m%d%H%M%S)"
    fi
    mv "${tmp}" "${LITELLM_OVERRIDE}"
    ok "wrote ${LITELLM_OVERRIDE}"
}

remove_override_if_asked() {
    if [ ! -f "${LITELLM_OVERRIDE}" ]; then return 0; fi
    if dry; then
        info "[dry-run] move ${LITELLM_OVERRIDE} aside so the shipped ${BACKEND} routes apply"
        return 0
    fi
    if ! confirm "Move ${LITELLM_OVERRIDE} aside so the shipped ${BACKEND} routes apply?" y; then
        warn "kept the override; it still takes precedence over the shipped routes"
        return 0
    fi
    mv "${LITELLM_OVERRIDE}" "${LITELLM_OVERRIDE}.bak-$(date +%Y%m%d%H%M%S)"
    ok "moved the override aside"
}

# apply_route: a non-default model or a custom URL needs an override; the shipped default needs none.
apply_route() {
    local shipped=""
    case "${BACKEND}" in
        lemond) shipped="${LEMOND_DEFAULT_MODEL}" ;;
        ollama) shipped="${OLLAMA_DEFAULT_MODEL}" ;;
    esac
    if [ "${BACKEND}" != custom ] && [ "${MODEL}" = "${shipped}" ] && [ -z "${REFLECT_MODEL}" ]; then
        remove_override_if_asked
    else
        write_override
    fi
}

save_conf() {
    if dry; then
        info "[dry-run] record backend ${BACKEND} in ${WIZARD_CONF}"
        return 0
    fi
    ensure_hs_dir
    printf 'MEMORY_BACKEND=%s\nMEMORY_MODEL=%s\nMEMORY_API_BASE=%s\nMEMORY_REFLECT_MODEL=%s\n' "${BACKEND}" "${MODEL}" "${API_BASE}" "${REFLECT_MODEL}" > "${WIZARD_CONF}"
    chmod 644 "${WIZARD_CONF}"
}

choose_backend() {
    step "2. Model backend"
    local default_num=1 choice
    LEMOND_JSON="$(fetch "${LEMOND_BASE}/v1/models")"
    OLLAMA_JSON="$(fetch "${OLLAMA_BASE}/api/tags")"
    LEMOND_NAMES="$(list_names <<<"${LEMOND_JSON}")"
    OLLAMA_NAMES="$(list_names <<<"${OLLAMA_JSON}")"
    if [ -n "${LEMOND_JSON}" ]; then
        ok "lemond answers on ${LEMOND_BASE}"
        show_models "${LEMOND_NAMES}"
    else
        info "lemond: not answering on ${LEMOND_BASE}"
    fi
    if [ -n "${OLLAMA_JSON}" ]; then
        ok "Ollama answers on ${OLLAMA_BASE}"
        show_models "${OLLAMA_NAMES}"
    else
        info "Ollama: not answering on ${OLLAMA_BASE}"
    fi
    case "$(conf_get MEMORY_BACKEND)" in
        lemond) default_num=1 ;;
        ollama) default_num=2 ;;
        custom) default_num=3 ;;
    esac
    case "${PM_BACKEND:-}" in
        "") ;;
        lemond) default_num=1 ;;
        ollama) default_num=2 ;;
        custom) default_num=3 ;;
        *) die "PM_BACKEND must be lemond, ollama or custom" ;;
    esac

    info "1) lemond   2) ollama   3) custom OpenAI-compatible URL"
    ask choice "Model backend (1-3)" "${default_num}"
    case "${choice}" in
        1) BACKEND=lemond; choose_lemond ;;
        2) BACKEND=ollama; choose_ollama ;;
        3) BACKEND=custom; choose_custom ;;
        *) die "choose 1, 2 or 3" ;;
    esac
    ok "backend ${BACKEND}, model ${MODEL}"
    apply_route
    save_conf
}

# run_setup_sh: scripts/setup.sh writes .env (HOST_UID, HOST_GID, LITELLM_CONFIG), litellm.env and the indexer masks.
run_setup_sh() {
    local backend="${BACKEND}"
    # A custom override wins inside setup.sh; it still needs one of its valid backend names.
    if [ "${backend}" = custom ]; then backend=lemond; fi
    act "scripts/setup.sh: write .env, litellm.env (mode 600 when new), compose.override.yaml" \
        env MEMORY_BACKEND="${backend}" bash "${REPO}/scripts/setup.sh"
}

llm_wired() {
    [ "$(env_value "${ENV_FILE}" HINDSIGHT_API_LLM_BASE_URL)" = "http://litellm:4000/v1" ] || return 1
    local key master
    key="$(env_value "${ENV_FILE}" HINDSIGHT_API_LLM_API_KEY)"
    master="$(env_value "${LITELLM_ENV}" LITELLM_MASTER_KEY)"
    [ -n "${key}" ] && [ "${key}" = "${master}" ]
}

setup_env() {
    step "3. Secrets and env"
    ensure_hs_dir
    # The indexer mounts its state volume under $HOME, which compose binds read-only. Docker cannot create that mount point, so make it here.
    local state_dir="${HOME}/.cache/hindsight-project-index"
    if [ -d "${state_dir}" ]; then
        ok "kept ${state_dir} (indexer state mount point)"
    elif dry; then
        info "[dry-run] create ${state_dir} (indexer state mount point)"
    else
        mkdir -p "${state_dir}"
        ok "created ${state_dir} (indexer state mount point)"
    fi
    if [ -f "${ENV_FILE}" ]; then
        ok "kept ${ENV_FILE}"
    elif dry; then
        info "[dry-run] create ${ENV_FILE} from config/hindsight.env.example (mode 600)"
    else
        install -m 600 "${REPO}/config/hindsight.env.example" "${ENV_FILE}"
        ok "created ${ENV_FILE} (mode 600)"
    fi
    run_setup_sh
    if dry; then
        info "[dry-run] run setup.sh --migrate-env unless ${ENV_FILE} already uses the LiteLLM proxy and master key"
    elif llm_wired; then
        ok "Hindsight calls the LiteLLM proxy with the master key"
    elif confirm "Point ${ENV_FILE} at the LiteLLM proxy now (backs up the file, prints no values)?" y; then
        bash "${REPO}/scripts/setup.sh" --migrate-env
    else
        warn "Hindsight is not wired to the LiteLLM proxy; the stack will not work until you migrate"
    fi
}

# index_roots: roots from the index file (or the shipped default, ~), absolute.
index_roots() {
    local source="${INDEX_FILE}" path
    [ -f "${source}" ] || source="${REPO}/config/index.yml"
    awk '/^ *- path:/ { sub(/^ *- path: */, ""); gsub(/"/, ""); print }' "${source}" | while IFS= read -r path; do
        printf '%s\n' "${path/#\~/${HOME}}"
    done
}

# find_vaults ROOT DEPTH: Obsidian vault folders (parents of .obsidian/) within DEPTH levels of ROOT.
find_vaults() {
    find "$1" -maxdepth "$(( $2 + 1 ))" -type d -name .obsidian -prune 2>/dev/null | sed 's|/\.obsidian$||' || true
}

# yaml_list KEY CSV: a YAML list from comma-separated input, or KEY: [].
yaml_list() {
    local items
    items="$(tr ',' '\n' <<<"$2" | sed 's/^ *//; s/ *$//' | grep -v '^$' || true)"
    if [ -z "${items}" ]; then
        printf '%s: []\n' "$1"
        return 0
    fi
    printf '%s:\n' "$1"
    printf '%s\n' "${items}" | sed 's/^/  - "/; s/$/"/'
}

# render_index ROOT DEPTH REPOS_CSV EXCLUDE_CSV: the per-machine index.yml.
render_index() {
    printf '%s\n' "# Written by ./setup (scripts/wizard.sh). Replaces config/index.yml on this machine." \
        "# Keys omitted here take built-in values; see README \"Source config: index.yml\"." \
        "roots:" \
        "  - path: \"$1\"" \
        "    depth: $2"
    yaml_list repos "$3"
    printf '%s\n' "vaults:" "  auto: true" "  paths: []"
    yaml_list exclude "$4"
}

# build_dockerfile SVC: the Dockerfile for a service the wizard builds, relative to REPO.
build_dockerfile() {
    case "$1" in
        indexer) printf 'indexer/Dockerfile\n' ;;
        *) die "the wizard does not build service $1" ;;
    esac
}

# build_inputs SVC: every file the image build reads, relative to REPO: its Dockerfile, compose.yaml
# (build args and context), and each COPY source (directories expanded to their files).
build_inputs() {
    local df src path
    df="$(build_dockerfile "$1")"
    printf '%s\n' "${df}" compose.yaml
    mapfile -t srcs < <(awk '/^COPY[[:space:]]/ { n = 0; for (i = 2; i <= NF; i++) if ($i !~ /^--/) a[++n] = $i; for (i = 1; i < n; i++) print a[i] }' "${REPO}/${df}")
    for src in "${srcs[@]}"; do
        for path in ${REPO}/${src}; do
            if [ -d "${path}" ]; then
                (cd "${REPO}" && find "${path#"${REPO}/"}" -type f)
            else
                printf '%s\n' "${path#"${REPO}/"}"
            fi
        done
    done
}

# build_hash SVC: sha256 over the content of every build input. A missing input fails the build check.
build_hash() {
    local files
    mapfile -t files < <(build_inputs "$1" | sort -u)
    (cd "${REPO}" && sha256sum -- "${files[@]}") | sha256sum | cut -d' ' -f1
}

# record_build_hash SVC HASH: replace the service's line in BUILD_HASH_FILE.
record_build_hash() {
    local svc="$1" hash="$2" tmp
    tmp="$(mktemp "${BUILD_HASH_FILE}.XXXXXX")"
    if [ -f "${BUILD_HASH_FILE}" ]; then awk -v s="${svc}" '$1 != s' "${BUILD_HASH_FILE}" > "${tmp}"; fi
    printf '%s %s\n' "${svc}" "${hash}" >> "${tmp}"
    mv "${tmp}" "${BUILD_HASH_FILE}"
}

# build_service SVC IMAGE: build only when the inputs changed, the image is missing, or --rebuild is set.
build_service() {
    local svc="$1" image="$2" hash stored=""
    hash="$(build_hash "${svc}")"
    if [ -f "${BUILD_HASH_FILE}" ]; then
        stored="$(awk -v s="${svc}" '$1 == s { print $2 }' "${BUILD_HASH_FILE}")"
    fi
    if [ "${REBUILD}" -eq 0 ] && [ "${stored}" = "${hash}" ] && docker image inspect "${image}" >/dev/null 2>&1; then
        ok "${svc} image unchanged; build skipped"
        return 0
    fi
    act "build the ${svc} image (compose project ${PROJECT})" docker compose -p "${PROJECT}" build "${svc}"
    if dry; then return 0; fi
    record_build_hash "${svc}" "${hash}"
}

configure_index() {
    step "4. Sources to index"
    local root depth repos_csv excludes_csv tmp vault listing count
    if [ -f "${INDEX_FILE}" ]; then
        info "found ${INDEX_FILE}"
        if ! confirm "Replace it with new answers?" n; then
            ok "kept ${INDEX_FILE}"
            return 0
        fi
    fi
    ask root "Root folder to scan for git repositories" "~"
    ask depth "Depth below the root" "3"
    ask repos_csv "Extra repository paths, comma-separated (empty for none)" ""
    ask excludes_csv "Exclude glob patterns on absolute paths, comma-separated (empty for none)" ""

    if dry; then
        info "[dry-run] look for Obsidian vaults under ${root}, validate the config, then write ${INDEX_FILE}"
        return 0
    fi
    local expanded="${root/#\~/${HOME}}"
    vault="$(find_vaults "${expanded}" "${depth}")"
    if [ -n "${vault}" ]; then
        info "Obsidian vaults found (auto-discovered):"
        printf '%s\n' "${vault}" | sed 's/^/    /'
    else
        info "no Obsidian vaults found under ${root} within depth ${depth}"
    fi

    tmp="$(mktemp)"
    render_index "${root}" "${depth}" "${repos_csv}" "${excludes_csv}" > "${tmp}"
    build_service indexer personal-memory-indexer:local
    # The indexer validates the file with its own loader; --list fails on a bad config and prints the selection.
    listing="$(docker compose -p "${PROJECT}" run --rm --no-deps -T -v "${tmp}:/tmp/wizard-index.yml:ro" \
        indexer hindsight-project-index --config /tmp/wizard-index.yml --list)" \
        || { rm -f "${tmp}"; die "the indexer rejected the config (message above)"; }
    count="$(grep -c -E $'^(repo|vault)\t' <<<"${listing}" || true)"
    info "the indexer selects ${count} source(s):"
    printf '%s\n' "${listing}" | sed -n '1,40p' | sed 's/^/    /'
    if ! confirm "Write this config to ${INDEX_FILE}?" y; then
        rm -f "${tmp}"
        warn "not written"
        return 0
    fi
    ensure_hs_dir
    if [ -f "${INDEX_FILE}" ]; then cp -p "${INDEX_FILE}" "${INDEX_FILE}.bak-$(date +%Y%m%d%H%M%S)"; fi
    install -m 644 "${tmp}" "${INDEX_FILE}"
    rm -f "${tmp}"
    ok "wrote ${INDEX_FILE}"
}

enable_notebooklm() {
    ensure_hs_dir
    if [ -f "${NOTEBOOK_FILE}" ]; then
        if grep -q '^enabled:' "${NOTEBOOK_FILE}"; then
            sed -i 's/^enabled:.*/enabled: true/' "${NOTEBOOK_FILE}"
        else
            printf 'enabled: true\n' >> "${NOTEBOOK_FILE}"
        fi
    else
        printf '# Per-machine overrides (changed keys only); see config/notebooklm.yml.\nenabled: true\n' > "${NOTEBOOK_FILE}"
    fi
    ok "enabled in ${NOTEBOOK_FILE}; start with: docker compose -p ${PROJECT} --profile notebooklm up -d notebooklm"
}

setup_notebooklm() {
    step "5. NotebookLM sync (optional, default no)"
    if ! confirm "Enable the NotebookLM sync? It stores a Google session cookie on this machine" n; then
        info "skipped; the service stays off"
        return 0
    fi
    cat <<EOF
  Login steps (run on the host, once; README "NotebookLM"):
    mkdir -p ~/.config/notebooklm
    uv tool install '${NOTEBOOKLM_PKG}'
    NOTEBOOKLM_HOME=~/.config/notebooklm notebooklm login
    NOTEBOOKLM_HOME=~/.config/notebooklm notebooklm auth check --test --json
EOF
    if dry; then
        info "[dry-run] after login: run auth check, then enable notebooklm.yml only if it passes"
        return 0
    fi
    if ! confirm "Login is done; run the auth check now?" n; then
        info "later: rerun ./setup after the login steps"
        return 0
    fi
    if ! command -v notebooklm >/dev/null 2>&1; then
        warn "notebooklm is not on PATH; finish the install step first"
        return 0
    fi
    if NOTEBOOKLM_HOME="${HOME}/.config/notebooklm" notebooklm auth check --test --json >/dev/null 2>&1; then
        enable_notebooklm
    else
        warn "auth check failed; ${NOTEBOOK_FILE} is unchanged. Log in again and rerun ./setup"
    fi
}

wait_health() {
    local i
    if dry; then
        info "[dry-run] wait for ${HINDSIGHT_URL}/health"
        return 0
    fi
    for i in $(seq 1 90); do
        if curl -fsS -m 5 "${HINDSIGHT_URL}/health" >/dev/null 2>&1; then
            ok "Hindsight is healthy at ${HINDSIGHT_URL}"
            return 0
        fi
        sleep 4
    done
    die "Hindsight is not healthy after about 6 minutes: docker compose -p ${PROJECT} logs hindsight"
}

delete_smoke_bank() {
    curl -fsS -m 60 -X DELETE "${HINDSIGHT_URL}/v1/default/banks/${SMOKE_BANK}" >/dev/null 2>&1 \
        || warn "could not delete bank ${SMOKE_BANK}"
}

smoke_test() {
    local base="${HINDSIGHT_URL}/v1/default/banks/${SMOKE_BANK}" recall=""
    if dry; then
        info "[dry-run] retain and recall one fact in bank ${SMOKE_BANK}, then delete the bank"
        return 0
    fi
    info "smoke test: retain and recall in bank ${SMOKE_BANK}"
    if ! curl -fsS -m 600 -X POST "${base}/memories" -H 'Content-Type: application/json' \
        -d '{"items":[{"content":"Wizard smoke test: the project codename is heron."}],"async":false}' >/dev/null; then
        delete_smoke_bank
        die "retain failed: docker compose -p ${PROJECT} logs hindsight litellm"
    fi
    recall="$(curl -fsS -m 300 -X POST "${base}/memories/recall" -H 'Content-Type: application/json' \
        -d '{"query":"What is the project codename?"}' || true)"
    delete_smoke_bank
    if ! grep -qi 'heron' <<<"${recall}"; then
        die "recall did not return the smoke fact; check the model route (docker compose -p ${PROJECT} logs litellm)"
    fi
    ok "retain and recall worked; bank ${SMOKE_BANK} deleted"
}

start_stack() {
    step "6. Start the stack"
    run_setup_sh
    build_service indexer personal-memory-indexer:local
    act "docker compose -p ${PROJECT} up -d --no-build" docker compose -p "${PROJECT}" up -d --no-build
    wait_health
    if [ "${SMOKE}" -eq 1 ]; then smoke_test; else info "smoke test skipped (--no-smoke)"; fi
}

link_agent_config() {
    local target="${REPO}/config/coding-agent.json"
    if [ -L "${AGENT_JSON}" ] && [ "$(readlink -f "${AGENT_JSON}")" = "$(readlink -f "${target}")" ]; then
        ok "${AGENT_JSON} links to config/coding-agent.json"
    elif [ -f "${AGENT_JSON}" ] && [ ! -L "${AGENT_JSON}" ]; then
        warn "${AGENT_JSON} is a regular file"
        if confirm "Replace it with a symlink to config/coding-agent.json (the old file is kept as .bak)?" n; then
            if dry; then info "[dry-run] replace ${AGENT_JSON} with a symlink"; return 0; fi
            mv "${AGENT_JSON}" "${AGENT_JSON}.bak-$(date +%Y%m%d%H%M%S)"
            ln -s "${target}" "${AGENT_JSON}"
            ok "linked ${AGENT_JSON}"
        fi
    elif [ -L "${AGENT_JSON}" ]; then
        warn "${AGENT_JSON} links to $(readlink "${AGENT_JSON}")"
        if confirm "Repoint it to config/coding-agent.json?" n; then
            if dry; then info "[dry-run] repoint ${AGENT_JSON}"; return 0; fi
            rm -f "${AGENT_JSON}"
            ln -s "${target}" "${AGENT_JSON}"
            ok "linked ${AGENT_JSON}"
        fi
    else
        if dry; then
            info "[dry-run] link ${AGENT_JSON} -> ${target}"
        else
            mkdir -p "$(dirname "${AGENT_JSON}")"
            ln -s "${target}" "${AGENT_JSON}"
            ok "linked ${AGENT_JSON} -> ${target}"
        fi
    fi
}

# check_opt_in: every indexed root must sit under optInPaths in config/coding-agent.json.
check_opt_in() {
    local target="${REPO}/config/coding-agent.json" code missing
    local -a roots=()
    mapfile -t roots < <(index_roots)
    code='
import json, os, sys
cfg = json.load(open(sys.argv[1]))
opt = [os.path.abspath(os.path.expanduser(p)) for p in cfg.get("optInPaths", [])]
for root in sys.argv[2:]:
    root = os.path.abspath(os.path.expanduser(root))
    if not any(root == p or root.startswith(p.rstrip("/") + "/") for p in opt):
        print(root)
'
    missing="$(python3 -I -c "${code}" "${target}" "${roots[@]}")"
    if [ -z "${missing}" ]; then
        ok "optInPaths in config/coding-agent.json covers the indexed roots"
        return 0
    fi
    local -a missing_list=()
    mapfile -t missing_list <<<"${missing}"
    warn "optInPaths does not cover:"
    printf '    %s\n' "${missing_list[@]}"
    if dry; then
        info "[dry-run] offer to add these to optInPaths in config/coding-agent.json"
        return 0
    fi
    if confirm "Add them to optInPaths in the tracked file config/coding-agent.json (shows in git status)?" n; then
        python3 -I -c '
import json, sys
path = sys.argv[1]
with open(path) as handle:
    cfg = json.load(handle)
opt = cfg.setdefault("optInPaths", [])
for root in sys.argv[2:]:
    if root not in opt:
        opt.append(root)
with open(path, "w") as handle:
    json.dump(cfg, handle, indent=2)
    handle.write("\n")
' "${target}" "${missing_list[@]}"
        ok "updated ${target}"
    fi
}

setup_coding_agents() {
    step "7. Coding-agent plugin (optional)"
    local -a agents=()
    local name
    for name in claude codex opencode; do
        if command -v "${name}" >/dev/null 2>&1; then agents+=("${name}"); fi
    done
    if [ "${#agents[@]}" -eq 0 ]; then
        info "no claude, codex or opencode on PATH: plugin skipped"
    else
        info "detected: ${agents[*]}"
        if confirm "Install the Hindsight plugin for them now (npx)?" n; then
            act "npx --yes @vectorize-io/hindsight-coding-agents install ${agents[*]}" \
                npx --yes @vectorize-io/hindsight-coding-agents install "${agents[@]}"
        else
            info "skipped; later: npx --yes @vectorize-io/hindsight-coding-agents install ${agents[*]}"
        fi
    fi
    link_agent_config
    check_opt_in
}

summary() {
    step "8. Summary"
    info "Running (compose project ${PROJECT}):"
    info "  Hindsight API      ${HINDSIGHT_URL}  (docs: ${HINDSIGHT_URL}/docs)"
    info "  control plane      http://127.0.0.1:${PORT_CP}"
    info "  model              ${BACKEND}, ${MODEL} via the LiteLLM proxy (internal network)"
    info "Config files:"
    info "  ${ENV_FILE}"
    if [ -f "${LITELLM_OVERRIDE}" ]; then
        info "  ${LITELLM_OVERRIDE} (model routes; replaces config/litellm.*.yaml)"
    elif [ "${BACKEND}" = custom ]; then
        info "  ${LITELLM_OVERRIDE} (missing: custom backend needs it)"
    else
        info "  config/litellm.${BACKEND}.yaml (shipped routes)"
    fi
    if [ -f "${INDEX_FILE}" ]; then info "  ${INDEX_FILE} (sources)"; else info "  config/index.yml (shipped sources)"; fi
    [ -f "${NOTEBOOK_FILE}" ] && info "  ${NOTEBOOK_FILE} (NotebookLM)"
    info "  ${WIZARD_CONF} (this wizard's backend choice)"
    info "Change later: rerun ./setup. For a route edit, run: docker compose -p ${PROJECT} up -d litellm"
    info "Logs:  docker compose -p ${PROJECT} logs -f indexer    (or: hindsight, litellm)"
    info "Stop:  docker compose -p ${PROJECT} down              (keeps the memory database)"
    info "Reset: docker compose -p ${PROJECT} down -v           (deletes the memory database)"
}

# snapshot: one sorted "path sha256" line per managed config file and "container ID" per running container.
# main diffs the snapshots taken before and after a run to count what changed.
snapshot() {
    local f
    {
        for f in "${HS_DIR}"/* "${REPO}/.env" "${REPO}/compose.override.yaml"; do
            if [ -f "${f}" ]; then printf '%s %s\n' "${f}" "$(sha256sum "${f}" | cut -d' ' -f1)"; fi
        done
        docker compose -p "${PROJECT}" ps -q 2>/dev/null | sed 's/^/container /' || true
    } | sort
}

main() {
    local before after changed
    parse_args "$@"
    before="$(snapshot)"
    if dry; then info "dry run: no files are written and no containers start"; fi
    check_preflight
    choose_backend
    setup_env
    configure_index
    setup_notebooklm
    start_stack
    setup_coding_agents
    summary
    after="$(snapshot)"
    changed="$(comm -13 <(printf '%s\n' "${before}") <(printf '%s\n' "${after}") | grep -c . || true)"
    printf 'wizard: changed=%s\n' "${changed}"
}

main "$@"
