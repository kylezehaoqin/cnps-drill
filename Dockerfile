FROM node:22-alpine
WORKDIR /app
COPY server.js ./
COPY scripts ./scripts
COPY public ./public
COPY data/taxa.json ./data/taxa.json
ENV PORT=8080 DATA_DIR=/app/data
EXPOSE 8080
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=4s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8080/api/cache-status >/dev/null || exit 1
CMD ["node", "server.js"]
