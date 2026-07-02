FROM node:20-alpine

WORKDIR /app

# Install production deps first for better layer caching.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src

# Ensure the ban-log dir exists and is writable by the non-root user before the volume mounts.
RUN mkdir -p /app/data && chown -R node:node /app/data

# Run as the built-in non-root user.
USER node

CMD ["node", "src/index.js"]
