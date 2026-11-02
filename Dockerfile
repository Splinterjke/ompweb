# syntax=docker/dockerfile:1
#
# 3-stage image — build in temp, ship only what the runtime needs:
#
#   1. base     — runtime infrastructure (Chrome-for-Testing, .NET, omp, python venv). Never compiles anything.
#   2. builder  — npm ci + the Bun client build (scripts/build-client.ts). DevDeps
#                 and the build cache live ONLY here.
#   3. runtime  — base + the exact files the Bun server (launched by
#                 bin/omp-web.js as `bun /opt/ompweb/server/main.ts`) resolves:
#                 prod node_modules (incl. the `bun` runtime package), the
#                 SOURCE tree it runs (server/, lib/, app/, bin/, vendor/,
#                 proxy.ts, instrumentation.node.ts, tsconfig.json), the built
#                 client (dist/), public/, and package.json.
#
# The builder stage is never copied from as a whole, so its build artifacts
# (devDeps, build caches) are discarded from the final image.
#
# The image is self-contained: a third party can run the UI + JS host daemon
# from /opt/ompweb alone with no host repo bind mounted.

# ── 1. base ───────────────────────────────────────────────────────────────────
FROM node:26-slim AS base

LABEL maintainer="Oh My Pi" \
      description="Docker harness for Oh My Pi coding agent + ompweb" \
      version="0.9"

