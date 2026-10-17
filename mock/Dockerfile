# Build context: repo root (npm workspaces share the root lockfile).
FROM node:22-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY mock/package.json mock/
COPY packages/provider-fixtures/ packages/provider-fixtures/
RUN npm ci -w @ploot/mock --include-workspace-root=false
COPY mock/ mock/
RUN npm run build -w @ploot/mock

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /repo
COPY package.json package-lock.json ./
COPY mock/package.json mock/
COPY packages/provider-fixtures/ packages/provider-fixtures/
RUN npm ci -w @ploot/mock --include-workspace-root=false --omit=dev && npm cache clean --force
COPY --from=build /repo/mock/dist mock/dist
USER node
WORKDIR /repo/mock
EXPOSE 4000
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.MOCK_PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
