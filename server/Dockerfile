# Sienna dashboard server (Node 22, ESM).
FROM node:22-alpine

WORKDIR /app

# Media tools for the agent's play_audio_file / play_youtube speaker tools.
# ffmpeg decodes/resamples to 16 kHz mono; yt-dlp pulls YouTube audio.
RUN apk add --no-cache ffmpeg yt-dlp

# Install production deps first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source (see .dockerignore for what's excluded — node_modules, .env,
# recordings, certs, tests).
COPY . .

# Recordings persist on a mounted volume (see docker-compose.yml).
ENV RECORDINGS_DIR=/data/recordings

EXPOSE 3387

# Config comes from the container environment (docker-compose env_file +
# environment), NOT a bundled .env — so run node directly, not `npm start`
# (which uses --env-file=.env).
CMD ["node", "index.js"]
