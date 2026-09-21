/**
 * B-843 — the chosen payer, from the draft to the wire.
 *
 * Two halves, both money-critical:
 *
 *  1. The BEHAVIOUR: the create body carries the member's choice, a reset
 *     clears it, and it never counts as "unsaved work" (a payer pick is not a
 *     booking the user would mourn — B-790's dirty rule must not start
 *     blocking a product switch because the wizard preselected a root).
 *  2. The WIRE KEYS (A16): the create body's key is `payer_user_id` and the
 *     pay body's is `payerUserId`. A mis-cased key is STRIPPED by the server's
 *     `whitelist: true` pipe, which means the charge silently lands on the
 *     default payer instead of the chosen one — the exact silent-wrong-charge
 *     that D2's fail-closed refusal exists to prevent. Casing is pinned per
 *     call site because there is no runtime signal when it is wrong.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const mockCreate = jest.fn();
const mockRequestAuto = jest.fn();

jest.mock('@services/api', () => ({
  walletApi: {},
  bookingApi: {
    create: (...a: unknown[]) => mockCreate(...a),
    requestAuto: (...a: unknown[]) => mockRequestAuto(...a),
  },
}));
jest.mock('@utils/constants', () => ({AUTO_DISPATCH: false}));
jest.mock('@store/authStore', () => ({useAuthStore: {getState: () => ({user: null})}}));

import {useBookingStore, isBookingDraftDirty} from '@store/bookingStore';
import {payerChoiceFromRefusal, payerRefusalMessage} from '../payerOptions';
import {holderFrom, quotaFiguresFrom, spendDenialKind} from '../creditErrors';

const PIN = {address: 'DIFC Gate 4, Dubai', latitude: 25.2, longitude: 55.27} as never;
const okBooking = {id: 'bk-1', status: 'PENDING_OPS'};

beforeEach(() => {
  jest.clearAllMocks();
  mockCreate.mockResolvedValue({data: {booking: okBooking}});
  useBookingStore.getState().resetDraft();
});

afterEach(() => {
  // The post-submit clear is a 500 ms timer; resetDraft cancels it so it can
  // never fire into the NEXT test's draft.
  useBookingStore.getState().resetDraft();
});

/** The body the store actually handed the API on the last create. */
function sentBody(): Record<string, unknown> {
  expect(mockCreate).toHaveBeenCalled();
  return mockCreate.mock.calls[0][0] as Record<string, unknown>;
}

describe('the create body carries the member\'s choice', () => {
  it('sends payer_user_id when the draft holds one', async () => {
    useBookingStore.getState().updateDraft({pickup: PIN, payerUserId: 'holder-a'});
    await useBookingStore.getState().confirmBooking();
    expect(sentBody().payer_user_id).toBe('holder-a');
  });

  it('OMITS the key when nothing was chosen — an absent key lets the server default', async () => {
    useBookingStore.getState().updateDraft({pickup: PIN});
    await useBookingStore.getState().confirmBooking();
    const body = sentBody();
    expect(body.payer_user_id).toBeUndefined();
    // JSON.stringify drops an undefined value, so the wire really has no key.
    expect(JSON.stringify(body)).not.toContain('payer_user_id');
  });

  it('the member\'s OWN id is a legitimate choice ("my wallet"), not a no-op', async () => {
    useBookingStore.getState().updateDraft({pickup: PIN, payerUserId: 'user-me'});
    await useBookingStore.getState().confirmBooking();
    expect(sentBody().payer_user_id).toBe('user-me');
  });
});

describe('draft lifecycle', () => {
  it('resetDraft clears the choice — the next booking must ask again (Q2)', () => {
    useBookingStore.getState().updateDraft({payerUserId: 'holder-a'});
    useBookingStore.getState().resetDraft();
    expect(useBookingStore.getState().draft.payerUserId).toBeUndefined();
  });

  it('a cross-product entry (startExecutiveDraft) clears it too', () => {
    useBookingStore.getState().updateDraft({payerUserId: 'holder-a'});
    useBookingStore.getState().startExecutiveDraft();
    expect(useBookingStore.getState().draft.payerUserId).toBeUndefined();
  });

  it('isBookingDraftDirty IGNORES it — a preselected payer is not unsaved work', () => {
    useBookingStore.getState().updateDraft({payerUserId: 'holder-a'});
    expect(isBookingDraftDirty()).toBe(false);
    // …and it still reports real work.
    useBookingStore.getState().updateDraft({notes: 'meet at lobby'});
    expect(isBookingDraftDirty()).toBe(true);
  });
});

