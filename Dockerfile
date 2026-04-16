# =============================================================================
# MI Dev Agent — Multi-stage Docker Build
# =============================================================================
# Stage 1: Rust native addons (NAPI-RS → .node files)
# Stage 2: Node.js / TypeScript build (shared, backend, frontend)
# Stage 3: Minimal runtime image
# =============================================================================

# ---------------------------------------------------------------------------
# Stage 1: Rust build — compile NAPI-RS native addons
# ---------------------------------------------------------------------------
FROM rust:1.77-slim AS rust-builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    python3 \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js (needed for napi-build to generate bindings)
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Copy Rust workspace and all crates
COPY packages/native/ packages/native/

# Build all native crates in release mode
RUN cd packages/native && cargo build --release

# NAPI-RS crates produce .node files in target/release/
# The cdylib outputs: libstate_engine.so, libhttp_engine.so, libsse_engine.so
# We collect them for the runtime stage
RUN mkdir -p /native-out \
    && find packages/native/target/release -maxdepth 1 \
       \( -name "*.node" -o -name "*.so" -o -name "lib*.so" \) \
       -exec cp {} /native-out/ \;

# ---------------------------------------------------------------------------
# Stage 2: Node.js build — compile TypeScript packages + Vite frontend
# ---------------------------------------------------------------------------
FROM node:20-slim AS node-builder

WORKDIR /build

# Copy root workspace config first (for npm ci)
COPY package.json package-lock.json* ./

# Copy all package sources
COPY packages/shared/ packages/shared/
COPY packages/agent/ packages/agent/
COPY packages/backend/ packages/backend/
COPY packages/frontend/ packages/frontend/

# Install all workspace dependencies
RUN npm ci --workspace=packages/shared --workspace=packages/agent --workspace=packages/backend --workspace=packages/frontend

# Build in dependency order: shared -> agent -> frontend & backend
RUN npm run build -w packages/shared
RUN npm run build -w packages/agent
RUN npm run build -w packages/frontend
RUN npm run build -w packages/backend

# ---------------------------------------------------------------------------
# Stage 3: Runtime — minimal production image
# ---------------------------------------------------------------------------
FROM node:20-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy native addons from Rust build
COPY --from=rust-builder /native-out/ packages/native/

# Copy compiled TypeScript/JS from Node build
COPY --from=node-builder /build/packages/backend/dist/ packages/backend/dist/
COPY --from=node-builder /build/packages/shared/dist/ packages/shared/dist/
COPY --from=node-builder /build/packages/agent/dist/ packages/agent/dist/
COPY --from=node-builder /build/packages/frontend/dist/ packages/frontend/dist/

# Copy package.json files for Node module resolution
COPY --from=node-builder /build/package.json ./
COPY --from=node-builder /build/packages/backend/package.json packages/backend/
COPY --from=node-builder /build/packages/shared/package.json packages/shared/
COPY --from=node-builder /build/packages/agent/package.json packages/agent/
COPY --from=node-builder /build/packages/frontend/package.json packages/frontend/

# Install production-only dependencies
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --workspace=packages/backend --workspace=packages/shared --workspace=packages/agent 2>/dev/null || true

# Copy entrypoint
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Create state directory for persistent volumes
RUN mkdir -p /app/state && chown node:node /app/state

# Run as non-root
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:3000/api/health || exit 1

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "packages/backend/dist/server/http-server.js"]
