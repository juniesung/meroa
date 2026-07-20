import { getApiBaseUrl } from '@/lib/api/client';

// The privacy policy, terms, and support pages are served as HTML from the same
// Hono server the app already talks to (server/src/routes/legal.ts), so their
// URLs track whatever host EXPO_PUBLIC_API_URL points at — no separate domain to
// keep in sync. Used by the AI-consent screen, the paywall disclosure, and the
// You tab.
export const privacyUrl = (): string => `${getApiBaseUrl()}/privacy`;
export const termsUrl = (): string => `${getApiBaseUrl()}/terms`;
export const supportUrl = (): string => `${getApiBaseUrl()}/support`;
