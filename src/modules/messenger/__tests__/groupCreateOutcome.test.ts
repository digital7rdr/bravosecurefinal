import {
  GroupCreateUnreachableError,
  groupCreateFailureCopy,
  groupCreatePartialNote,
  isNoKeysError,
  isQueuedForRetry,
  markQueuedForRetry,
  unreachableReason,
} from '../runtime/groupCreateOutcome';

/**
 * Bug 27 (2026-10-17) — "Cannot create groups in mobile app".
 * The outcome contract createGroupChat and NewChatScreen share.
 */
describe('queued-for-retry marker', () => {
  it('tags only when the caller says the copy is queued AND retryable', () => {
    const e = Object.assign(new Error('Network request failed'), {status: 0});
    expect(isQueuedForRetry(markQueuedForRetry(e, false))).toBe(false);
    expect(isQueuedForRetry(markQueuedForRetry(e, true))).toBe(true);
  });

  it('wraps a non-Error throw so the tag can ride on it', () => {
    const out = markQueuedForRetry('relay down', true);
    expect(out).toBeInstanceOf(Error);
    expect(isQueuedForRetry(out)).toBe(true);
    expect(isQueuedForRetry(null)).toBe(false);
    expect(isQueuedForRetry('x')).toBe(false);
  });
});

describe('no-keys detection', () => {
  it('recognises the keys service 404 and its message', () => {
    expect(isNoKeysError(Object.assign(new Error('anything'), {status: 404}))).toBe(true);
    expect(isNoKeysError(new Error('no_keys_found'))).toBe(true);
    expect(isNoKeysError(Object.assign(new Error('Service Unavailable'), {status: 503}))).toBe(false);
    expect(isNoKeysError(new Error('Network request failed'))).toBe(false);
  });

  it('classifies raw failure text', () => {
    expect(unreachableReason('no_keys_found')).toBe('no_keys');
    expect(unreachableReason('Network request failed')).toBe('offline');
    expect(unreachableReason('transport not open')).toBe('offline');
    expect(unreachableReason('outer_sealed_too_large')).toBe('other');
  });
});

describe('copy the creator sees', () => {
  const names: Record<string, string> = {u1: 'Amira', u2: 'Ben', u3: 'Chen', u4: 'Dana'};
  const nameOf = (id: string) => names[id];

  it('names members who have not opened Messenger instead of printing ids', () => {
    const e = new GroupCreateUnreachableError(['u1', 'u2'], ['u1: no_keys_found', 'u2: no_keys_found']);
    const {title, message} = groupCreateFailureCopy(e, nameOf);
    expect(title).toBe('Could not create group');
    expect(message).toMatch(/^Amira and Ben haven't opened Bravo Messenger yet/);
    expect(message).not.toMatch(/u1|u2|no_keys/);
  });

  it('says "no connection" when every failure was the network', () => {
    const e = new GroupCreateUnreachableError(['u1'], ['u1: Network request failed']);
    expect(groupCreateFailureCopy(e, nameOf).message).toMatch(/No connection/);
  });

  it('never shows the raw runtime message', () => {
    const msg = groupCreateFailureCopy(new Error('group create: no member could be reached ()'), nameOf).message;
    expect(msg).toBe('Please try again.');
  });

  it('a member the screen cannot name is "a member"', () => {
    const e = new GroupCreateUnreachableError(['zz'], ['zz: no_keys_found']);
    expect(groupCreateFailureCopy(e, nameOf).message).toMatch(/^a member hasn't opened/);
  });

  it('partial note lists the left-out members, null when none', () => {
    expect(groupCreatePartialNote([], nameOf)).toBeNull();
    expect(groupCreatePartialNote(undefined, nameOf)).toBeNull();
    expect(groupCreatePartialNote(['u3'], nameOf)).toMatch(/^Chen wasn't added — they haven't opened Bravo Messenger yet/);
    expect(groupCreatePartialNote(['u1', 'u2', 'u3', 'u4'], nameOf)).toMatch(/^Amira, Ben and 2 others weren't added/);
  });
});
