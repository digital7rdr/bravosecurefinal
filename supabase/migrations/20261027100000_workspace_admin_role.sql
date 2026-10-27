-- 2026-10-27 (owner): workspace roles are User, Manager and Admin; channel members are chosen at creation.
--
-- 1. org_members.workspace_admin — an Admin is an active MANAGER of an
--    Enterprise workspace with this flag set. It is a flag on the manager row
--    rather than a new member_role value on purpose: every manager gate in the
--    services (OrgManagerGuard, channel admin seeding, the rank rules) keys on
--    member_role = 'manager', and an Admin must pass all of them. What the flag
--    adds is owner-level authority inside the workspace (role changes, manager
--    permissions, status changes for managers), decided in OrgModuleGuard and
--    OrgCpoService.
--
-- 2. Workspace managers get a working default grant. A manager invited into a
--    workspace was created with permitted_modules NULL (= nothing), so the
--    roster read every channel and member screen depends on (GET /org/cpos)
--    returned 403 and they could not manage channels. Existing workspace
--    managers whose grant was never configured get the workspace defaults;
--    a grant an owner configured (non-NULL, even empty) is left alone.
--
-- Additive and idempotent.

ALTER TABLE public.org_members
  ADD COLUMN IF NOT EXISTS workspace_admin boolean NOT NULL DEFAULT false;

-- An admin flag only means something on a manager row.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_members_workspace_admin_is_manager') THEN
    ALTER TABLE public.org_members
      ADD CONSTRAINT org_members_workspace_admin_is_manager
      CHECK (NOT workspace_admin OR member_role = 'manager');
  END IF;
END $$;

UPDATE public.org_members m
   SET permitted_modules = ARRAY['dept','roster','orgChart','msg']::text[]
 WHERE m.member_role = 'manager'
   AND m.permitted_modules IS NULL
   AND EXISTS (SELECT 1 FROM public.org_workspaces w WHERE w.owner_user_id = m.org_user_id);

-- 3. Channels whose members were CHOSEN at creation (owner 2026-10-27: "When
--    creating Channels I need to be able to decide which members are added").
--    Such a channel is never auto-filled afterwards: a person joining the
--    workspace, a placement change or loosening its access no longer adds
--    everyone. Managers still join every channel (they run them). Existing
--    channels keep today's org-wide behaviour (false).
ALTER TABLE public.department_channels
  ADD COLUMN IF NOT EXISTS explicit_members boolean NOT NULL DEFAULT false;