# build-essential is intentionally absent: the runtime never compiles. node-pty
# ships per-platform prebuilds, and the Bun runtime ships as an npm package.
RUN sed -i 's/^URIs: https/URIs: http/' /etc/apt/sources.list.d/debian.sources 2>/dev/null || true \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git tzdata \
      python3 python3-pip python3-venv ripgrep fd-find wget \
      libglib2.0-0t64 libnss3 libnspr4 libatk1.0-0t64 libatk-bridge2.0-0t64 \
      libcups2t64 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
      libxrandr2 libgbm1 libasound2t64 libpango-1.0-0 libcairo2 \
 && ln -sf /usr/bin/fdfind /usr/local/bin/fd \
 && rm -rf /var/lib/apt/lists/*

# Trust the bundle for Python, Node.js, Bun and OpenSSL
ENV REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt

ENV TZ=Europe/Moscow

RUN python3 -m venv /opt/omp-venv

# Install .NET SDK 7.0
RUN curl -sSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh \
 && chmod +x /tmp/dotnet-install.sh \
 && /tmp/dotnet-install.sh --channel 7.0 --install-dir /usr/share/dotnet \
 && ln -s /usr/share/dotnet/dotnet /usr/bin/dotnet \
 && rm /tmp/dotnet-install.sh

ENV PATH="/opt/omp-venv/bin:/root/.local/bin:/usr/share/dotnet:$PATH"

ENV CHROME_AGENT_VERSION=0.16.0
RUN curl -fsSL https://omp.sh/install | sh -s -- --binary

# Chrome-for-Testing + chrome-agent (base capability for browser automation)
RUN CA_ARCH="$(case "$(uname -m)" in aarch64|arm64) echo linux-arm64 ;; *) echo linux-x64 ;; esac)" \
 && CFT_ARCH="$(case "$(uname -m)" in aarch64|arm64) echo linux-arm64 ;; *) echo linux64 ;; esac)" \
 && CFT_DIR="$(case "$(uname -m)" in aarch64|arm64) echo chrome-linux-arm64 ;; *) echo chrome-linux64 ;; esac)" \
 && mkdir -p /root/.chrome-agent \
 && curl -fsSL -o /root/.chrome-agent/chrome-agent \
      "https://github.com/sderosiaux/chrome-agent/releases/download/v${CHROME_AGENT_VERSION}/chrome-agent-${CA_ARCH}" \
 && chmod +x /root/.chrome-agent/chrome-agent \
 && ln -sf /root/.chrome-agent/chrome-agent /usr/local/bin/chrome-agent \
 && curl -fsSL -o /tmp/cft.zip \
      "https://storage.googleapis.com/chrome-for-testing-public/150.0.7871.24/${CFT_ARCH}/chrome-${CFT_ARCH}.zip" \
 && python3 -c "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" /tmp/cft.zip /root/.chrome-agent \
 && rm -f /tmp/cft.zip \
 && chmod +x "/root/.chrome-agent/${CFT_DIR}/chrome" "/root/.chrome-agent/${CFT_DIR}/chrome-wrapper" \
 && ln -sf "/root/.chrome-agent/${CFT_DIR}/chrome" /usr/local/bin/google-chrome

# patchright — stealth Playwright driver for sites that fingerprint stock
# automation drivers (Google-class walls). Driver-only: it drives the same
# Chrome-for-Testing binary above (executablePath: /usr/local/bin/google-chrome),
# so no browser download happens (PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD). The version
# is pinned by browser-tools/package-lock.json; helpers live in /root/browser-tools.
COPY browser-tools /root/browser-tools
RUN cd /root/browser-tools \
 && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --no-audit --no-fund \
 && node -e "import('patchright').then(m=>process.exit(typeof m.chromium.launch==='function'?0:1))"

COPY entrypoint.sh /usr/local/bin/entrypoint
RUN chmod +x /usr/local/bin/entrypoint

# ── 2. builder ────────────────────────────────────────────────────────────────
# Installs deps, builds the client bundle (scripts/build-client.ts via the
# `bun` npm package) and prunes devDeps. DevDeps and build caches exist only
# here; the final stage copies the pruned node_modules, the source tree and
# the built dist/ — never the build toolchain beyond the runtime bun package.
FROM node:26-slim AS builder

# build-essential is a node-gyp fallback in case a native prebuild is missing
# (node-pty normally ships a prebuild, so this is rarely exercised).
# ca-certificates: outbound HTTPS from the toolchain validates TLS against the
# system bundle, which node:26-slim does not ship.
RUN sed -i 's/^URIs: https/URIs: http/' /etc/apt/sources.list.d/debian.sources 2>/dev/null || true \
 && apt-get update \
 && apt-get install -y --no-install-recommends build-essential python3 curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /src
# .dockerignore excludes node_modules/.next-dev/.git, so this copies the source
# tree (including vendor/vscode-git-graph/types.ts, a runtime import); the
# build below regenerates the rest.
COPY . /src

# Install deps → build the client bundle (dist/) → strip devDeps (build is
# done). The assert guarantees the pruned prod tree still has a loadable
# node-pty native binary, and that the runtime bun + server entry survived.
RUN npm ci \
 && npm run build \
 && npm prune --omit=dev \
 && test -n "$(find node_modules/node-pty -name '*.node' -type f | head -1)" \
 && test -f "$(node -p "require.resolve('bun/package.json')")" \
 && test -f dist/index.html

# ── 3. runtime ────────────────────────────────────────────────────────────────
FROM base

# Only what the launcher (bin/omp-web.js, run from /opt/ompweb) resolves at
# runtime:
#   node_modules  — prod deps incl. `bun` (the launcher spawns
#                   resolveBunBinary() → `bun /opt/ompweb/server/main.ts`)
#   dist/         — the built client bundle (hashed /assets/, index.html)
#   server/ lib/ app/api/ — the SOURCE tree Bun runs (routes import through
#                   the tsconfig `@/*` paths; nothing is pre-compiled)
#   bin/          — launcher + daemon CLI + request-peer.js (loopback/HMAC gate)
#   vendor/       — vendor/vscode-git-graph/types.ts (imported by the git-graph route)
#   public/       — static assets (git-graph webview bundle, icons, service worker)
#   proxy.ts / instrumentation.node.ts — imported by server/app.ts
#   tsconfig.json — the @/* path map Bun resolves at runtime
#   package.json  — launcher version + OMP_WEB_PACKAGE_DIR anchor
# components/, hooks/, templates/, scripts/ are client-build-only or
# desktop-only inputs — the server never reads them at runtime.
# The app lives in /opt/ompweb (the launcher resolves it from __dirname); the
# container's default working directory is /work (the repo bind, or empty).
WORKDIR /work
COPY --from=builder /src/node_modules /opt/ompweb/node_modules
COPY --from=builder /src/dist /opt/ompweb/dist
COPY --from=builder /src/server /opt/ompweb/server
COPY --from=builder /src/lib /opt/ompweb/lib
COPY --from=builder /src/app/api /opt/ompweb/app/api
COPY --from=builder /src/bin /opt/ompweb/bin
COPY --from=builder /src/vendor /opt/ompweb/vendor
COPY --from=builder /src/public /opt/ompweb/public
COPY --from=builder /src/proxy.ts /src/instrumentation.node.ts /src/tsconfig.json /src/package.json /opt/ompweb/

RUN chmod +x /opt/ompweb/bin/omp-web.js /opt/ompweb/bin/omp-web-desktop.js \
 && ln -sf /opt/ompweb/bin/omp-web.js /usr/local/bin/ompweb \
 && ln -sf /opt/ompweb/bin/omp-web-desktop.js /usr/local/bin/ompweb-desktop

ENTRYPOINT ["/usr/local/bin/entrypoint"]
