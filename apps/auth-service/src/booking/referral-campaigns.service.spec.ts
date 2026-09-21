/**
 * Referral / discount campaigns (2026-09-05) — the rules a code is judged by.
 *
 * Pinned because every one of these is a money decision a client sees on a
 * quote and pays on a charge:
 *  - the arithmetic (percent, fixed BC, cap, never below zero, never over gross);
 *  - the refusal order (inactive → window → region → service → caps);
 *  - `quote` never throws and `resolveForBooking` refuses with the SAME reason;
 *  - a code that is not a campaign returns null (the caller tries the partner table);
 *  - `applyDiscount` re-derives BC from the discounted EUR and leaves the
 *    breakdown lines alone (the ops exec mapper is positional).
 */
import {BadRequestException} from '@nestjs/common';
import {ReferralCampaignsService, type ReferralCampaignRow} from './referral-campaigns.service';
import {applyDiscount, DEFAULT_SERVICE_PRICING, type PricingResult} from './pricing.service';

const base: ReferralCampaignRow = {
  id: 'camp-1', code: 'DXB20', name: 'Dubai launch', scope: 'region', region_code: 'AE',
  discount_type: 'percent', discount_value: '20', max_discount_bc: null, services: null,
  max_redemptions: null, per_user_limit: 1, starts_at: null, expires_at: null, active: true,
  notes: null, created_by: null, created_at: '2026-09-05T00:00:00Z', updated_at: '2026-09-05T00:00:00Z',
};

function mk(campaign: Partial<ReferralCampaignRow> | null, counts = {total: '0', mine: '0'}) {
  const calls: Array<{sql: string; params?: unknown[]}> = [];
  const db = {
    q: jest.fn().mockImplementation((sql: string, params?: unknown[]) => { calls.push({sql, params}); return Promise.resolve([]); }),
    qOne: jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
      calls.push({sql, params});
      if (/FROM public\.referral_campaigns\s+WHERE code = \$1/.test(sql)) {
        return Promise.resolve(campaign ? {...base, ...campaign} : null);
      }
      if (/FROM public\.referral_redemptions/.test(sql)) return Promise.resolve(counts);
      return Promise.resolve(null);
    }),
  };
  return {svc: new ReferralCampaignsService(db as never), calls};
}

const input = {code: 'dxb20', regionCode: 'AE', service: 'secure_transfer', grossEur: 344, eurPerBc: 1, userId: 'u1'};

describe('discountFor — the arithmetic', () => {
  it('percent of gross, capped in BC, never over the gross', () => {
    expect(ReferralCampaignsService.discountFor({discount_type: 'percent', discount_value: 20, max_discount_bc: null}, 344, 1)).toBe(68.8);
    expect(ReferralCampaignsService.discountFor({discount_type: 'percent', discount_value: 20, max_discount_bc: 50}, 344, 1)).toBe(50);
    // A cap in BC scales with the peg: 50 BC at eur_per_bc = 2 is 100 EUR.
    expect(ReferralCampaignsService.discountFor({discount_type: 'percent', discount_value: 50, max_discount_bc: 50}, 344, 2)).toBe(100);
    expect(ReferralCampaignsService.discountFor({discount_type: 'percent', discount_value: 100, max_discount_bc: null}, 344, 1)).toBe(344);
  });

  it('fixed BC converts at the peg and never exceeds the gross', () => {
    expect(ReferralCampaignsService.discountFor({discount_type: 'fixed_bc', discount_value: 150, max_discount_bc: null}, 344, 1)).toBe(150);
    expect(ReferralCampaignsService.discountFor({discount_type: 'fixed_bc', discount_value: 150, max_discount_bc: null}, 344, 2)).toBe(300);
    expect(ReferralCampaignsService.discountFor({discount_type: 'fixed_bc', discount_value: 1000, max_discount_bc: null}, 344, 1)).toBe(344);
  });

  it('a zero gross, zero value or broken peg discounts nothing', () => {
    expect(ReferralCampaignsService.discountFor({discount_type: 'percent', discount_value: 20, max_discount_bc: null}, 0, 1)).toBe(0);
    expect(ReferralCampaignsService.discountFor({discount_type: 'percent', discount_value: 0, max_discount_bc: null}, 100, 1)).toBe(0);
    expect(ReferralCampaignsService.discountFor({discount_type: 'percent', discount_value: 20, max_discount_bc: null}, 100, 0)).toBe(0);
  });

  it('labels read the way a poster would', () => {
    expect(ReferralCampaignsService.labelFor({discount_type: 'percent', discount_value: '20'})).toBe('20% off');
    expect(ReferralCampaignsService.labelFor({discount_type: 'percent', discount_value: '12.5'})).toBe('12.5% off');
    expect(ReferralCampaignsService.labelFor({discount_type: 'fixed_bc', discount_value: '150.00'})).toBe('150 BC off');
  });
});

