FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps
COPY . .
RUN npm run typecheck
RUN npm run build:web

FROM build AS production-dependencies
RUN npm prune --omit=dev --legacy-peer-deps && npm cache clean --force

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/server ./server
COPY --from=build /app/client ./client
COPY --from=build /app/config ./config
COPY --from=build /app/contracts ./contracts
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/dist/web ./dist/web
RUN npm run runtime:verify
USER node
EXPOSE 4020 4402
CMD ["npm", "run", "server"]
