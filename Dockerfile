# syntax=docker/dockerfile:1

# --- build (always native) ---------------------------------------------------
#
# Pinned to BUILDPLATFORM on purpose. wamock compiles to platform-independent
# JavaScript and its only runtime dependencies (fastify, zod) are pure JS with
# no native bindings — so nothing here needs to run on the target architecture.
#
# Without this pin, a multi-arch build runs `npm ci` and `tsc` again under QEMU
# emulation for arm64. That measured over 19 minutes and produced byte-identical
# output to the native run: entirely wasted work on every release.
FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /app

COPY package*.json ./
# --ignore-scripts: `prepare` runs `npm run build`, and at this layer only
# package*.json exists — tsconfig and src arrive below. Copying them first
# would fix the error and destroy dependency-layer caching, so skip the hook
# instead. We build explicitly a few lines down anyway. Safe because no
# production dependency has install scripts (fastify and zod are pure JS).
RUN npm ci --ignore-scripts

COPY tsconfig*.json ./
COPY src ./src
RUN npm run build

# Production dependency tree, resolved once. Safe to copy across architectures
# precisely because nothing in it is compiled.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# --- runtime (per architecture) ----------------------------------------------
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# Never run as root — this listens on a port and someone will eventually expose
# it further than they meant to.
USER node

EXPOSE 4004

# Readiness without adding curl to the image: the control API answers this.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4004/__mock/state').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "dist/cli.js", "start"]
# --host=0.0.0.0 is required INSIDE a container: the CLI binds loopback by
# default (the control API is unauthenticated), and loopback inside a container
# is unreachable from the host even with -p. The container boundary is what
# makes the wider binding acceptable here.
# Overridable: `docker run wamock --app-secret shhh --webhook-url http://...`
CMD ["--port=4004", "--host=0.0.0.0"]
