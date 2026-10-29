# Stdio MCP image for Glama introspection / local docker runs.
# Glama's admin Dockerfile form usually generates its own image; keep this
# aligned with: Build steps ["npm ci --omit=dev"] + CMD ["node","cli/openmem-mcp.mjs"]
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY cli ./cli
COPY .agents/skills/openmem ./.agents/skills/openmem
COPY wizard ./wizard
COPY providers ./providers
COPY config ./config
COPY compose.yaml LICENSE README.md ./
USER node
ENTRYPOINT ["node", "cli/openmem-mcp.mjs"]
