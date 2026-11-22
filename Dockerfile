# syntax=docker/dockerfile:1

# ── Stage 1: install dependencies and compile TypeScript ──
# sharp ships prebuilt libvips for linux/arm64 (glibc), so no build toolchain is needed.
FROM node:26-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ── Stage 2: runtime (compiled JS + production dependencies + schema) ──
FROM node:26-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY database ./database
COPY package.json ./
USER node
CMD ["node", "dist/index.js"]
