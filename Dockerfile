FROM node:22-bookworm-slim AS dependencies
WORKDIR /build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-bookworm-slim AS server
ENV NODE_ENV=production DATA_DIR=/var/lib/private-tunnel SQLITE_PATH=/var/lib/private-tunnel/tunnel.db \
    INTERNAL_HOST=127.0.0.1 AUTO_FIREWALL=false DB_PROVIDER=sqlite
WORKDIR /app
COPY --from=dependencies --chown=node:node /build/node_modules ./node_modules
COPY --chown=node:node package.json LICENSE ./
COPY --chown=node:node server ./server
COPY --chown=node:node shared ./shared
COPY --chown=node:node deploy/healthcheck.js ./deploy/healthcheck.js
RUN mkdir -p /var/lib/private-tunnel && chown node:node /var/lib/private-tunnel
USER node
VOLUME ["/var/lib/private-tunnel"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["node", "deploy/healthcheck.js"]
CMD ["node", "server/index.js"]
