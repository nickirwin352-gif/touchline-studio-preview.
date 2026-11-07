FROM node:22-bookworm-slim

# Video exports and optional authorised Veo imports use local binaries.
# GPU/large AI models are intentionally NOT included in this first cloud release.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates ffmpeg python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/yt-dlp \
    && /opt/yt-dlp/bin/pip install --no-cache-dir yt-dlp \
    && ln -s /opt/yt-dlp/bin/yt-dlp /usr/local/bin/yt-dlp

WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run build && npm test
ENV NODE_ENV=production
EXPOSE 10000
CMD ["npm", "start"]
