/**
 * The check-in face photo lane (founder, 2026-09-05) — the bounds that make
 * storing a face acceptable, each pinned:
 *
 *  - sealing: AES-256-GCM with a purpose-derived key; the SESSION id is AAD, so
 *    a blob moved onto another session refuses to open; mime is sniffed;
 *  - store: owner only, open session only, inside the window, once;
 *  - read: manager's branch only, view counted and AUDITED, purged → 404;
 *  - purge: the ONE predicate — review no longer pending AND shift ended, or
 *    the hard TTL — shared by the sweep and the post-review hook.
 */
import {BadRequestException, ForbiddenException, NotFoundException} from '@nestjs/common';
import {AttendancePhotoService, PURGE_DUE_PREDICATE} from './attendance-photo.service';
import {derivePhotoKey, openPhoto, sealPhoto, sniffImageMime} from './attendancePhotoCrypto';

const ROOT = 'a'.repeat(64);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('fake-jpeg-body')]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png')]);

describe('attendancePhotoCrypto', () => {
  it('derives a stable 32-byte purpose key and refuses a bad root', () => {
    const k1 = derivePhotoKey(ROOT), k2 = derivePhotoKey(ROOT);
    expect(k1).toHaveLength(32);
    expect(k1.equals(k2)).toBe(true);
    expect(() => derivePhotoKey('short')).toThrow(/64 hex/);
    // Not the raw root: the TOTP lane must never share key bytes with this one.
    expect(k1.equals(Buffer.from(ROOT, 'hex'))).toBe(false);
  });

  it('round-trips, binds the session id as AAD, and never repeats an IV', () => {
    const key = derivePhotoKey(ROOT);
    const a = sealPhoto(JPEG, key, 'ses-1');
    const b = sealPhoto(JPEG, key, 'ses-1');
    expect(a.equals(b)).toBe(false);
    expect(openPhoto(a, key, 'ses-1').equals(JPEG)).toBe(true);
    expect(() => openPhoto(a, key, 'ses-2')).toThrow();
    expect(() => openPhoto(a, derivePhotoKey('b'.repeat(64)), 'ses-1')).toThrow();
    expect(() => openPhoto(Buffer.alloc(5), key, 'ses-1')).toThrow(/too short/);
  });

  it('sniffs jpeg / png by magic bytes and rejects everything else', () => {
    expect(sniffImageMime(JPEG)).toBe('image/jpeg');
    expect(sniffImageMime(PNG)).toBe('image/png');
    expect(sniffImageMime(Buffer.from('<svg onload=alert(1)>'))).toBeNull();
    expect(sniffImageMime(Buffer.alloc(0))).toBeNull();
  });
});

type Cap = {sql: string; params?: unknown[]};

function mk(opts: {
  session?: Partial<{org_user_id: string; cpo_user_id: string; status: string; clock_in_at: string}> | null;
  photo?: Partial<{mime: string; sealed: Buffer | null; created_at: string; deleted_at: string | null; cpo_user_id: string; in_branch: boolean}> | null;
  insertReturns?: boolean;
  purgeReturns?: number;
}) {
  const calls: Cap[] = [];
  const db = {
    q: jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
      calls.push({sql, params});
      if (/INSERT INTO public\.attendance_checkin_photos/.test(sql)) {
        return Promise.resolve(opts.insertReturns === false ? [] : [{session_id: params?.[0]}]);
      }
      if (/SET sealed = NULL, deleted_at = NOW\(\)/.test(sql)) {
        return Promise.resolve(Array.from({length: opts.purgeReturns ?? 0}, (_, i) => ({session_id: `s${i}`})));
      }
      return Promise.resolve([]);
    }),
    qOne: jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
      calls.push({sql, params});
      if (/FROM public\.cpo_shift_sessions WHERE id = \$1/.test(sql)) {
        return Promise.resolve(opts.session === null ? null : {
          org_user_id: 'org-1', cpo_user_id: 'cpo-1', status: 'open', clock_in_at: new Date().toISOString(),
          ...(opts.session ?? {}),
        });
      }
      if (/FROM public\.attendance_checkin_photos p/.test(sql)) {
        return Promise.resolve(opts.photo === null ? null : opts.photo ?? null);
      }
      return Promise.resolve(null);
    }),
  };
  const config = {get: (k: string) => (k === 'totp.encryptionKey' ? ROOT : undefined)};
  const redis = {client: {}};
  const audit = {log: jest.fn().mockResolvedValue(undefined)};
  const svc = new AttendancePhotoService(db as never, config as never, redis as never, audit as never);
  return {svc, calls, audit};
}

