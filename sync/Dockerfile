# NotebookLM -> Hindsight sync (opt-in compose profile "notebooklm"). No browser: login runs on the host.
FROM python:3.12-slim

# Pinned: the unofficial notebooklm-py client changes without notice. google-auth and requests serve the optional
# enterprise backend only.
RUN pip install --no-cache-dir notebooklm-py==0.8.5 pyyaml==6.0.3 google-auth==2.62.0 requests==2.34.2

COPY sync/notebooklm_sync.py /opt/notebooklm/notebooklm_sync.py
# Shipped default config. The per-machine override is mounted at /etc/notebooklm/override.yml by compose.
COPY config/notebooklm.yml /opt/config/notebooklm.yml
RUN chmod 0755 /opt/notebooklm/notebooklm_sync.py

# The compose user is the host's UID/GID, which has no passwd entry here. HOME must be writable and must not be the
# host's home. The state directory is 0777 so a fresh named volume (which copies the image's mode) is writable.
RUN mkdir -p /data/state /data/notebooklm /tmp/nlm-home && chmod 0777 /data/state /data/notebooklm /tmp/nlm-home
ENV PYTHONUNBUFFERED=1 \
    PYTHONNOUSERSITE=1 \
    HOME=/tmp/nlm-home \
    NOTEBOOKLM_HOME=/data/notebooklm \
    NOTEBOOKLM_STATE=/data/state/state.json \
    HINDSIGHT_URL=http://hindsight:8888

CMD ["python3", "/opt/notebooklm/notebooklm_sync.py"]
