# GENERATED from craft-common/Dockerfile.in by craft-common/sync.mjs — do not edit, change craft.json and run the sync.
# WorkMux plugin: CADCraft headless (cadcraft-cli mcp) behind a streamable HTTP MCP endpoint.

# --- Stage 1: fetch cadcraft-cli from the pinned GitHub release, verify it, build the meminfo shim -
FROM debian:bookworm-slim AS craft
ARG APP=cadcraft
ARG REPO=storytold/cadcraft
ARG VERSION=0.20.1
# SHA256 of <app>-<version>-linux-<arch>.deb, from the release's SHA256SUMS.txt
ARG SHA256_X86_64=8e6ad1f487d6cd44dbcb73cd88ef1efb52252a2071094f2c23a468a641a06faa
ARG SHA256_AARCH64=ef72fd132dd5a8b49e186c2be57807a99e93df4b43496148752ce7c50a71bcad
ARG TARGETARCH
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl gcc libc6-dev; \
    case "${TARGETARCH:-$(dpkg --print-architecture)}" in \
      amd64) arch=x86_64;  sha="$SHA256_X86_64" ;; \
      arm64) arch=aarch64; sha="$SHA256_AARCH64" ;; \
      *) echo "unsupported architecture ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/app.deb \
      "https://github.com/${REPO}/releases/download/v${VERSION}/${APP}-${VERSION}-linux-${arch}.deb"; \
    echo "${sha}  /tmp/app.deb" | sha256sum -c -; \
    # Only the headless CLI is needed, not the desktop app and its X/Wayland/GPU libraries.
    mkdir -p /out; \
    dpkg-deb --fsys-tarfile /tmp/app.deb | tar -x -C /out "./usr/bin/${APP}-cli" "./usr/share/doc/${APP}"; \
    "/out/usr/bin/${APP}-cli" --version
COPY meminfo.c /tmp/
RUN mkdir -p /out/usr/lib && gcc -O2 -Wall -shared -fPIC -o /out/usr/lib/craft-meminfo.so /tmp/meminfo.c -ldl

# --- Stage 2: runtime ---------------------------------------------------------------------------
FROM node:22-bookworm-slim

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends tini; \
    rm -rf /var/lib/apt/lists/*

# The CLI, its licence files (/usr/bin/<app>-cli, /usr/share/doc/<app>) and the MemTotal shim (see meminfo.c).
COPY --from=craft /out/usr/ /usr/
RUN echo /usr/lib/craft-meminfo.so > /etc/ld.so.preload

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server.mjs craft.json ./

RUN mkdir -p /work && chown node:node /work
ENV NODE_ENV=production \
    WORK_DIR=/work \
    PORT=8080
USER node
WORKDIR /work
EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

# tini forwards SIGTERM to node and reaps the <app>-cli children (-s: also when it is not PID 1).
ENTRYPOINT ["/usr/bin/tini", "-s", "--"]
CMD ["node", "/app/server.mjs"]
