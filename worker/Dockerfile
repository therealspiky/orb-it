# Orb.IT worker: Node 22 + ffmpeg. Runs anywhere a long-lived container can
# (a VPS, Railway, Fly.io, Render, or a Mac for development).
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY tsconfig.json ./
COPY src ./src
USER node
CMD ["npx", "tsx", "src/index.ts"]
