# Render environment (PLAN 3 "deterministic render"): same image digest + same audio lock →
# same frames. TTS and alignment are NOT in this image (they need the models and, on macOS, MPS);
# synthesize on the host first, then render here from the audio lock (audio/<lang>/).
#
#   docker build -t script2video-render .
#   docker run --rm -v "$PWD/videos:/videos" -v "$PWD/out:/app/out" \
#     script2video-render render /videos/<id>/script.ko.md --output youtube
#
# The image is for local use only and is not distributed (licenses.md: Debian ffmpeg is GPL).
FROM node:24-bookworm-slim

# ffmpeg for mixing / mastering / concat; the rest are chrome-headless-shell's shared libraries.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates ffmpeg \
      libnss3 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 libgbm1 libasound2 libxrandr2 \
      libxkbcommon0 libxfixes3 libxcomposite1 libxdamage1 libpango-1.0-0 libcairo2 libcups2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN corepack enable
COPY package.json yarn.lock .yarnrc.yml ./
COPY packages/core/package.json packages/core/
COPY packages/renderer-remotion/package.json packages/renderer-remotion/
COPY packages/cli/package.json packages/cli/
RUN yarn install --immutable

COPY tsconfig.base.json models.lock.json fonts.lock.json ./
COPY packages packages
COPY scripts scripts
RUN yarn build

# Everything a render needs is fetched at build time (pinned fonts, Chromium): no network later.
# Remotion keeps its browser under <cwd>/node_modules/.remotion, so fetch it from the WORKDIR.
RUN node -e "import('@remotion/renderer').then((r) => r.ensureBrowser())" \
    && node -e "import('./packages/cli/dist/media.js').then((m) => m.ensureFonts('/app', console.log))"

ENV S2V_GL=swangle
ENTRYPOINT ["node", "/app/packages/cli/dist/main.js"]
