FROM node:24-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine AS selfsigned
RUN apk add --no-cache openssl && mkdir -p /certs && \
    openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
      -keyout /certs/server.key -out /certs/server.crt \
      -subj "/CN=localhost"

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app

RUN addgroup -S app && adduser -S app -G app && mkdir -p /data && chown app:app /data

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=selfsigned --chown=app:app /certs ./certs
COPY public ./public
COPY package.json ./

USER app
EXPOSE 587 3000
CMD ["node", "dist/index.js"]
