FROM node:20-alpine

# Install Docker CLI so we can run docker commands inside container if needed
RUN apk add --no-cache docker-cli

WORKDIR /app

# Copy package files first for better layer caching
COPY package*.json ./

# Install production dependencies
RUN npm install --omit=dev

# Copy source
COPY server/ ./server/
COPY client/ ./client/

# Create servers directory
RUN mkdir -p /app/servers

EXPOSE 3000

CMD ["node", "server/index.js"]
