export {
  initCrashlytics,
  recordError,
  log,
  setUser,
  setAttribute,
  trackEvent,
  setCollectionEnabled,
  devForceCrash,
} from './crashlytics';
export {ErrorBoundary} from './ErrorBoundary';
export {withScreenErrorBoundary} from './withScreenErrorBoundary';
export {TestCrashButton} from './TestCrashButton';
// Sentry-protocol transport (2026-09-27: replaces Firebase Crashlytics).
// Prefer the wrapper above; these are for the few direct ops-breadcrumb /
// audit-failure call sites.
export {
  captureException,
  addBreadcrumb,
  setSentryUser,
  isSentryEnabled,
} from './sentry';
