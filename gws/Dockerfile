# WorkMux tool: Google Workspace CLI (gws) behind a streamable HTTP MCP endpoint.

# --- Stage 1: fetch the gws release binary (static musl build) and verify its checksum ---------
FROM debian:bookworm-slim AS gws
ARG GWS_VERSION=0.22.5
# SHA256 of google-workspace-cli-<arch>-unknown-linux-musl.tar.gz (the release's .sha256 files)
ARG GWS_SHA256_X86_64=4db473dde4b1ab872e4ff35d769b0d4af1f1a6441a605e79d5cf8ada9c87e920
ARG GWS_SHA256_AARCH64=e700fe63524932b10ec2130b47ece90aa850e66005fe52ccfc4cf8767bf9919a
ARG TARGETARCH
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl; \
    case "${TARGETARCH:-$(dpkg --print-architecture)}" in \
      amd64) arch=x86_64;  sha="$GWS_SHA256_X86_64" ;; \
      arm64) arch=aarch64; sha="$GWS_SHA256_AARCH64" ;; \
      *) echo "unsupported architecture ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    f="google-workspace-cli-${arch}-unknown-linux-musl.tar.gz"; \
    curl -fsSL -o "/tmp/$f" "https://github.com/googleworkspace/cli/releases/download/v${GWS_VERSION}/$f"; \
    echo "${sha}  /tmp/$f" | sha256sum -c -; \
    mkdir -p /out/bin /out/doc; \
    tar -xzf "/tmp/$f" -C /out/doc; \
    mv /out/doc/gws /out/bin/gws; \
    chmod 0755 /out/bin/gws; \
    /out/bin/gws --version

# --- Stage 2: runtime ---------------------------------------------------------------------------
FROM node:22-bookworm-slim

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates tini; \
    rm -rf /var/lib/apt/lists/*

COPY --from=gws /out/bin/gws /usr/local/bin/gws
COPY --from=gws /out/doc /usr/share/doc/gws

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server.mjs ./

RUN mkdir -p /work && chown node:node /work
ENV NODE_ENV=production \
    WORK_DIR=/work \
    PORT=8080 \
    GWS_BIN=/usr/local/bin/gws
USER node
WORKDIR /work
EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

# tini forwards SIGTERM to node and reaps gws children (-s: also when it is not PID 1).
ENTRYPOINT ["/usr/bin/tini", "-s", "--"]
CMD ["node", "/app/server.mjs"]
