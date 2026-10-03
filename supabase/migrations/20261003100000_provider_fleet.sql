-- Provider console Phase 2 (2026-10-03): agency-owned vehicles.
--
-- Until now the only vehicle tables were HQ's: vehicle_pool (Lite) and
-- pro_fleet_vehicles (Secure Pro). A security agency had no way to record the
-- cars its crews drive, although offers already tell it how many vehicles a
-- job needs (dispatch_offers / CoarseOffer.vehicle_count).
--
-- 1. org_vehicles — an agency's own fleet. The agency adds and edits it in the
--    provider console; HQ reviews each vehicle in the ops console. Only a
--    VERIFIED, active vehicle can be put on a job. Changing what identifies a
--    vehicle (plate, make/model, armour) sends it back to review.
--
-- 2. mission_org_vehicles — which of the agency's vehicles run a mission.
--    "Busy" is derived from the mission's own status (open states), so a
--    vehicle frees itself when the mission ends; released_at is set when the
--    agency takes a vehicle off a mission early. The service serialises
--    assignment per vehicle with SELECT … FOR UPDATE.
--
-- Additive only: no existing table or column changes. Both tables: RLS on
-- with NO policies → deny-all to anon/authenticated; only the backend's
-- service-role connection reads or writes them.

create table if not exists public.org_vehicles (
  id            uuid        primary key default gen_random_uuid(),
  org_user_id   uuid        not null references public.users(id) on delete cascade,
  call_sign     text        not null check (char_length(call_sign) between 1 and 24),
  make_model    text        not null check (char_length(make_model) between 2 and 80),
  plate         text        not null check (char_length(plate) between 2 and 20),
  colour        text        check (colour is null or char_length(colour) <= 40),
  armored       boolean     not null default false,
  armor_grade   text        check (armor_grade is null or char_length(armor_grade) <= 20),
  capacity      integer     not null default 4 check (capacity between 1 and 20),
  region_code   text        check (region_code is null or region_code ~ '^[A-Z]{2}(-[A-Z0-9]{1,4})?$'),
  review_status text        not null default 'pending'
    check (review_status in ('pending', 'verified', 'rejected')),
  review_note   text        check (review_note is null or char_length(review_note) <= 280),
  reviewed_by   uuid,
  reviewed_at   timestamptz,
  active        boolean     not null default true,
  created_by    uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
alter table public.org_vehicles enable row level security;

-- One plate and one call sign per agency (plates compared without spaces).
create unique index if not exists org_vehicles_org_plate_uq
  on public.org_vehicles (org_user_id, upper(regexp_replace(plate, '\s', '', 'g')));
create unique index if not exists org_vehicles_org_call_sign_uq
  on public.org_vehicles (org_user_id, upper(call_sign));
-- The HQ review queue.
create index if not exists org_vehicles_review_idx
  on public.org_vehicles (review_status, created_at) where active;

create table if not exists public.mission_org_vehicles (
  mission_id  uuid        not null references public.missions(id) on delete cascade,
  vehicle_id  uuid        not null references public.org_vehicles(id) on delete cascade,
  org_user_id uuid        not null,
  assigned_by uuid,
  assigned_at timestamptz not null default now(),
  released_at timestamptz,
  primary key (mission_id, vehicle_id)
);
alter table public.mission_org_vehicles enable row level security;
create index if not exists mission_org_vehicles_vehicle_idx
  on public.mission_org_vehicles (vehicle_id) where released_at is null;

comment on table public.org_vehicles is
  'Agency-owned vehicles (provider console). HQ reviews; only verified + active can be assigned. RLS deny-all; backend only. Added 2026-10-03.';
comment on table public.mission_org_vehicles is
  'Agency vehicle ↔ mission. Busy = an unreleased row whose mission is in an open state. RLS deny-all; backend only. Added 2026-10-03.';
