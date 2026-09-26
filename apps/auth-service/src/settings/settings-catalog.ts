/**
 * The catalog of runtime-editable third-party settings.
 *
 * ONE source of truth: the SettingsService validates writes against it, the
 * admin controller returns it to the console, and the console renders its UI
 * from it — so adding a setting here surfaces it everywhere with no UI change.
 *
 * `envFallback` reproduces exactly how the consuming code read the value BEFORE
 * this table existed, so an empty platform_settings table behaves identically to
 * the pre-existing env-only deployment. `key` matches the dotted key the
 * consumer passes to SettingsService.get().
 */
import type {ConfigService} from '@nestjs/config';

export type SettingCategory = 'stripe' | 'twilio' | 'mapbox' | 'biometric';

export interface SettingDef {
  key: string;
  category: SettingCategory;
  label: string;
  help?: string;
  /** Secret → stored AES-GCM encrypted, never returned in clear, shown masked. */
  secret: boolean;
  placeholder?: string;
  /** How the value was sourced from env before the table existed. */
  envFallback: (cfg: ConfigService) => string | undefined;
}

const mapboxEnv = (): string | undefined =>
  process.env.MAPBOX_ACCESS_TOKEN ??
  process.env.NEXT_PUBLIC_MAPBOX_TOKEN ??
  process.env.EXPO_PUBLIC_MAPBOX_TOKEN;

export const SETTINGS_CATALOG: readonly SettingDef[] = [
  // ── Stripe ────────────────────────────────────────────────────────────────
  {key: 'stripe.secretKey', category: 'stripe', label: 'Secret key', secret: true,
   placeholder: 'sk_live_… / sk_test_…', help: 'Server API key. Live keys start sk_live_.',
   envFallback: c => c.get<string>('stripe.secretKey')},
  {key: 'stripe.webhookSecret', category: 'stripe', label: 'Webhook signing secret', secret: true,
   placeholder: 'whsec_…', help: 'Comma-separate several to accept more than one endpoint.',
   envFallback: c => c.get<string>('stripe.webhookSecret')},
  {key: 'stripe.proPriceId', category: 'stripe', label: 'Secure Pro price ID', secret: false,
   placeholder: 'price_…', envFallback: c => c.get<string>('stripe.proPriceId')},
  {key: 'stripe.enterprisePriceId', category: 'stripe', label: 'Enterprise price ID', secret: false,
   placeholder: 'price_…', envFallback: c => c.get<string>('stripe.enterprisePriceId')},
  {key: 'stripe.apiBase', category: 'stripe', label: 'API base URL', secret: false,
   placeholder: 'https://api.stripe.com', help: 'Leave blank for the default.',
   envFallback: c => c.get<string>('stripe.apiBase')},
  {key: 'stripe.apiVersion', category: 'stripe', label: 'API version', secret: false,
   placeholder: '2024-06-20', envFallback: c => c.get<string>('stripe.apiVersion')},

  // ── Twilio ────────────────────────────────────────────────────────────────
  {key: 'twilio.accountSid', category: 'twilio', label: 'Account SID', secret: false,
   placeholder: 'AC…', envFallback: c => c.get<string>('twilio.accountSid')},
  {key: 'twilio.authToken', category: 'twilio', label: 'Auth token', secret: true,
   envFallback: c => c.get<string>('twilio.authToken')},
  {key: 'twilio.fromNumber', category: 'twilio', label: 'From number', secret: false,
   placeholder: '+1…', help: 'E.164. Used for plain SMS when no Verify SID is set.',
   envFallback: c => c.get<string>('twilio.fromNumber')},
  {key: 'twilio.verifySid', category: 'twilio', label: 'Verify service SID', secret: false,
   placeholder: 'VA…', help: 'When set, OTP uses Twilio Verify instead of raw SMS.',
   envFallback: c => c.get<string>('twilio.verifySid')},

  // ── Mapbox (server token: directions + geocoding + VBG) ─────────────────────
  {key: 'mapbox.serverToken', category: 'mapbox', label: 'Server access token', secret: true,
   placeholder: 'sk.… or pk.…', help: 'Used server-side for Directions, geocoding and VBG. Separate from the app tile token.',
   envFallback: () => mapboxEnv()},

  // ── Biometric (Google Vision liveness) ──────────────────────────────────────
  {key: 'biometric.googleApiKey', category: 'biometric', label: 'Google API key', secret: true,
   envFallback: c => c.get<string>('biometric.googleApiKey')},
] as const;

export const CATALOG_BY_KEY: ReadonlyMap<string, SettingDef> =
  new Map(SETTINGS_CATALOG.map(d => [d.key, d]));

export const CATALOG_CATEGORIES: readonly {id: SettingCategory; label: string}[] = [
  {id: 'stripe', label: 'Stripe'},
  {id: 'twilio', label: 'Twilio'},
  {id: 'mapbox', label: 'Mapbox'},
  {id: 'biometric', label: 'Biometric'},
];
