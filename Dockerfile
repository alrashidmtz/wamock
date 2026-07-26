# Build in one stage, ship the compiled output plus production deps only.
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# Never run as root — this listens on a port and someone will eventually
# expose it further than they meant to.
USER node

EXPOSE 4004

ENTRYPOINT ["node", "dist/cli.js", "start"]
# --host=0.0.0.0 is required INSIDE a container: the CLI binds loopback by
# default (the control API is unauthenticated), and loopback inside a container
# is unreachable from the host even with -p. The container boundary is what
# makes the wider binding acceptable here.
# Overridable: `docker run wamock --app-secret shhh --webhook-url http://...`
CMD ["--port=4004", "--host=0.0.0.0"]
