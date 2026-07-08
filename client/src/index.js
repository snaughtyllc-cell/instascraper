import React from 'react';
import ReactDOM from 'react-dom/client';
import * as Sentry from '@sentry/react';
import './index.css';
import App from './App';

// Inert unless REACT_APP_SENTRY_DSN is set at build time. CRA inlines
// REACT_APP_* vars during `npm run build`, so set it in the environment that
// builds the client (e.g. Railway) and rebuild to activate.
if (process.env.REACT_APP_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.REACT_APP_SENTRY_DSN,
    environment: process.env.NODE_ENV || 'production',
    tracesSampleRate: 0, // errors only for now
  });
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <Sentry.ErrorBoundary
    fallback={
      <div style={{ padding: 24, color: '#e5e7eb', background: '#0a0a0c', minHeight: '100vh', fontFamily: 'system-ui, sans-serif' }}>
        <h1 style={{ fontSize: 18, marginBottom: 8 }}>Something went wrong.</h1>
        <p style={{ color: '#9ca3af', fontSize: 14 }}>Try reloading the app. If it keeps happening, let us know.</p>
      </div>
    }
  >
    <App />
  </Sentry.ErrorBoundary>
);
