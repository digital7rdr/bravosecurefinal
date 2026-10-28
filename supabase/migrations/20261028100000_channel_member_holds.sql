-- 2026-10-28 — keep hand-picked channel memberships across a suspension.
--
-- A channel whose members were chosen at creation (department_channels.
-- explicit_members, 20261027100000) is never auto-filled. Suspending a member
-- still removes them from every channel (sessions revoked, group keys rotated
-- away — that part is security-critical and unchanged), but reinstating them
-- only re-added the org-wide channels, so they silently lost the hand-picked
-- ones. The service now writes the explicit-channel memberships it removes on
-- SUSPEND here and restores them (through the normal add + rekey path) on
-- reinstatement, then deletes the hold. A REMOVED member's holds are dropped:
-- bringing someone back after removal is a fresh decision.
--
-- Additive and idempotent.

CREATE TABLE IF NOT EXISTS public.department_channel_member_holds (
  channel_id  UUID NOT NULL REFERENCES public.department_channels(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('admin', 'viewer')),
  role_label  TEXT,
  held_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (channel_id, user_id)
);

CREATE INDEX IF NOT EXISTS dept_channel_member_holds_user_idx
  ON public.department_channel_member_holds(user_id);

-- Deny-by-default like every other table: only the auth-service (service role)
-- reads or writes it.
ALTER TABLE public.department_channel_member_holds ENABLE ROW LEVEL SECURITY;
