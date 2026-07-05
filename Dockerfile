# percollate + Chromium. percollate's puppeteer downloads a matching Chromium at
# npm-install time; we install the shared libraries Chromium needs at runtime.
FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates fonts-liberation fonts-noto-color-emoji \
      libasound2 libatk-bridge2.0-0 libatk1.0-0 libcairo2 libcups2 \
      libdbus-1-3 libexpat1 libfontconfig1 libgbm1 libglib2.0-0 libgtk-3-0 \
      libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcomposite1 libxdamage1 \
      libxext6 libxfixes3 libxrandr2 libxkbcommon0 libxshmfence1 xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# Install percollate globally; its puppeteer postinstall fetches Chromium.
RUN npm install -g percollate@^4

WORKDIR /app
COPY container/server.mjs ./server.mjs

EXPOSE 8080
CMD ["node", "server.mjs"]
