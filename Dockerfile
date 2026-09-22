# syntax=docker/dockerfile:1
#
# 3-stage image — build in temp, ship only what the runtime needs:
#
#   1. base     — runtime infrastructure (Chrome-for-Testing, .NET, omp, python venv). Never compiles anything.
#   2. builder  — npm ci + next build + cargo build + host:stage. DevDeps, the
#                 .next build cache, and the full cargo target/ live ONLY here.
#   3. runtime  — base + the exact files `next start` (launched by bin/omp-web.js
#                 from /opt/ompweb) resolves: prod node_modules, the pruned .next,
#                 bin/, public/, vendor/ (Rust host), and the config files.
#
# The builder stage is never copied from as a whole, so its build artifacts
# (devDeps, .next/cache, crates/target) are discarded from the final image.
#
# The image is self-contained: a third party can run the UI + Rust host from
# /opt/ompweb alone with no host repo bind mounted.

# ── 1. base ───────────────────────────────────────────────────────────────────
FROM node:26-slim AS base

LABEL maintainer="Oh My Pi" \
      description="Docker harness for Oh My Pi coding agent + ompweb" \
      version="0.8"

# build-essential is intentionally absent: the runtime never compiles. node-pty
# ships per-platform prebuilds, and the Rust host is pre-built in the builder.
RUN sed -i 's/^URIs: https/URIs: http/' /etc/apt/sources.list.d/debian.sources 2>/dev/null || true \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git \
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

COPY entrypoint.sh /usr/local/bin/entrypoint
RUN chmod +x /usr/local/bin/entrypoint

# ── 2. builder ────────────────────────────────────────────────────────────────
# Compiles the Next.js app and the Rust host. DevDeps, the .next build cache,
# and the full cargo target/ exist only here; the final stage never copies them.
FROM node:26-slim AS builder

# build-essential is a node-gyp fallback in case a native prebuild is missing
# (node-pty normally ships a prebuild, so this is rarely exercised).
# ca-certificates: curl (rustup install) validates TLS against the system
# bundle, which node:26-slim does not ship.
RUN sed -i 's/^URIs: https/URIs: http/' /etc/apt/sources.list.d/debian.sources 2>/dev/null || true \
 && apt-get update \
 && apt-get install -y --no-install-recommends build-essential python3 curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Rust at the same paths the compose `cargo-cache`/`rustup-cache` volumes warm.
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH
RUN curl -fsSL https://sh.rustup.rs -o /tmp/rustup-init.sh \
 && sh /tmp/rustup-init.sh -y --profile minimal --default-toolchain stable \
 && rm /tmp/rustup-init.sh \
 && ln -sf /usr/local/cargo/bin/cargo /usr/local/bin/cargo \
 && ln -sf /usr/local/cargo/bin/rustc /usr/local/bin/rustc

WORKDIR /src
# .dockerignore excludes node_modules / .next / crates/target / vendor, so this
# copies sources only; the build below regenerates the rest.
COPY . /src

# Install deps → compile Rust host → build the app → stage the host into
# vendor/ → strip devDeps (build is done) → drop build-only .next dirs.
# The two asserts guarantee the pruned prod tree still boots: a loadable
# node-pty native binary and the staged Rust host binary.
RUN npm ci \
 && cargo build --locked --manifest-path crates/Cargo.toml --bin ompweb-host \
 && npm run build \
 && npm run host:stage -- --vendor \
 && npm prune --omit=dev \
 && rm -rf .next/cache .next/dev .next/types .next/standalone .next/diagnostics .next/trace .next/trace-build \
 && test -n "$(find node_modules/node-pty -name '*.node' -type f | head -1)" \
 && test -n "$(find vendor/ompweb-host -name 'ompweb-host' -type f | head -1)"

# ── 3. runtime ────────────────────────────────────────────────────────────────
FROM base

# Only what the launcher (bin/omp-web.js, run from /opt/ompweb) resolves at
# runtime:
#   node_modules  — prod deps incl. `next` (launcher does
#                   require.resolve("next/dist/bin/next") then `next start`)
#   .next         — compiled server/static + BUILD_ID + manifests
#   bin/          — launcher + request-peer-preload.js (loopback/HMAC security gate)
#   public/       — static assets served by Next
#   vendor/       — Rust host: vendor/ompweb-host/<plat>-<arch>/ompweb-host
#   package.json / next.config.ts / tsconfig.json
# instrumentation.ts / proxy.ts are compiled into .next/server; app/, lib/,
# components/, hooks/ source are compiled into .next/server — none are read at
# runtime. templates/ (desktop-only) is dropped.
# The app lives in /opt/ompweb (the launcher resolves it from __dirname); the
# container's default working directory is /work (the repo bind, or empty).
WORKDIR /work
COPY --from=builder /src/node_modules /opt/ompweb/node_modules
COPY --from=builder /src/.next /opt/ompweb/.next
COPY --from=builder /src/bin /opt/ompweb/bin
COPY --from=builder /src/public /opt/ompweb/public
COPY --from=builder /src/vendor /opt/ompweb/vendor
COPY --from=builder /src/package.json /src/next.config.ts /src/tsconfig.json /opt/ompweb/

RUN chmod +x /opt/ompweb/bin/omp-web.js /opt/ompweb/bin/omp-web-desktop.js \
 && ln -sf /opt/ompweb/bin/omp-web.js /usr/local/bin/ompweb \
 && ln -sf /opt/ompweb/bin/omp-web-desktop.js /usr/local/bin/ompweb-desktop

ENTRYPOINT ["/usr/local/bin/entrypoint"]