describe('store — owner, open, in window, once', () => {
  it('seals a jpeg under the session and inserts once', async () => {
    const {svc, calls} = mk({});
    await expect(svc.store('ses-1', 'cpo-1', JPEG)).resolves.toEqual({stored: true});
    const ins = calls.find(c => /INSERT INTO public\.attendance_checkin_photos/.test(c.sql))!;
    expect(ins.sql).toMatch(/ON CONFLICT \(session_id\) DO NOTHING/);
    expect(ins.params?.slice(0, 5)).toEqual(['ses-1', 'org-1', 'cpo-1', 'image/jpeg', JPEG.length]);
    const sealed = ins.params?.[5] as Buffer;
    expect(Buffer.isBuffer(sealed)).toBe(true);
    // The row holds ciphertext, not the frame.
    expect(sealed.includes(Buffer.from('fake-jpeg-body'))).toBe(false);
    expect(openPhoto(sealed, derivePhotoKey(ROOT), 'ses-1').equals(JPEG)).toBe(true);
  });

  it.each([
    ['empty', Buffer.alloc(0), {}, BadRequestException],
    ['not an image', Buffer.from('hello'), {}, BadRequestException],
    ['too large', Buffer.concat([JPEG, Buffer.alloc(2 * 1024 * 1024)]), {}, BadRequestException],
    ['unknown session', JPEG, {session: null}, NotFoundException],
    ['someone else\'s session', JPEG, {session: {cpo_user_id: 'other'}}, ForbiddenException],
    ['closed session', JPEG, {session: {status: 'closed'}}, BadRequestException],
    ['window closed', JPEG, {session: {clock_in_at: new Date(Date.now() - 3600_000).toISOString()}}, BadRequestException],
    ['already stored', JPEG, {insertReturns: false}, BadRequestException],
  ] as Array<[string, Buffer, Parameters<typeof mk>[0], new (...a: never[]) => Error]>)('refuses: %s', async (_n, bytes, opts, err) => {
    const {svc} = mk(opts);
    await expect(svc.store('ses-1', 'cpo-1', bytes)).rejects.toBeInstanceOf(err);
  });
});

describe('read — branch-scoped, counted, audited', () => {
  const key = derivePhotoKey(ROOT);
  const live = () => ({mime: 'image/jpeg', sealed: sealPhoto(JPEG, key, 'ses-1'), created_at: '2026-09-05T00:00:00Z', deleted_at: null, cpo_user_id: 'cpo-1', in_branch: true});

  it('opens the photo for an in-branch manager, bumps the counter and writes the audit row', async () => {
    const {svc, calls, audit} = mk({photo: live()});
    const out = await svc.read('org-1', 'mgr-1', 'Ops', 'ses-1');
    expect(out.mime).toBe('image/jpeg');
    expect(out.bytes.equals(JPEG)).toBe(true);
    const sel = calls.find(c => /FROM public\.attendance_checkin_photos p/.test(c.sql))!;
    expect(sel.params).toEqual(['ses-1', 'org-1', 'Ops']);
    expect(sel.sql).toMatch(/COALESCE\(sh\.department, om\.department\) = \$3/);
    expect(calls.some(c => /SET view_count = view_count \+ 1/.test(c.sql))).toBe(true);
    expect(audit.log).toHaveBeenCalledWith('org-1', 'mgr-1', 'attendance.photo.view', expect.objectContaining({
      targetKind: 'shift_session', targetId: 'ses-1', metadata: {member_user_id: 'cpo-1'},
    }));
  });

  it('404s outside the branch, when purged, and when there is no row — never a different error', async () => {
    await expect(mk({photo: {...live(), in_branch: false}}).svc.read('org-1', 'm', 'Ops', 'ses-1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(mk({photo: {...live(), sealed: null, deleted_at: '2026-09-06T00:00:00Z'}}).svc.read('org-1', 'm', null, 'ses-1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(mk({photo: null}).svc.read('org-1', 'm', null, 'ses-1')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('purge — the one rule', () => {
  it('the predicate: review decided AND shift ended, or the hard TTL', () => {
    expect(PURGE_DUE_PREDICATE).toMatch(/ses\.review_status <> 'pending'/);
    expect(PURGE_DUE_PREDICATE).toMatch(/sh\.end_at < NOW\(\)/);
    expect(PURGE_DUE_PREDICATE).toMatch(/INTERVAL '30 days'/);
    expect(PURGE_DUE_PREDICATE).toMatch(/p\.deleted_at IS NULL/);
  });

  it('purgeIfDue and purgeDue both wipe the BYTES and stamp deleted_at, keeping the row', async () => {
    const {svc, calls} = mk({purgeReturns: 1});
    expect(await svc.purgeIfDue('ses-1')).toBe(true);
    expect(await svc.purgeDue()).toBe(1);
    for (const c of calls.filter(x => /attendance_checkin_photos p/.test(x.sql) && /UPDATE/.test(x.sql))) {
      expect(c.sql).toMatch(/SET sealed = NULL, deleted_at = NOW\(\)/);
      expect(c.sql).not.toMatch(/DELETE FROM/);
    }
  });
});
