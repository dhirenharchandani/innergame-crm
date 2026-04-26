// InnerGame CRM bootstrap — initializes Supabase + Sentry before app.js runs.
// Kept as a separate file (not inline) so our CSP can drop 'unsafe-inline' for scripts.

const SUPABASE_URL = 'https://bcigkiutioahmeuxnaph.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_S5yoeRVzQ66LSk3zdB9sWg_IjxkjjX2';

// Capture recovery markers BEFORE supabase.createClient() runs.
// detectSessionInUrl fires synchronously inside createClient and consumes the
// hash, emitting PASSWORD_RECOVERY before our React listener is attached. If
// we don't snapshot the URL here, AppWrapper has no way to know the user
// arrived via a reset link — it just sees a fresh session and renders the
// app, silently logging them in instead of showing the reset password screen.
window.__INNERGAME_FROM_RECOVERY = (function () {
  try {
    var h = window.location.hash || '';
    var s = window.location.search || '';
    return (
      h.indexOf('type=recovery') !== -1 ||
      s.indexOf('type=recovery') !== -1 ||
      s.indexOf('action=reset') !== -1
    );
  } catch (e) {
    return false;
  }
})();

// Strip the ?action=reset marker from the URL once captured so a page refresh
// doesn't re-trigger the reset screen after the user has completed the reset.
// (We leave the hash alone — Supabase needs to read access_token from it.)
if (window.__INNERGAME_FROM_RECOVERY) {
  try {
    var _u = new URL(window.location.href);
    if (_u.searchParams.has('action')) {
      _u.searchParams.delete('action');
      window.history.replaceState({}, '', _u.pathname + _u.search + _u.hash);
    }
  } catch (e) { /* ignore — URL constructor missing on ancient browsers */ }
}

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
