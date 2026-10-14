-- Enterprise channel structure, configured from the Bravo ops console
-- (2026-10-15).
--
-- Founder request: "enterprise department channels — parent company,
-- departments, child entities and sub-entities and departments under it …
-- configurable from the backend." Sample: GardaWorld Africa › countries ›
-- Gauteng Province (Provincial Broadcast, Committees, Announcements, Knowledge
-- Hub) › Johannesburg / Tshwane / Ekurhuleni Area (Area Broadcast, Operations,
-- Administration, Logistics, HR & Training).
--
-- The TREE already exists (department_channels.parent_id / level 0..3 /
-- is_lateral). Two things were missing:
--
-- 1. WHERE A MEMBER SITS. Until now every channel was seeded to every active
--    member of the organisation, so a Johannesburg guard would be added to the
--    Tshwane area chats. `org_members.placement_channel_id` names the node a
--    member belongs to; they then see that node and everything beneath it, the
--    levels above it read-only, and those levels' one-way channels
--    (announcement / read-only). NULL = the whole organisation, which is
--    exactly how every existing member behaves today, so nothing changes until
--    ops places someone.
--
--    NO foreign key, deliberately. ON DELETE SET NULL would turn a deleted
--    node into an org-wide grant on the next seed — a silent widening. The
--    service FAILS CLOSED instead: a placement naming a channel that no longer
--    exists grants the organisation's broadcasts only. The trigger below keeps
--    every WRITE honest (same org, a node rather than a lateral/broadcast).
--
-- 2. THE STANDARD CHANNELS OF A LEVEL. `org_workspace_settings.channel_templates`
--    holds, per stored level 0..3, the laterals created with a new node
--    ({"3": [{"name": "Operations", "post_mode": "open"}, …]}). Creation
--    defaults only: this table's rule stands — nothing in it is read by an
--    authorisation check. An empty object means "use the built-in defaults".
--
-- Additive and idempotent. Existing rows are untouched.

ALTER TABLE public.org_members
  ADD COLUMN IF NOT EXISTS placement_channel_id uuid NULL;

COMMENT ON COLUMN public.org_members.placement_channel_id IS
  'Enterprise structure (2026-10-15): the department_channels node this member '
  'belongs to. They are seeded into that node and its subtree, the ancestors '
  'read-only, and the ancestors'' one-way laterals. NULL = the whole '
  'organisation (pre-2026-10-15 behaviour). No FK on purpose: a deleted node '
  'must fail closed, not become org-wide via SET NULL.';

CREATE INDEX IF NOT EXISTS org_members_placement_idx
  ON public.org_members (placement_channel_id)
  WHERE placement_channel_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.org_members_placement_check()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  ch record;
BEGIN
  IF NEW.placement_channel_id IS NULL THEN
    RETURN NEW;
  END IF;
  -- Only re-check when the value actually changes, so an unrelated UPDATE of
  -- a member whose node was since archived is never refused.
  IF TG_OP = 'UPDATE' AND NEW.placement_channel_id IS NOT DISTINCT FROM OLD.placement_channel_id THEN
    RETURN NEW;
  END IF;
  SELECT org_id, is_lateral, is_broadcast INTO ch
    FROM public.department_channels
   WHERE id = NEW.placement_channel_id;
  IF NOT FOUND OR ch.org_id IS DISTINCT FROM NEW.org_user_id THEN
    RAISE EXCEPTION 'placement_channel_in_other_org';
  END IF;
  IF ch.is_lateral OR ch.is_broadcast THEN
    RAISE EXCEPTION 'placement_must_be_a_node';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS org_members_placement_check ON public.org_members;
CREATE TRIGGER org_members_placement_check
  BEFORE INSERT OR UPDATE OF placement_channel_id ON public.org_members
  FOR EACH ROW EXECUTE FUNCTION public.org_members_placement_check();

ALTER TABLE public.org_workspace_settings
  ADD COLUMN IF NOT EXISTS channel_templates jsonb NOT NULL DEFAULT '{}'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'org_workspace_settings_channel_templates_object'
       AND conrelid = 'public.org_workspace_settings'::regclass
  ) THEN
    ALTER TABLE public.org_workspace_settings
      ADD CONSTRAINT org_workspace_settings_channel_templates_object
      CHECK (jsonb_typeof(channel_templates) = 'object');
  END IF;
END $$;

COMMENT ON COLUMN public.org_workspace_settings.channel_templates IS
  'Enterprise structure (2026-10-15): per stored level ("0".."3") the laterals '
  'created with a new node, [{name, post_mode}]. Empty object = built-in '
  'defaults. Creation defaults only; never read by an authorisation check.';
