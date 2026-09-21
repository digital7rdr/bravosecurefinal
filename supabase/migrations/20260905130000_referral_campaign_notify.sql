-- Referral campaigns (2026-09-05, follow-up): when ops mints a campaign, every
-- eligible client is told by push. Record WHEN and HOW MANY on the campaign so
-- (a) ops can see it, (b) a re-send is a deliberate button press behind a
-- cooldown, never a side effect of an edit or a reactivation.
ALTER TABLE public.referral_campaigns
  ADD COLUMN IF NOT EXISTS notified_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS notified_count INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.referral_campaigns.notified_at IS
  'Last time the eligible-client push fan-out ran for this campaign (mint, or the Notify button).';
