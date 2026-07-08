// Sentry initialization. Required as the VERY FIRST line of index.js so the SDK
// can instrument http/express before those modules load.
//
// Completely INERT unless SENTRY_DSN is set: with no DSN, Sentry.init is never
// called, so nothing is patched, captured, or sent. That makes it safe to ship
// before the DSN exists — flip it on later by adding SENTRY_DSN to the env.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Sentry = require('@sentry/node');

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'production',
    // Errors only for now — no performance-tracing overhead. Raise this later if
    // you want latency/transaction data.
    tracesSampleRate: 0,
  });
}

module.exports = Sentry;
