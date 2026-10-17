# Long-lived publisher container. Build context: repo root (npm workspaces).
FROM node:22-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/provider-fixtures/ packages/provider-fixtures/
COPY packages/db/package.json packages/db/
COPY worker/package.json worker/
RUN npm ci -w @ploot/worker -w @ploot/db --include-workspace-root=false
COPY packages/db/ packages/db/
COPY worker/ worker/
RUN npm run build -w @ploot/db && npm run build -w @ploot/worker

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/provider-fixtures/ packages/provider-fixtures/
COPY packages/db/package.json packages/db/
COPY worker/package.json worker/
RUN npm ci -w @ploot/worker --include-workspace-root=false --omit=dev && npm cache clean --force
COPY --from=build /repo/packages/db/dist packages/db/dist
COPY --from=build /repo/worker/dist worker/dist
USER node
WORKDIR /repo/worker
EXPOSE 9464
HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.WORKER_HTTP_PORT||9464)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# SIGTERM -> graceful stop (no new claims, finish in-flight posts).
STOPSIGNAL SIGTERM
CMD ["node", "dist/main.js"]
