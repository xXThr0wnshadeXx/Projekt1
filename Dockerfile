# Runtime version matches the locally verified Node baseline. No build secrets.
FROM node:22.19.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY tsconfig*.json vite.config.ts index.html ./
COPY contracts ./contracts
COPY packages ./packages
COPY src ./src
# Both reviewed SQL files are loaded by application startup before listening.
COPY migrations ./migrations
ENV VITE_AUTH_MODE=http
RUN npm run build && npm prune --omit=dev

FROM node:22.19.0-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=10000
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/migrations ./migrations
USER node
EXPOSE 10000
# Infrastructure readiness only; live provider/demo acceptance is a separate gate.
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/ready',{signal:AbortSignal.timeout(2500)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/packages/server/main.js"]
