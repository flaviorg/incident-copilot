# incident-copilot API (live mode, shadow only). Node strips TypeScript types natively, so no build step and no
# TypeScript at runtime. The War Room (web/) is not part of this image.
# Base image tag matches the local `node --version` (24.21.0); check that it exists on Docker Hub before building.
FROM node:24.21.0-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY data ./data
COPY fixtures/scenarios ./fixtures/scenarios
COPY fixtures/llm ./fixtures/llm
COPY runbooks ./runbooks

RUN mkdir -p /data /config && chown node:node /data
USER node

# HOST 0.0.0.0 is not loopback, so the server refuses to start without API_TOKEN (assertApiExposureSafe).
# A public hostname in the Host header must be listed in ALLOWED_HOSTS, or requests get 421.
ENV HOST=0.0.0.0 \
    PORT=3000 \
    DB_PATH=/data/incident-copilot.db \
    COPILOT_CONFIG=/config/copilot.yaml

VOLUME /data
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

CMD ["node", "src/index.ts"]
