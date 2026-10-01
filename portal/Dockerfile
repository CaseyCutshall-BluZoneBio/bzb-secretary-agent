# Sarah portal. Build from the repo root:
#   docker build -f portal/Dockerfile -t sarah-portal .
FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY portal/package.json portal/package.json
RUN npm ci --omit=dev --workspace portal --include-workspace-root=false && npm cache clean --force
COPY portal/ portal/
WORKDIR /app/portal
USER node
# 3000 = public UI (published on 127.0.0.1 only, served by Tailscale Funnel)
# 3001 = internal broker (compose network only; never publish it)
EXPOSE 3000 3001
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3001/internal/v1/health >/dev/null || exit 1
CMD ["node", "src/server.js"]
