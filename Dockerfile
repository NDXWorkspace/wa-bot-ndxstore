# ============================================
# WA Bot NDXStore — Multi-Arch Dockerfile
# Supported: linux/amd64, linux/arm64
# Build: docker buildx build --platform linux/amd64,linux/arm64 -t wa-bot .
# ============================================
FROM node:22-bullseye-slim

RUN apt-get update && apt-get install -y \
    wget ca-certificates curl gnupg \
    fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 \
    libcups2 libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 \
    libu2f-udev libvulkan1 libxcomposite1 libxdamage1 libxfixes3 \
    libxkbcommon0 libxrandr2 xdg-utils tini \
    --no-install-recommends \
    && arch=$(uname -m) \
    && if [ "$arch" = "aarch64" ]; then \
         apt-get install -y chromium --no-install-recommends; \
         ln -s /usr/bin/chromium /usr/bin/google-chrome-stable; \
       else \
         wget -q -O /usr/share/keyrings/google-chrome.pub \
           https://dl-ssl.google.com/linux/linux_signing_key.pub; \
         echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.pub] \
           http://dl.google.com/linux/chrome/deb/ stable main" \
           > /etc/apt/sources.list.d/google-chrome.list; \
         apt-get update; \
         apt-get install -y google-chrome-stable --no-install-recommends; \
       fi \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable \
    NODE_ENV=production \
    PORT=3000 \
    NODE_OPTIONS="--max-old-space-size=512"

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY . .

RUN mkdir -p /app/wa-session /app/.wwebjs_cache /app/logs \
    && chown -R node:node /app

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -sf http://127.0.0.1:${PORT:-3000}/health || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "index.js"]
