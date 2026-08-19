# percollate + Chromium. percollate's puppeteer downloads a matching Chromium at
# npm-install time; we install the shared libraries Chromium needs at runtime.
FROM node:24-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates fonts-liberation fonts-noto-color-emoji \
      libasound2 libatk-bridge2.0-0 libatk1.0-0 libcairo2 libcups2 \
      libdbus-1-3 libexpat1 libfontconfig1 libgbm1 libglib2.0-0 libgtk-3-0 \
      libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcomposite1 libxdamage1 \
      libxext6 libxfixes3 libxrandr2 libxkbcommon0 libxshmfence1 xdg-utils \
      tini \
    && rm -rf /var/lib/apt/lists/*

# Install percollate globally (pinned for reproducible image builds); its
# puppeteer postinstall fetches Chromium.
RUN npm install -g percollate@4.3.0

WORKDIR /app
# server.mjs is the deployed converter; mhtml.mjs + convert-mhtml.mjs power the
# local ./mhtml2epub wrapper (tests stay out of the image).
COPY container/server.mjs container/mhtml.mjs container/convert-mhtml.mjs ./

EXPOSE 8080

# Run tini as PID 1, not node. The Container runtime sleeps us with SIGTERM
# (@cloudflare/containers stop() -> container.signal(SIGTERM)); the Linux kernel
# does NOT apply the default "terminate on SIGTERM" action to PID 1, so a bare
# `node` as PID 1 ignores it, never stops, and the Durable Object alarm loop
# keeps re-firing (billing wall time + memory) forever. tini as PID 1 forwards
# the signal to node (which, no longer PID 1, gets the normal terminate default)
# and reaps orphaned Chromium subprocesses that percollate/puppeteer spawn.
ENTRYPOINT ["tini", "--"]
CMD ["node", "server.mjs"]
