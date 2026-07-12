FROM node:20-slim AS client-build

WORKDIR /app

COPY client/package*.json ./client/
ARG REACT_APP_API_URL=
ENV REACT_APP_API_URL=$REACT_APP_API_URL
# Frontend Sentry DSN must be present at BUILD time (CRA inlines REACT_APP_* into
# the bundle). A frontend DSN is public by design — it ships in the client JS and
# can only submit events, not read data — so a build default is safe. Railway's
# REACT_APP_SENTRY_DSN service var overrides this default when passed as a build arg.
ARG REACT_APP_SENTRY_DSN=https://810bdd6f9ed2e50f1b6aada0b09172b8@o4511697475731456.ingest.us.sentry.io/4511697484447744
ENV REACT_APP_SENTRY_DSN=$REACT_APP_SENTRY_DSN
RUN cd client && npm install --legacy-peer-deps
COPY client/ ./client/
RUN cd client && npm run build

FROM node:20-slim

WORKDIR /app

# The runtime image gets only server dependencies and compiled client assets;
# Create React App's legacy build/test toolchain stays in the build stage.
COPY server/package*.json ./server/
RUN cd server && npm install --legacy-peer-deps --omit=dev
COPY server/ ./server/
COPY --from=client-build /app/client/build ./client/build

COPY .env.example ./

EXPOSE 4000
ENV NODE_ENV=production
ENV PORT=4000

CMD ["node", "server/index.js"]
