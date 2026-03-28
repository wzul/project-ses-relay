FROM node:22-alpine

# Install openssl for self-signed certificate generation
RUN apk add --no-cache openssl

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

# Generate self-signed certificate for STARTTLS
RUN mkdir -p /app/certs && \
    openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
    -keyout /app/certs/server.key -out /app/certs/server.crt \
    -subj "/C=US/ST=State/L=City/O=Organization/CN=localhost"

EXPOSE 26 3000

CMD ["npm", "start"]
