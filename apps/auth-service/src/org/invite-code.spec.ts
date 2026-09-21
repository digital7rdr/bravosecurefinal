import {
  INVITE_CODE_ALPHABET, INVITE_CODE_LENGTH, INVITE_CODE_RE, DEFAULT_INVITE_TTL_DAYS, MAX_INVITE_TTL_DAYS,
  generateInviteCode, normalizeInviteCode, clampTtlDays, inviteStatus, normalizeInviteRole, normalizeCallSign,
} from './invite-code';

/** B-812 — the shared invite-code rules (agency mint + ops mint + redeem). */
describe('provider invite codes', () => {
  it('the alphabet has no look-alikes and the code is BRAVO- plus six of them', () => {
    expect(INVITE_CODE_ALPHABET).not.toMatch(/[01OI]/);
    expect(INVITE_CODE_ALPHABET.length).toBe(32);
    expect(INVITE_CODE_LENGTH).toBe(6);
    for (let i = 0; i < 200; i++) {
      const c = generateInviteCode();
      expect(c).toMatch(/^BRAVO-[A-HJ-NP-Z2-9]{6}$/);
      expect(INVITE_CODE_RE.test(c)).toBe(true);
    }
  });

  it('is driven by the random source (deterministic bytes → deterministic code)', () => {
    const fixed = (n: number) => Buffer.alloc(n, 0);
    expect(generateInviteCode(fixed)).toBe('BRAVO-AAAAAA');
    const last = (n: number) => Buffer.alloc(n, 31);
    expect(generateInviteCode(last)).toBe('BRAVO-999999');
  });

  it('normalises what a user might type: case, spaces, a missing dash', () => {
    expect(normalizeInviteCode(' bravo-7q2k3m ')).toBe('BRAVO-7Q2K3M');
    expect(normalizeInviteCode('BRAVO7Q2K3M')).toBe('BRAVO-7Q2K3M');
    expect(normalizeInviteCode('bravo - 7q2k 3m')).toBe('BRAVO-7Q2K3M');
    expect(normalizeInviteCode('')).toBe('');
    expect(normalizeInviteCode(null)).toBe('');
    expect(normalizeInviteCode('XYZ-1')).toBe('XYZ-1'); // not ours; the redeem UPDATE simply matches nothing
  });

  it('ttl defaults to 7 days and is clamped to 1..30', () => {
    expect(DEFAULT_INVITE_TTL_DAYS).toBe(7);
    expect(MAX_INVITE_TTL_DAYS).toBe(30);
    expect(clampTtlDays(undefined)).toBe(7);
    expect(clampTtlDays(0)).toBe(1);
    expect(clampTtlDays(365)).toBe(30);
    expect(clampTtlDays(2.6)).toBe(3);
    expect(clampTtlDays(Number.NaN)).toBe(7);
  });

  it('status: redeemed wins over revoked, revoked over expired, otherwise open', () => {
    const now = Date.parse('2026-09-06T12:00:00Z');
    const past = '2026-09-01T00:00:00Z'; const future = '2026-09-30T00:00:00Z';
    expect(inviteStatus({redeemed_at: past, revoked_at: past, expires_at: past}, now)).toBe('redeemed');
    expect(inviteStatus({redeemed_at: null, revoked_at: past, expires_at: past}, now)).toBe('revoked');
    expect(inviteStatus({redeemed_at: null, revoked_at: null, expires_at: past}, now)).toBe('expired');
    expect(inviteStatus({redeemed_at: null, revoked_at: null, expires_at: future}, now)).toBe('open');
    expect(inviteStatus({redeemed_at: null, revoked_at: null, expires_at: null}, now)).toBe('open');
  });

  it('role and call sign are normalised, never trusted', () => {
    expect(normalizeInviteRole('manager')).toBe('manager');
    expect(normalizeInviteRole('owner')).toBe('cpo');
    expect(normalizeInviteRole(undefined)).toBe('cpo');
    expect(normalizeCallSign('  ranger-7 ')).toBe('RANGER-7');
    expect(normalizeCallSign('<script>x</script>')).toBe('SCRIPTXSCRIPT');
    expect(normalizeCallSign('')).toBeNull();
    expect(normalizeCallSign('A'.repeat(40))!.length).toBe(24);
  });
});
