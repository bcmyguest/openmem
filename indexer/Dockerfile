# Project indexer: one pass at startup, then re-index each source after it stops changing.
FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Tree-sitter grammars are prefetched here, so the runtime never downloads and can run with no network and a
# read-only $HOME. The directory is world-readable because the container runs as the host UID.
ENV TREE_SITTER_GRAMMAR_DIR=/opt/tree-sitter-grammars
RUN pip install --no-cache-dir watchfiles==1.3.0 pyyaml==6.0.3 tree-sitter-language-pack==1.22.1 \
    && python3 -c "import os; from tree_sitter_language_pack import PackConfig, download, init; \
init(PackConfig(cache_dir=os.environ['TREE_SITTER_GRAMMAR_DIR'])); \
download(['python', 'javascript', 'typescript', 'tsx', 'go', 'rust', 'java', 'c', 'cpp', 'csharp', 'ruby', 'lua', 'bash', 'php'])" \
    && chmod -R a+rX /opt/tree-sitter-grammars

# The compose user is the host's UID/GID, which may have no passwd entry here. Trust every repository owner, since
# the indexer only reads them and the owner is the host user.
RUN git config --system safe.directory '*'

COPY bin/hindsight-project-index /usr/local/bin/hindsight-project-index
COPY indexer/watch.py indexer/index_config.py indexer/code_outline.py indexer/feed_sync.py /opt/indexer/
# Memory sinks (one module per provider). A new indexer/sinks/<name>.py needs no Dockerfile edit.
COPY indexer/sinks/ /opt/indexer/sinks/
# Shipped default config. index_config.py finds it at ../config/index.yml relative to itself.
COPY config/index.yml /opt/config/index.yml
RUN chmod 0755 /usr/local/bin/hindsight-project-index /opt/indexer/watch.py \
    && chmod -R a+rX /opt/indexer

# $HOME is bind-mounted, so ignore the host's ~/.local site-packages (they would shadow the pinned packages).
# PYTHONPATH makes index_config, code_outline and the sinks package importable from both the indexer script and
# watch.py.
ENV PYTHONUNBUFFERED=1 \
    PYTHONNOUSERSITE=1 \
    PYTHONPATH=/opt/indexer \
    HINDSIGHT_URL=http://hindsight:8888

CMD ["python3", "/opt/indexer/watch.py"]
