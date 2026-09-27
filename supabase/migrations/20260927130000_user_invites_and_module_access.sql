-- User administration + per-group module access (2026-09-27).
--
-- 1. INVITES — an ops admin can create an app account (individual client,
--    service-provider agency, or CPO) without ever handling a password. The row
--    is born with password_hash NULL plus invited_at / invite_expires_at; the
--    person signs up in the normal app flow with that phone number, the SMS OTP
--    proves they own it, and registerVerify CLAIMS the pre-configured row
--    (sets their own password) instead of inserting a new one. Login is
--    impossible until then (login() already refuses a NULL password_hash).
--
-- 2. MODULE ACCESS — which product modules each account group may use.
--    module_access is the group × module matrix; user_module_overrides wins over
--    it for one user. ABSENT ROW = ENABLED, so both tables empty is exactly the
--    pre-feature behaviour. Enforced in auth-service (ModuleAccessGuard → 403
--    module_disabled) on module ENTRY points only — never on SOS/panic, VBG
--    check-in/telemetry, or an in-flight protection session.
--
-- Both tables: RLS on with NO policies → deny-all to anon/authenticated; only
-- the backend's service-role connection reads or writes them.

alter table public.users
  add column if not exists invited_at        timestamptz,
  add column if not exists invited_by        uuid,
  add column if not exists invite_expires_at timestamptz;

comment on column public.users.invited_at is
  'Set when an ops admin created this account as an SMS invite. Pending = invited_at set, password_hash NULL, invite_expires_at in the future.';

-- Claim lookup is by phone among pending invites.
create index if not exists users_pending_invite_idx
  on public.users (phone_e164)
  where invited_at is not null and password_hash is null and deleted_at is null;

create table if not exists public.module_access (
  account_group text        not null
    check (account_group in ('individual', 'enterprise', 'agency', 'cpo')),
  module_key    text        not null check (module_key ~ '^[a-z][a-z0-9_]{1,40}$'),
  enabled       boolean     not null,
  updated_by    uuid,
  updated_at    timestamptz not null default now(),
  primary key (account_group, module_key)
);
alter table public.module_access enable row level security;

create table if not exists public.user_module_overrides (
  user_id    uuid        not null references public.users(id) on delete cascade,
  module_key text        not null check (module_key ~ '^[a-z][a-z0-9_]{1,40}$'),
  enabled    boolean     not null,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  primary key (user_id, module_key)
);
alter table public.user_module_overrides enable row level security;

comment on table public.module_access is
  'Group × module matrix edited in the ops console (Module Access). Absent row = enabled. RLS deny-all; backend service-role only. Added 2026-09-27.';
comment on table public.user_module_overrides is
  'Per-user module override; wins over module_access. Absent row = follow the group. RLS deny-all; backend service-role only. Added 2026-09-27.';
