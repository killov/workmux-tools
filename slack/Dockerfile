# WorkMux plugin: Slack Web API behind a streamable HTTP MCP endpoint (nothing to download besides npm packages).
FROM node:22-bookworm-slim

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates tini; \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server.mjs ./

RUN mkdir -p /work && chown node:node /work
ENV NODE_ENV=production \
    PORT=8080
USER node
WORKDIR /work
EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

# tini forwards SIGTERM to node (-s: also when it is not PID 1).
ENTRYPOINT ["/usr/bin/tini", "-s", "--"]
CMD ["node", "/app/server.mjs"]