describe('PAYER_CHOICE_REQUIRED is a question, not an error', () => {
  const options = [
    {holderId: 'holder-a', holderName: 'Dad', spendLimit: 5000, spent: 0, remaining: 5000, held: false, rootSuspended: false},
    {holderId: 'holder-b', holderName: 'Acme Ltd', spendLimit: null, spent: 0, remaining: null, held: false, rootSuspended: false},
  ];
  const refusal = {
    response: {status: 400, data: {
      code: 'PAYER_CHOICE_REQUIRED',
      message: 'Choose which account pays for this booking.',
      options,
    }},
  };

  it('parks the options on the store and leaves `error` alone', async () => {
    mockCreate.mockRejectedValue(refusal);
    useBookingStore.getState().updateDraft({pickup: PIN});
    await expect(useBookingStore.getState().confirmBooking()).rejects.toBeDefined();
    const s = useBookingStore.getState();
    expect(s.payerChoiceRequired?.map(o => o.holderId)).toEqual(['holder-a', 'holder-b']);
    // `error` is rendered VERBATIM by BookingHistoryScreen / AddOnsScreen, so a
    // question the selector is about to ask must not also appear as a failure.
    expect(s.error).toBeNull();
  });

  it('re-throws with the code so the screen can open the selector', async () => {
    mockCreate.mockRejectedValue(refusal);
    useBookingStore.getState().updateDraft({pickup: PIN});
    await expect(useBookingStore.getState().confirmBooking())
      .rejects.toMatchObject({code: 'PAYER_CHOICE_REQUIRED'});
  });

  it('a NEW attempt clears the parked options — a stale list is a stale question', async () => {
    mockCreate.mockRejectedValue(refusal);
    useBookingStore.getState().updateDraft({pickup: PIN});
    await expect(useBookingStore.getState().confirmBooking()).rejects.toBeDefined();
    expect(useBookingStore.getState().payerChoiceRequired).not.toBeNull();

    mockCreate.mockResolvedValue({data: {booking: okBooking}});
    useBookingStore.getState().updateDraft({payerUserId: 'holder-a'});
    await useBookingStore.getState().confirmBooking();
    expect(useBookingStore.getState().payerChoiceRequired).toBeNull();
  });

  it('an ordinary failure still populates `error` — this is not a blanket mute', async () => {
    mockCreate.mockRejectedValue({response: {status: 400, data: {message: 'You already have an active booking.'}}});
    useBookingStore.getState().updateDraft({pickup: PIN});
    await expect(useBookingStore.getState().confirmBooking()).rejects.toBeDefined();
    expect(useBookingStore.getState().error).toBe('You already have an active booking.');
    expect(useBookingStore.getState().payerChoiceRequired).toBeNull();
  });

  it('sign-out drops the parked options', async () => {
    mockCreate.mockRejectedValue(refusal);
    useBookingStore.getState().updateDraft({pickup: PIN});
    await expect(useBookingStore.getState().confirmBooking()).rejects.toBeDefined();
    useBookingStore.getState().reset();
    expect(useBookingStore.getState().payerChoiceRequired).toBeNull();
  });
});

/**
 * P0-1 — the store's RETHROW must carry the structured body.
 *
 * Every B-843 reader (`payerRefusalMessage`, `payerChoiceFromRefusal`,
 * `holderFrom`, and the older `quotaFiguresFrom`) looks at `response.data`.
 * The catch rebuilds a bare `new Error(friendly)` and copies only
 * `code`/`amountDue`/`bookingId` onto it — so on the CREATE path those readers
 * saw NOTHING, `payer.noteRefusal(e)` answered null, and a root-short
 * `insufficient_credits` fell straight through to `navigate('CreditPaywall')`:
 * the member tops up their own wallet for a booking a ROOT is paying. That is
 * B-384's loop, which the plan (A7) exists to close.
 *
 * These cases drive the REAL store and read the REAL rethrow, because every
 * other pin in this batch hand-feeds `{response: {data}}` and would stay green
 * with the bug in place.
 */
