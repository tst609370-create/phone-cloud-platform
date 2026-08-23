FROM node:18-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    android-tools-adb python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

EXPOSE 8000
CMD ["node", "dist/index.js"]
