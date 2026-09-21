-- B-794 — human-readable device identity on auth_devices.
--
-- `auth_devices` records WHICH SESSION a user holds but not WHAT they hold it
-- on: `device_id` is a random UUID the app mints into AsyncStorage on first
-- run, and `platform` is one of three words. So the ops console's Devices card
-- could only ever say "android · 3f2a91c4…", which answers nothing when support
-- is asked "what phone is this person using?".
--
-- All four columns are nullable on purpose: every row that exists today
-- predates the capture, and the web/ops-console session has no device model at
-- all. A NULL here means "not reported", never "unknown device" — the console
-- renders it as the platform alone rather than inventing a name.
--
-- The values are supplied by the client at login. They are cosmetic
-- identification only: nothing authenticates, authorises or rate-limits on
-- them, so a client that lies about its model gains nothing. They are capped at
-- the DTO layer (64 chars) and stored as-is.
ALTER TABLE public.auth_devices
  ADD COLUMN IF NOT EXISTS device_model text,
  ADD COLUMN IF NOT EXISTS device_brand text,
  ADD COLUMN IF NOT EXISTS os_version   text,
  ADD COLUMN IF NOT EXISTS app_version  text;

COMMENT ON COLUMN public.auth_devices.device_model IS
  'Client-reported hardware model (e.g. "Redmi Note 11"). NULL = not reported (pre-B-794 row, or a web session). Cosmetic only — never trusted for authz.';
COMMENT ON COLUMN public.auth_devices.device_brand IS
  'Client-reported manufacturer/brand (e.g. "Xiaomi"). NULL = not reported.';
COMMENT ON COLUMN public.auth_devices.os_version IS
  'Client-reported OS release (Android "11", iOS "17.4"). NULL = not reported.';
COMMENT ON COLUMN public.auth_devices.app_version IS
  'Bravo Secure build the session was created from (app.json expo.version). NULL = not reported. Lets support see who is on a stale build.';