describe('P0-1 — the rethrown error is readable by every B-843 reader', () => {
  const rootShort = {
    response: {status: 400, data: {
      code: 'insufficient_credits',
      message: 'insufficient_credits',
      payer_is_self: false,
      holder_id: 'holder-a',
      holder_name: 'Acme Ltd',
      required: 400,
      options: [
        {holderId: 'holder-a', holderName: 'Acme Ltd', spendLimit: 5000, spent: 5000, remaining: 0, held: false, rootSuspended: false},
        {holderId: 'holder-b', holderName: 'Dad', spendLimit: null, spent: 0, remaining: null, held: false, rootSuspended: false},
      ],
    }},
  };

  /** Run a create that fails, and hand back what the STORE threw. */
  async function rethrowOf(refusal: unknown): Promise<unknown> {
    mockCreate.mockRejectedValue(refusal);
    useBookingStore.getState().updateDraft({pickup: PIN});
    try {
      await useBookingStore.getState().confirmBooking();
    } catch (e) {
      return e;
    }
    throw new Error('confirmBooking resolved — the refusal never reached the caller');
  }

  it('payerRefusalMessage sees it, so the wizard never routes to CreditPaywall', async () => {
    const out = await rethrowOf(rootShort);
    expect(payerRefusalMessage(out)).toMatch(/another account|your wallet/i);
  });

  it('payerChoiceFromRefusal sees the accounts the server offered', async () => {
    const out = await rethrowOf(rootShort);
    expect(payerChoiceFromRefusal(out)?.map(o => o.holderId)).toEqual(['holder-a', 'holder-b']);
  });

  it('holderFrom can name the root that refused', async () => {
    const out = await rethrowOf(rootShort);
    expect(holderFrom(out)).toEqual({holderId: 'holder-a', holderName: 'Acme Ltd'});
  });

  it('spendDenialKind reads payer_is_self off the rethrow, not a caller guess', async () => {
    const out = await rethrowOf(rootShort);
    expect(spendDenialKind(out)).toBe('ROOT_CREDIT_UNAVAILABLE');
  });

  it('quotaFiguresFrom survives too — it was dead on this path for the same reason', async () => {
    const out = await rethrowOf({
      response: {status: 400, data: {
        code: 'SPENDING_QUOTA_EXCEEDED', message: 'family_spend_limit_exceeded',
        holder_id: 'holder-a', holder_name: 'Acme Ltd',
        required: 400, allocated: 5000, used: 5000, remaining: 0,
      }},
    });
    expect(quotaFiguresFrom(out)).toEqual({required: 400, allocated: 5000, used: 5000, remaining: 0});
    expect(holderFrom(out)?.holderName).toBe('Acme Ltd');
  });

  it('still carries the fields callers already branched on (Issue 25 unbroken)', async () => {
    const out = await rethrowOf({
      response: {status: 400, data: {code: 'active_booking_exists', message: 'active_booking_exists', booking_id: 'bk-9'}},
    }) as {code?: string; bookingId?: string; message?: string};
    expect(out.code).toBe('active_booking_exists');
    expect(out.bookingId).toBe('bk-9');
    // …and `message` stays the HUMAN string, never the raw code.
    expect(out.message).not.toBe('');
  });

  it('a non-axios failure still rethrows cleanly — no invented body', async () => {
    const out = await rethrowOf(new Error('network timeout'));
    expect(payerRefusalMessage(out)).toBeNull();
    expect(payerChoiceFromRefusal(out)).toBeNull();
    expect(holderFrom(out)).toBeUndefined();
  });
});

// ── A16 — the wire keys, pinned at their call sites ─────────────────────────

const ROOT = process.cwd();

/** CRLF-normalised and comment-stripped: these files are CRLF, and prose
 *  naming a key must neither satisfy nor break a CODE assertion. */
function code(file: string): string {
  return readFileSync(join(ROOT, file), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

describe('A16 — the create body is snake_case, the pay body is camelCase', () => {
  it('bookingStore builds the create body with payer_user_id', () => {
    const src = code('src/store/bookingStore.ts');
    expect(src).toMatch(/payer_user_id:\s*draft\.payerUserId/);
    // The camel spelling in a CreateBookingDto is stripped by `whitelist: true`.
    expect(src).not.toMatch(/payerUserId:\s*draft\.payerUserId/);
  });

  it('BookingCreateBody declares payer_user_id, not payerUserId', () => {
    const src = code('src/services/api.ts');
    const start = src.indexOf('export interface BookingCreateBody');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('\n}', start));
    expect(body).toMatch(/payer_user_id\?:\s*string/);
    expect(body).not.toContain('payerUserId');
  });

  it('payWithCredits sends payerUserId, and only when one was chosen', () => {
    const src = code('src/services/api.ts');
    const start = src.indexOf('payWithCredits:');
    expect(start).toBeGreaterThan(-1);
    const fn = src.slice(start, src.indexOf('),', src.indexOf('Idempotency-Key', start)));
    expect(fn).toMatch(/payerUserId\s*\?\s*\{payerUserId\}\s*:\s*undefined/);
    expect(fn).not.toContain('payer_user_id');
  });
});

/**
 * B-847 — the wizard's payment method must be the one the app can execute.
 *
 * The draft used to seed `payment_method: 'card'` and only `CreditPaywallScreen`
 * ever flipped it, so a booking that reached the board without passing through
 * the paywall persisted 'card' — and the ops console rendered
 * "Payment · CARD · PENDING" for a booking whose escrow hold is charged in
 * Bravo Credits. No screen offers a card choice and the server has no card lane,
 * so the only honest default is the one below.
 */
describe('B-847 — the create body says bravo_credits, the only method the app can execute', () => {
  it('a fresh draft sends payment_method: bravo_credits', async () => {
    useBookingStore.getState().updateDraft({pickup: PIN});
    await useBookingStore.getState().confirmBooking();
    expect(sentBody().payment_method).toBe('bravo_credits');
  });

  it('bookingStore holds no `card` literal — comment-stripped, so this file\'s own prose cannot satisfy it', () => {
    const src = code('src/store/bookingStore.ts');
    expect(src).not.toMatch(/payment_method:\s*'card'/);
    // Present-token self-check: the key is still SEEDED. Without this the scan
    // above would also pass if the field were simply deleted from the draft,
    // which would send `undefined` and fail the DTO's @IsIn.
    expect(src).toMatch(/payment_method:\s*'bravo_credits'/);
  });
});
