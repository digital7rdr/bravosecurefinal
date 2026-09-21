/**
 * B-836 / plan A15 — the paste box that turns an ops paste into a batch add.
 *
 * The console is where a company's roster arrives as a paste: a column out of a
 * spreadsheet, a WhatsApp list, a CSV cell. `splitPhones` is the only part of
 * that path that can be unit-tested (the node project has no DOM, so
 * LinkedMembersCard itself is not renderable here) — and it is the part that
 * decides what the server is even asked about.
 *
 * It deliberately does NOT validate E.164. The server's regex is the gate; a
 * token this helper cannot repair comes back unchanged so the card can echo the
 * operator's own raw line next to `invalid_phone` instead of a silently
 * swallowed row.
 */

import {splitPhones} from '../lib/format';

describe('splitPhones — separators', () => {
  it('splits on newlines, commas, semicolons and bare whitespace', () => {
    expect(splitPhones('+971501234567\n+971502345678')).toEqual(['+971501234567', '+971502345678']);
    expect(splitPhones('+971501234567,+971502345678')).toEqual(['+971501234567', '+971502345678']);
    expect(splitPhones('+971501234567;+971502345678')).toEqual(['+971501234567', '+971502345678']);
    expect(splitPhones('+971501234567\t+971502345678')).toEqual(['+971501234567', '+971502345678']);
    expect(splitPhones('+971501234567\r\n+971502345678')).toEqual(['+971501234567', '+971502345678']);
  });

  it('drops empties, blank lines and stray separators', () => {
    expect(splitPhones('')).toEqual([]);
    expect(splitPhones('   \n\n  ')).toEqual([]);
    expect(splitPhones(',,,')).toEqual([]);
    expect(splitPhones('\n+971501234567\n\n,\n')).toEqual(['+971501234567']);
  });
});

describe('splitPhones — repair', () => {
  /**
   * A spreadsheet column is full of these. Splitting on whitespace would tear
   * "+971 50 123 4567" into four junk tokens, so the inner separators are
   * stripped as part of the SAME pass that splits — not after it.
   */
  it('strips spaces, dashes, parentheses and dots inside one number', () => {
    expect(splitPhones('+971 50 123 4567')).toEqual(['+971501234567']);
    expect(splitPhones('+971-50-123-4567')).toEqual(['+971501234567']);
    expect(splitPhones('+971 (50) 123.4567')).toEqual(['+971501234567']);
    expect(splitPhones('+971 50 123 4567\n+880 17 1111 2222')).toEqual(['+971501234567', '+8801711112222']);
  });

  it('maps a leading 00 international prefix to +', () => {
    expect(splitPhones('00971501234567')).toEqual(['+971501234567']);
    expect(splitPhones('00 971 50 123 4567')).toEqual(['+971501234567']);
    // Only LEADING, and only the prefix — an interior 00 is part of the number.
    expect(splitPhones('+97100501234')).toEqual(['+97100501234']);
  });

  it('dedupes on the repaired value, preserving first-occurrence order', () => {
    expect(splitPhones('+971502345678\n+971501234567\n+971502345678')).toEqual(
      ['+971502345678', '+971501234567'],
    );
    // The same number typed three ways is ONE number after repair.
    expect(splitPhones('+971 50 123 4567, +971-50-123-4567, 00971501234567')).toEqual(
      ['+971501234567'],
    );
  });
});

describe('splitPhones — it does not validate', () => {
  /**
   * The card flags anything that is not `^\+\d{6,15}$` client-side and sends
   * only the rest; the server applies the same regex. Both need the RAW token
   * to echo back, so nothing unrepairable may be dropped or rewritten here.
   */
  it('returns non-E.164 tokens unchanged so the card can flag them', () => {
    expect(splitPhones('bob@example.com')).toEqual(['bob@example.com']);
    expect(splitPhones('971501234567')).toEqual(['971501234567']);
    expect(splitPhones('+12345')).toEqual(['+12345']);
    expect(splitPhones('+9715012345678901234')).toEqual(['+9715012345678901234']);
    expect(splitPhones('N/A\n+971501234567')).toEqual(['N/A', '+971501234567']);
  });

  it('keeps a repaired-but-still-invalid token, it does not swallow it', () => {
    // "50-123-4567" repairs to "501234567": no plus, so still invalid — but the
    // operator must SEE that it was refused, not wonder where the line went.
    expect(splitPhones('50-123-4567')).toEqual(['501234567']);
  });
});
