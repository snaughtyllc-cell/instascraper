// Sentry initialization. Required as the VERY FIRST line of index.js so the SDK
// can instrument http/express before those modules load.
//
// Completely INERT unless SENTRY_DSN is set: with no DSN, Sentry.init is never
// called, so nothing is patched, captured, or sent. That makes it safe to ship
// before the DSN exists — flip it on later by adding SENTRY_DSN to the env.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Sentry = require('@sentry/node');

function isReactRenderRequest(value) {
  if (typeof value !== 'string') return false;
  try {
    // Express accepts case-insensitive paths and a trailing slash by default.
    return /^\/film\/v1\/react-render\/?$/i.test(new URL(value, 'http://local').pathname);
  } catch { return false; }
}

function isReactMediaUrl(value) {
  try {
    const url = new URL(value, 'http://local');
    if (/^\/film\/v1\/(react-media|media|thumb)\/[^/]+\/?$/i.test(url.pathname)) return true;
    if (url.hostname === 'api.apify.com'
      || /(^|\.)(instagram\.com|cdninstagram\.com|fbcdn\.net)$/.test(url.hostname)) return true;
    if (url.hostname === 'www.googleapis.com' && url.pathname === '/upload/drive/v3/files') return true;
    return !!process.env.HQ_PUBLIC_URL && url.origin === new URL(process.env.HQ_PUBLIC_URL).origin;
  } catch { return false; }
}

function containsReactSecrets(value, seen = new WeakSet()) {
  if (typeof value === 'string') {
    if (process.env.FILM_SERVICE_KEY && value.includes(process.env.FILM_SERVICE_KEY)) return true;
    if (process.env.APIFY_API_KEY && value.includes(process.env.APIFY_API_KEY)) return true;
    if (process.env.REACT_APIFY_API_KEY && value.includes(process.env.REACT_APIFY_API_KEY)) return true;
    if (/upload_id|["'](?:uploadUrl|rawUrl|callbackUrl)["']\s*:/i.test(value)) return true;
    return (value.match(/https?:\/\/[^\s"'<>\\]+|\/film\/v1\/(?:react-media|media|thumb)\/[^\s"'<>\\]+/gi) || []).some(isReactMediaUrl);
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  return Object.entries(value).some(([key, entry]) =>
    /^(uploadUrl|rawUrl|callbackUrl|upload_id)$/i.test(key) || containsReactSecrets(entry, seen));
}

function filterBreadcrumb(breadcrumb) {
  return containsReactSecrets(breadcrumb) ? null : breadcrumb;
}

function filterEvent(event) {
  const request = event.request;
  const normalized = event.sdkProcessingMetadata?.normalizedRequest;
  if (isReactMediaUrl(request?.url) || isReactMediaUrl(normalized?.url)) return null;
  if (isReactRenderRequest(request?.url) || isReactRenderRequest(normalized?.url)) {
    // Keep the error useful, without attaching the bearer credential, signed
    // source URLs, resumable upload capability, cookies, or arbitrary headers.
    const { sdkProcessingMetadata, ...safeEvent } = event;
    event = { ...safeEvent, request: { method: request?.method || normalized?.method, url: '/film/v1/react-render' } };
  }
  if (event.breadcrumbs) event = { ...event, breadcrumbs: event.breadcrumbs.filter(filterBreadcrumb) };
  return containsReactSecrets(event) ? null : event;
}

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'production',
    // Errors only for now — no performance-tracing overhead. Raise this later if
    // you want latency/transaction data.
    tracesSampleRate: 0,
    integrations: [Sentry.httpIntegration({
      ignoreOutgoingRequests: isReactMediaUrl,
      ignoreIncomingRequestBody: isReactRenderRequest,
    })],
    beforeBreadcrumb: filterBreadcrumb,
    beforeSend: filterEvent,
    beforeSendLog: log => containsReactSecrets(log) ? null : log,
  });
}

module.exports = Sentry;
