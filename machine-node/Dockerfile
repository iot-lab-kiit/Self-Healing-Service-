FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src

ENV NODE_ENV=production \
    PORT=3000 \
    CONTAINER_MEM_LIMIT_MB=256 \
    SIMULATE_GPU=true

EXPOSE 3000

HEALTHCHECK --interval=2s --timeout=2s --start-period=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health >/dev/null 2>&1 || exit 1

# --expose-gc lets /fault/reset hand freed buffers back to the OS immediately
CMD ["node", "--expose-gc", "src/index.js"]
