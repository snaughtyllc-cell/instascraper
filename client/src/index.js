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
    tracesSampleRate: 0, // errors only — no perf tracing
    integrations: [
      Sentry.replayIntegration({
        // Replays include admin pages and private model ideas, so default to the
        // privacy-preserving mode. Error metadata and breadcrumbs still make the
        // session useful without sending captions, ideas, names, or reel media.
        maskAllText: true,
        maskAllInputs: true,
        blockAllMedia: true,
      }),
    ],
    // Always capture the session that hit an error; spot-check ~10% of the rest.
    replaysOnErrorSampleRate: 1.0,
    replaysSessionSampleRate: 0.1,
  });
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <Sentry.ErrorBoundary
    fallback={
      <div style={{ padding: 24, color: '#20211F', background: '#EFEFEB', minHeight: '100vh', fontFamily: 'system-ui, sans-serif', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ width: '100%', maxWidth: 360, padding: 24, background: '#FAFAF7', border: '1px solid #DCDDD7', borderRadius: 8, textAlign: 'center' }}>
          <h1 style={{ fontSize: 18, margin: '0 0 8px', fontWeight: 800 }}>Something went wrong</h1>
          <p style={{ color: '#62645F', fontSize: 14, margin: '0 0 18px' }}>Reload the app to get back to your feed.</p>
          <button type="button" onClick={() => window.location.reload()} style={{ minHeight: 44, padding: '0 20px', border: 0, borderRadius: 8, color: '#fff', background: '#20211F', fontWeight: 700, cursor: 'pointer' }}>
            Reload app
          </button>
        </div>
      </div>
    }
  >
    <App />
  </Sentry.ErrorBoundary>
);
