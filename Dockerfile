# ScrapperPlaca — API RNP placa->VIN
# Requiere Google Chrome real: el WAF (F5 ASM) del RNP rechaza el
# headless-shell que trae Playwright. Solo amd64 (Chrome no publica .deb arm64).
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends wget gnupg ca-certificates \
    && wget -qO- https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update && apt-get install -y --no-install-recommends google-chrome-stable fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY scraper.js server.js index.js ./
RUN mkdir -p /app/cache && chown -R node:node /app

USER node
ENV NODE_ENV=production HEADLESS=true NO_SANDBOX=true PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
