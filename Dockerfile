# Clipzy production image. Data (SQLite DB, backups, uploads) lives in /data.
# Attach a persistent volume at /data in your host (Railway: Volumes; Fly: [mounts]; docker run -v clipzy:/data).
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data/db \
    UPLOAD_DIR=/data/uploads \
    PORT=4000 \
    TRUST_PROXY=1
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY . .
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["sh", "-c", "node server/scripts/bootstrap.js && node server/index.js"]
