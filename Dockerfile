# incident-copilot API (live mode, shadow only; the optional code fixer opens a draft pull request only after a human
# approval). Node strips TypeScript types natively, so no build step and no TypeScript at runtime. The War Room (web/)
# is not part of this image.
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

# Code fixer (spec 009, decision 22), as system packages rather than npm dependencies:
# - git: GitCliWorkspace shallow-fetches the allowlisted repository and builds the patch from the staged work tree;
# - util-linux: provides /usr/bin/unshare, which gives each sandboxed test run its own empty network namespace
#   (codeFix.sandbox.network: isolated). Without a working unshare the startup self-test fails and the fixer stays off.
# - ca-certificates: git verifies https with the system CA bundle (Node ships its own, so the slim image has none), and
#   --no-install-recommends drops it from git's recommends.
# --no-install-recommends keeps the image small; the apt lists are removed in the same layer.
RUN apt-get update && apt-get install -y --no-install-recommends git util-linux ca-certificates && rm -rf /var/lib/apt/lists/*

# /data/code-fix is the fixer's scratch area (TMPDIR below): one ic-fix-* directory per attempt, removed when the
# attempt ends. It lives outside /app, so the sandbox's read grants never cover the copilot's own source or config.
# A named volume gets it from the image only when the volume is new; on a volume created by 0.4, create it once
# (docs/code-fixer.md, "Docker").
RUN mkdir -p /data/code-fix /config && chown node:node /data /data/code-fix
USER node

# HOST 0.0.0.0 is not loopback, so the server refuses to start without API_TOKEN (assertApiExposureSafe).
# A public hostname in the Host header must be listed in ALLOWED_HOSTS, or requests get 421.
ENV HOST=0.0.0.0 \
    PORT=3000 \
    DB_PATH=/data/incident-copilot.db \
    COPILOT_CONFIG=/config/copilot.yaml \
    TMPDIR=/data/code-fix

VOLUME /data
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

CMD ["node", "src/index.ts"]
