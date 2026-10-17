# Project indexer: one pass at startup, then re-index each source after it stops changing.
FROM python:3.12-slim

ARG CODEGRAPH_VERSION=v1.6.2
# Pinned digests of the release tarballs for CODEGRAPH_VERSION. Update both when bumping the version.
ARG CODEGRAPH_SHA256_X64=ef0af416092128fb1ccc723786000b7edf4a6971fe604acd08bf966e4f37b828
ARG CODEGRAPH_SHA256_ARM64=c8c6be292be21d00dea26bad8b28d434731cf612fb8cc475dc10f5b3038b5b64
ARG TARGETARCH=amd64

# CodeGraph ships as a self-contained bundle with its own Node runtime, so no Node install is needed.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    case "${TARGETARCH}" in \
        amd64) arch=x64; pinned="${CODEGRAPH_SHA256_X64}" ;; \
        arm64) arch=arm64; pinned="${CODEGRAPH_SHA256_ARM64}" ;; \
        *) echo "no codegraph bundle for ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    asset="codegraph-linux-${arch}.tar.gz"; \
    base="https://github.com/colbymchenry/codegraph/releases/download/${CODEGRAPH_VERSION}"; \
    work="$(mktemp -d)"; \
    cd "${work}"; \
    curl -fsSLO "${base}/${asset}"; \
    curl -fsSLO "${base}/SHA256SUMS"; \
    echo "${pinned}  ${asset}" | sha256sum -c -; \
    grep " ${asset}\$" SHA256SUMS | sha256sum -c -; \
    tar -xzf "${asset}" -C /opt; \
    ln -s "/opt/codegraph-linux-${arch}/bin/codegraph" /usr/local/bin/codegraph; \
    cd /; \
    rm -rf "${work}"

RUN pip install --no-cache-dir watchfiles==1.3.0

COPY bin/hindsight-project-index /usr/local/bin/hindsight-project-index
COPY indexer/watch.py /opt/indexer/watch.py
RUN chmod 0755 /usr/local/bin/hindsight-project-index /opt/indexer/watch.py

# $HOME is bind-mounted, so ignore the host's ~/.local site-packages (they would shadow the pinned watchfiles).
ENV PYTHONUNBUFFERED=1 \
    PYTHONNOUSERSITE=1 \
    HINDSIGHT_URL=http://hindsight:8888

CMD ["python3", "/opt/indexer/watch.py"]
