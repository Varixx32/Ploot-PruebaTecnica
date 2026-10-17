# Next.js API + demo UI. Build context: repo root (npm workspaces).
FROM node:22-alpine AS build
WORKDIR /repo
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/provider-fixtures/ packages/provider-fixtures/
COPY packages/db/package.json packages/db/
COPY app/package.json app/
RUN npm ci -w @ploot/app -w @ploot/db --include-workspace-root=false
COPY packages/db/ packages/db/
COPY app/ app/
# prebuild compiles @ploot/db first.
RUN npm run build -w @ploot/app

FROM node:22-alpine AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /srv
# Standalone output mirrors the monorepo layout (traced from the repo root).
COPY --from=build /repo/app/.next/standalone ./
COPY --from=build /repo/app/.next/static ./app/.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "app/server.js"]
