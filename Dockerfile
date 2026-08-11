# Foundry hosted agents run linux/amd64 only. ARM images are NOT supported, so
# always build with --platform linux/amd64 (see scripts/build.sh) — on an Apple
# Silicon Mac the default build produces an arm64 image that deploys and then
# fails to start.

# ---- build ----------------------------------------------------------------
FROM node:22-slim AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npx tsc -p tsconfig.build.json

# Drop dev dependencies from the tree we copy forward.
RUN npm prune --omit=dev

# ---- runtime --------------------------------------------------------------
FROM node:22-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
# Tells storageRoot() to keep state under $HOME — the path Foundry mounts the
# persisted session volume at. Explicit, rather than probing the filesystem.
ENV RUNNING_IN_CONTAINER=1
# 8088 is the port Foundry containers listen on locally; the gateway routes to it.
ENV PORT=8088

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY public ./public
# bank.json is imported at runtime and is not emitted by tsc.
COPY src/bank/bank.json ./dist/bank/bank.json

# Create the state directory and hand it to `node` BEFORE dropping privileges.
#
# Without this, mounting a volume at this path fails: a fresh Docker volume is
# owned by root:root, the process runs as `node`, and the first write dies with
# EACCES. Pre-creating the directory means the volume inherits its ownership.
#
# Foundry mounts the session volume at $HOME, so this is the path that matters
# there too — the image must be able to write it as an unprivileged user.
RUN mkdir -p /home/node/.agent-state && chown -R node:node /home/node/.agent-state

# Run unprivileged. The node image ships a `node` user.
USER node

EXPOSE 8088

# The platform probes readiness; keep this cheap and dependency-free.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8088/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# entrypoint.ts picks the mode: real provider if one is configured, otherwise the
# offline stub. This is what makes the published image runnable with no API key.
CMD ["node", "dist/entrypoint.js"]
