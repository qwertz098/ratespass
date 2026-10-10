# Keine Laufzeit-Abhängigkeiten: Node 26 führt TypeScript direkt aus und bringt SQLite (node:sqlite) mit.
FROM node:26-alpine
ENV NODE_ENV=production DATA_DIR=/data PORT=3000
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY tools ./tools
COPY web ./web
COPY batches ./batches
COPY legal ./legal
COPY wordlists ./wordlists
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "server/main.ts"]
