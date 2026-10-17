# One-shot setup image: migrate + login roles + seed. Build context: repo root.
FROM node:22-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/db/package.json packages/db/
COPY packages/provider-fixtures/ packages/provider-fixtures/
RUN npm ci -w @ploot/db --include-workspace-root=false
COPY packages/db/ packages/db/
RUN npm run build -w @ploot/db

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/db/package.json packages/db/
COPY packages/provider-fixtures/ packages/provider-fixtures/
RUN npm ci -w @ploot/db --include-workspace-root=false --omit=dev && npm cache clean --force
COPY --from=build /repo/packages/db/dist packages/db/dist
COPY packages/db/migrations packages/db/migrations
USER node
WORKDIR /repo/packages/db
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["setup"]
