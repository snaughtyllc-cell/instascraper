FROM node:20-slim

WORKDIR /app

# Install server deps
COPY server/package*.json ./server/
RUN cd server && npm ci --omit=dev

# Install client deps + build
COPY client/package*.json ./client/
RUN cd client && npm install --legacy-peer-deps
COPY client/ ./client/
RUN cd client && npm run build

# Copy server code
COPY server/ ./server/

# Copy root files
COPY .env.example ./

EXPOSE 4000
ENV NODE_ENV=production
ENV PORT=4000

CMD ["node", "server/index.js"]
