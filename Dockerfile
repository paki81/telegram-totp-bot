FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .
RUN mkdir -p /app/data && chown -R node:node /app/data

USER node
EXPOSE 8788
VOLUME ["/app/data"]

CMD ["node", "index.js"]
