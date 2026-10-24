FROM node:22.23.4-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV CI=true
# Chrome takes its UI language, navigator.languages and Accept-Language
# ("en-US,en;q=0.9") from LANG.
ENV LANG=en_US.UTF-8

# Xvfb gives headed Chrome a display (headed has none of headless mode's
# tells); tini reaps Chrome's children and forwards signals. The fonts make
# text rendering, and so canvas/font fingerprints, look like an ordinary
# Linux desktop instead of a bare container.
# hadolint ignore=DL3008
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    xvfb xauth tini fonts-liberation fonts-dejavu-core fonts-noto-color-emoji \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@11.4.0 --activate

WORKDIR /usr/src/app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

ENV PLAYWRIGHT_BROWSERS_PATH=/usr/local/share/playwright

# Google Chrome stable rather than Playwright's Chromium build: the browser
# real visitors run, with the matching UA, client hints and codecs. It lands
# in /opt/google/chrome. amd64 only.
RUN pnpm exec patchright install --with-deps chrome \
  && rm -rf /var/lib/apt/lists/*

COPY tsconfig.json api.ts ./
COPY helpers ./helpers
RUN pnpm run build && pnpm prune --prod

COPY --chmod=0755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN chown -R node:node /usr/src/app

ARG PORT=3000
ENV PORT=${PORT}

EXPOSE ${PORT}

# The image's node user, numerically so runAsNonRoot can verify it.
USER 1000:1000

ENTRYPOINT ["tini", "--", "docker-entrypoint.sh"]
CMD ["node", "dist/api.js"]
