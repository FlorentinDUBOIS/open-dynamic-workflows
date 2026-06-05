# Production image for the odw daemon.
# Multi-stage: install with dev deps pruned, run as non-root.

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/daemon/package.json packages/daemon/
RUN npm ci --omit=dev --workspaces --include-workspace-root

FROM node:22-slim AS runtime
ENV NODE_ENV=production
RUN groupadd -r odw && useradd -r -g odw -m odw
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY packages/core ./packages/core
COPY packages/daemon ./packages/daemon
USER odw
ENV ODW_HOME=/home/odw/.odw
EXPOSE 7345
# Foreground mode inside containers (no detached spawn).
CMD ["node", "packages/daemon/src/cli.js", "start", "--foreground", "--host", "0.0.0.0"]
