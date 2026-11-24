# WorkMux plugin: SolidCraft headless CAD (solidcraft-cli mcp) behind a streamable HTTP MCP endpoint.

# --- Stage 1: fetch solidcraft-cli from the pinned GitHub release and verify its checksum ---------
FROM debian:bookworm-slim AS solidcraft
ARG SOLIDCRAFT_VERSION=0.46.2
# SHA256 of solidcraft-<version>-linux-<arch>.deb, from the release's SHA256SUMS.txt
ARG SOLIDCRAFT_SHA256_X86_64=31cb4bde0a77035553806cbacf99879f4b561e450ccca7cd8545a48465742507
ARG SOLIDCRAFT_SHA256_AARCH64=ac9305927fd52940b3f5f409d61699860075c037c131b59fdf9f9690a0273ef7
ARG TARGETARCH
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl; \
    case "${TARGETARCH:-$(dpkg --print-architecture)}" in \
      amd64) arch=x86_64;  sha="$SOLIDCRAFT_SHA256_X86_64" ;; \
      arm64) arch=aarch64; sha="$SOLIDCRAFT_SHA256_AARCH64" ;; \
      *) echo "unsupported architecture ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/solidcraft.deb \
      "https://github.com/tangency-labs/solidcraft/releases/download/v${SOLIDCRAFT_VERSION}/solidcraft-${SOLIDCRAFT_VERSION}-linux-${arch}.deb"; \
    echo "${sha}  /tmp/solidcraft.deb" | sha256sum -c -; \
    # Only the headless CLI is needed: it links nothing but libc, unlike the desktop app.
    mkdir -p /out; \
    dpkg-deb --fsys-tarfile /tmp/solidcraft.deb | tar -x -C /out ./usr/bin/solidcraft-cli ./usr/share/doc/solidcraft; \
    /out/usr/bin/solidcraft-cli --version

# --- Stage 2: runtime ---------------------------------------------------------------------------
FROM node:22-bookworm-slim

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends fonts-dejavu-core tini; \
    rm -rf /var/lib/apt/lists/*

COPY --from=solidcraft /out/usr/bin/solidcraft-cli /usr/bin/solidcraft-cli
COPY --from=solidcraft /out/usr/share/doc/solidcraft /usr/share/doc/solidcraft

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server.mjs ./

RUN mkdir -p /work && chown node:node /work
ENV NODE_ENV=production \
    WORK_DIR=/work \
    PORT=8080 \
    SOLIDCRAFT_CLI=/usr/bin/solidcraft-cli \
    SOLIDCRAFT_GPU=cpu
USER node
WORKDIR /work
EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

# tini forwards SIGTERM to node and reaps the solidcraft-cli children (-s: also when it is not PID 1).
ENTRYPOINT ["/usr/bin/tini", "-s", "--"]
CMD ["node", "/app/server.mjs"]
