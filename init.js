// InnerGame CRM bootstrap — initializes Supabase + Sentry before app.js runs.
// Kept as a separate file (not inline) so our CSP can drop 'unsafe-inline' for scripts.

const SUPABASE_URL = 'https://gdtiqxqtfyefsqhofili.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_ILSvvQ9CdTdezM1-yRaSMQ_QSzWgyb8';
const _sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Initialize Sentry as early as possible so bootstrap errors are captured
if (window.Sentry) {
  Sentry.init({
    dsn: 'https://02b1e3829d72893309f490b800233dec@o4511252877148160.ingest.us.sentry.io/4511252884619264',
    release: 'innergame-crm@' + (document.documentElement.dataset.build || 'unknown'),
    environment: (location.hostname === 'crm.myinnergame.com' ? 'production' : 'dev'),
    // Keep the sample rate low on free tier (5k events/mo)
    sampleRate: 1.0,
    tracesSampleRate: 0.0, // no performance tracing for now
    // Don't send requests from localhost to avoid burning quota during dev
    beforeSend(event) {
      if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') return null;
      return event;
    },
    // Ignore noisy errors
    ignoreErrors: [
      'ResizeObserver loop limit exceeded',
      'ResizeObserver loop completed with undelivered notifications',
      'Non-Error promise rejection captured',
    ],
  });
}