describe('quote / resolveForBooking — one decision, two error postures', () => {
  it('applies a live regional code in its region, upper-casing the lookup', async () => {
    const {svc, calls} = mk({});
    const q = await svc.quote(input);
    expect(q?.applied).toBe(true);
    expect(q?.discountEur).toBe(68.8);
    expect(q?.discountBc).toBe(69);
    expect(q?.label).toBe('20% off');
    expect(calls[0].params).toEqual(['DXB20']);
  });

  it('a code that is not a campaign is null — the caller falls back to the partner table', async () => {
    const {svc} = mk(null);
    expect(await svc.quote(input)).toBeNull();
    expect(await svc.resolveForBooking(input)).toBeNull();
  });

  it.each([
    ['inactive', {active: false}, {}, 'referral_campaign_inactive'],
    ['not started', {starts_at: '2999-01-01T00:00:00Z'}, {}, 'referral_campaign_not_started'],
    ['expired', {expires_at: '2000-01-01T00:00:00Z'}, {}, 'referral_campaign_expired'],
    ['wrong region', {region_code: 'SA'}, {}, 'referral_campaign_region_mismatch'],
    ['wrong service', {services: ['executive_protection']}, {}, 'referral_campaign_service_mismatch'],
    ['exhausted', {max_redemptions: 10}, {total: '10', mine: '0'}, 'referral_campaign_exhausted'],
    ['per-user limit', {per_user_limit: 1}, {total: '3', mine: '1'}, 'referral_campaign_limit_reached'],
  ] as Array<[string, Partial<ReferralCampaignRow>, Partial<{total: string; mine: string}>, string]>)(
    '%s: the quote says why, the create refuses with the same code', async (_n, patch, counts, reason) => {
    const {svc} = mk(patch, {total: '0', mine: '0', ...counts});
    const q = await svc.quote(input);
    expect(q?.applied).toBe(false);
    expect(q?.reason).toBe(reason);
    expect(q?.discountEur).toBe(0);
    await expect(svc.resolveForBooking(input)).rejects.toMatchObject({
      response: expect.objectContaining({code: reason}),
    });
    await expect(svc.resolveForBooking(input)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('a universal code ignores the region; a service list admits a listed service', async () => {
    const {svc} = mk({scope: 'universal', region_code: null, services: ['secure_transfer', 'recon_team']});
    const q = await svc.quote({...input, regionCode: 'ZA'});
    expect(q?.applied).toBe(true);
  });

  it('the caps are read from the ledger, bound by campaign AND caller', async () => {
    const {svc, calls} = mk({max_redemptions: 100});
    await svc.quote(input);
    const cnt = calls.find(c => /FROM public\.referral_redemptions/.test(c.sql))!;
    expect(cnt.params).toEqual(['camp-1', 'u1']);
    expect(cnt.sql).toMatch(/FILTER \(WHERE user_id = \$2\)/);
  });
});

describe('recordRedemption — the ledger row', () => {
  it('writes gross / discount / net once per booking, idempotently', async () => {
    const {svc, calls} = mk({});
    await svc.recordRedemption({
      campaignId: 'camp-1', bookingId: 'b1', userId: 'u1', regionCode: 'AE', service: 'secure_transfer',
      grossEur: 344, discountEur: 68.8,
    });
    const ins = calls.find(c => /INSERT INTO public\.referral_redemptions/.test(c.sql))!;
    expect(ins.sql).toMatch(/ON CONFLICT \(booking_id\) DO NOTHING/);
    expect(ins.params).toEqual(['camp-1', 'b1', 'u1', 'AE', 'secure_transfer', 344, 68.8, 275.2]);
  });
});

describe('publicResolve — what a landing page may learn', () => {
  it('returns name, label, scope and region only; anything not live collapses to invalid', async () => {
    const {svc} = mk({expires_at: '2999-01-01T00:00:00Z'});
    const out = await svc.publicResolve('dxb20');
    expect(out).toEqual({
      valid: true, code: 'DXB20', name: 'Dubai launch', label: '20% off', scope: 'region',
      region_code: 'AE', expires_at: '2999-01-01T00:00:00.000Z',
    });
    expect(await mk(null).svc.publicResolve('nope')).toEqual({valid: false});
    expect(await mk({}).svc.publicResolve('x'.repeat(40))).toEqual({valid: false});
  });

  it('the public query itself filters on active + window, so an inactive code never reaches the response', async () => {
    const {svc, calls} = mk({});
    await svc.publicResolve('dxb20');
    // The public lookup uses ITS OWN filtered query, not the ops row.
    const pub = calls[0];
    expect(pub.sql).toMatch(/active = TRUE/);
    expect(pub.sql).toMatch(/expires_at IS NULL OR expires_at > NOW\(\)/);
  });
});

describe('create — refusals before the insert', () => {
  it('requires a region for a regional code and refuses >100 percent or a past expiry', async () => {
    const {svc} = mk(null);
    const dto = {code: 'x1', name: 'X', scope: 'region' as const, discount_type: 'percent' as const, discount_value: 10};
    await expect(svc.create('adm', dto)).rejects.toMatchObject({message: 'region_code_required'});
    await expect(svc.create('adm', {...dto, scope: 'universal', discount_value: 150})).rejects.toMatchObject({message: 'percent_over_100'});
    await expect(svc.create('adm', {...dto, scope: 'universal', expires_at: '2000-01-01T00:00:00Z'})).rejects.toMatchObject({message: 'expires_at_in_past'});
  });

  it('stores the code upper-case with the region upper-cased', async () => {
    const {svc, calls} = mk(null);
    await svc.create('adm', {code: 'dxb20', name: 'Dubai', scope: 'region', region_code: 'ae', discount_type: 'percent', discount_value: 20}).catch(() => undefined);
    const ins = calls.find(c => /INSERT INTO public\.referral_campaigns/.test(c.sql))!;
    expect(ins.params?.slice(0, 4)).toEqual(['DXB20', 'Dubai', 'region', 'AE']);
  });
});

describe('applyDiscount — the quote after a discount', () => {
  const result: PricingResult = {
    total_bc: 344, rate_eur_per_hour: 86, rate_aed_per_hour: 350, total_eur: 344, total_aed: 1400,
    breakdown: [{label: 'Base rate', amount_eur: 86}],
  };

  it('subtracts in EUR, re-derives BC and AED, and leaves the breakdown lines alone', () => {
    const out = applyDiscount(result, 68.8, DEFAULT_SERVICE_PRICING);
    expect(out.total_eur).toBe(275.2);
    expect(out.total_bc).toBe(275);
    expect(out.total_aed).toBe(+(275.2 * (DEFAULT_SERVICE_PRICING.base_rate_aed / DEFAULT_SERVICE_PRICING.transfer_base_rate_bc)).toFixed(2));
    expect(out.breakdown).toBe(result.breakdown);
  });

  it('clamps: never below zero, and a non-positive discount returns the same object', () => {
    expect(applyDiscount(result, 10000).total_eur).toBe(0);
    expect(applyDiscount(result, 0)).toBe(result);
    expect(applyDiscount(result, -5)).toBe(result);
  });
});

describe('eligible-client fan-out — who is told, and never twice by accident', () => {
  function mkNotify(campaign: Partial<ReferralCampaignRow>, pages: string[][], opts: {push?: boolean} = {push: true}) {
    const calls: Array<{sql: string; params?: unknown[]}> = [];
    let pageIx = 0;
    const db = {
      q: jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
        calls.push({sql, params});
        if (/SELECT u\.id FROM public\.users u/.test(sql)) {
          const page = pages[pageIx++] ?? [];
          return Promise.resolve(page.map(id => ({id})));
        }
        return Promise.resolve([]);
      }),
      qOne: jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
        calls.push({sql, params});
        if (/FROM public\.referral_campaigns WHERE id = \$1/.test(sql)) return Promise.resolve({...base, ...campaign});
        if (/COUNT\(\*\)::text AS n FROM public\.users u/.test(sql)) return Promise.resolve({n: '1234'});
        return Promise.resolve(null);
      }),
    };
    const push = opts.push ? {referralOffer: jest.fn().mockResolvedValue(undefined)} : undefined;
    const svc = new ReferralCampaignsService(db as never, push as never);
    return {svc, calls, push};
  }

  it('eligibility: EVERY client, any region — not deleted, not suspended, not opted out', async () => {
    // Founder 2026-09-05: "if I am in BD and the referral is for Cape Town and I
    // go there after some days, I can use it — the notification should go to
    // everyone with the details". The region is enforced at the booking, not
    // at the announcement.
    const {svc, calls} = mkNotify({}, []);
    await svc.countEligible();
    const cnt = calls.find(c => /COUNT\(\*\)::text AS n FROM public\.users u/.test(c.sql))!;
    expect(cnt.sql).toMatch(/u\.role = 'individual'/);
    expect(cnt.sql).toMatch(/u\.deleted_at IS NULL/);
    expect(cnt.sql).toMatch(/u\.suspended_at IS NULL/);
    expect(cnt.sql).toMatch(/notif_prefs->>'offers'/);
    expect(cnt.sql).not.toMatch(/home_region/);
  });

  it('a campaign that is not live is skipped; a recent send is a cooldown; force overrides the cooldown', async () => {
    expect(await mkNotify({active: false}, []).svc.notifyEligible('camp-1')).toEqual({queued: false, skipped: 'not_live'});
    expect(await mkNotify({starts_at: '2999-01-01T00:00:00Z'}, []).svc.notifyEligible('camp-1')).toEqual({queued: false, skipped: 'not_live'});
    const recent = new Date(Date.now() - 3600_000).toISOString();
    expect(await mkNotify({notified_at: recent}, []).svc.notifyEligible('camp-1')).toEqual({queued: false, skipped: 'cooldown'});
    expect(await mkNotify({notified_at: recent}, []).svc.notifyEligible('camp-1', {force: true})).toEqual({queued: true, skipped: null});
    expect(await mkNotify({}, [], {push: false}).svc.notifyEligible('camp-1')).toEqual({queued: false, skipped: 'no_push'});
  });

  it('queuing stamps notified_at BEFORE the loop runs, so a second press is a cooldown', async () => {
    const {svc, calls} = mkNotify({}, [[]]);
    const out = await svc.notifyEligible('camp-1');
    expect(out).toEqual({queued: true, skipped: null});
    const stampIx = calls.findIndex(c => /SET notified_at = NOW\(\)/.test(c.sql));
    const loopIx = calls.findIndex(c => /SELECT u\.id FROM public\.users u/.test(c.sql));
    expect(stampIx).toBeGreaterThan(-1);
    expect(loopIx === -1 || loopIx > stampIx).toBe(true);
  });

  it('the loop pages by id, sends ONE wake per client carrying only public promo facts, then writes the count', async () => {
    const ids1 = Array.from({length: 500}, (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`);
    const ids2 = ['00000000-0000-0000-0000-ffffffffffff'];
    const {svc, calls, push} = mkNotify({expires_at: '2999-01-01T00:00:00Z'}, [ids1, ids2]);
    const sent = await svc.runFanOut({...base, expires_at: '2999-01-01T00:00:00Z'});
    expect(sent).toBe(501);
    expect(push!.referralOffer).toHaveBeenCalledTimes(501);
    // The blob names WHERE the code works (region name, code as fallback when
    // the regions table has no row) and until when — public promo facts only.
    expect(push!.referralOffer).toHaveBeenCalledWith(ids1[0], {
      campaignId: 'camp-1', code: 'DXB20', label: '20% off', regionCode: 'AE', regionName: 'AE',
      expiresAt: '2999-01-01T00:00:00.000Z',
    });
    const pages = calls.filter(c => /SELECT u\.id FROM public\.users u/.test(c.sql));
    expect(pages).toHaveLength(2);
    expect(pages[0].params).toEqual(['00000000-0000-0000-0000-000000000000', 500]);
    expect(pages[1].params?.[0]).toBe(ids1[499]);
    for (const p of pages) expect(p.sql).not.toMatch(/home_region/);
    const count = calls.find(c => /SET notified_count = \$2/.test(c.sql))!;
    expect(count.params).toEqual(['camp-1', 501]);
  });
});
