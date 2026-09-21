/**
 * B-867 — the identity document lane (ID / passport for every individual):
 *
 *  - sealing: a key derived for THIS purpose (never the check-in-photo key,
 *    never the raw root); the owner id + side is AAD, so a blob moved onto
 *    another user or swapped into the other slot refuses to open;
 *  - the gate: individuals with no row are refused with the machine code the
 *    app routes on; corporate/agent/ops accounts, submitted individuals, an
 *    unknown user (fail-open) and the ops kill-switch all pass;
 *  - submit: doc_type + a real image; a passport carries no back; the row is
 *    upserted WHOLE (front + back together) so a replace never half-applies;
 *  - ops read: images come back as data URLs, the view counter bumps and an
 *    ops_audit row lands on subject 'pii' — 404 when nothing is on file;
 *  - wiring: both spend paths (BookingService.create, ProApplicationsService
 *    .create) call the gate BEFORE any other refusal; /auth/me carries the
 *    status; the routes live where the app and the console look.
 */
import 'reflect-metadata';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {PATH_METADATA} from '@nestjs/common/constants';
import {BadRequestException, ForbiddenException, NotFoundException} from '@nestjs/common';
import {derivePhotoKey} from '../attendance/attendancePhotoCrypto';
import {deriveIdentityKey, openIdentityImage, sealIdentityImage} from './identityDocumentCrypto';
import {
  IDENTITY_DOCUMENT_REQUIRED, assertIdentityDocumentForBooking, identityGateEnabled, resolveIdentityDocument,
} from './identityGate';
import {IdentityDocumentService, MAX_IMAGE_BYTES} from './identity-document.service';
import {IdentityDocumentController} from './identity-document.controller';
import {OpsDataController} from '../ops/ops-data.controller';

const ROOT = 'a'.repeat(64);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('front-of-card')]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('back')]);
const USER = '11111111-1111-4111-8111-111111111111';

describe('identityDocumentCrypto', () => {
  it('derives its own purpose key — never the check-in photo key, never the root', () => {
    const k = deriveIdentityKey(ROOT);
    expect(k).toHaveLength(32);
    expect(k.equals(deriveIdentityKey(ROOT))).toBe(true);
    expect(k.equals(derivePhotoKey(ROOT))).toBe(false);
    expect(k.equals(Buffer.from(ROOT, 'hex'))).toBe(false);
    expect(() => deriveIdentityKey('nope')).toThrow(/64 hex/);
  });

  it('binds owner + side as AAD', () => {
    const key = deriveIdentityKey(ROOT);
    const sealed = sealIdentityImage(JPEG, key, USER, 'front');
    expect(openIdentityImage(sealed, key, USER, 'front').equals(JPEG)).toBe(true);
    expect(() => openIdentityImage(sealed, key, USER, 'back')).toThrow();
    expect(() => openIdentityImage(sealed, key, '22222222-2222-4222-8222-222222222222', 'front')).toThrow();
  });
});

function dbWith(row: Record<string, unknown> | undefined) {
  return {
    qOne: jest.fn().mockResolvedValue(row),
    q: jest.fn().mockResolvedValue([]),
  };
}

describe('identityGate', () => {
  const OLD = process.env.IDENTITY_DOCUMENT_GATE;
  afterEach(() => { if (OLD === undefined) delete process.env.IDENTITY_DOCUMENT_GATE; else process.env.IDENTITY_DOCUMENT_GATE = OLD; });

  it('refuses an individual with no document, with the code the app routes on', async () => {
    const db = dbWith({gated: true, has_doc: false, doc_type: null, submitted_at: null, has_back: null});
    await expect(assertIdentityDocumentForBooking(db as never, USER)).rejects.toMatchObject({
      response: {code: IDENTITY_DOCUMENT_REQUIRED},
    });
    await expect(assertIdentityDocumentForBooking(db as never, USER)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('passes a submitted individual, a non-individual, and an unknown user (fail-open)', async () => {
    await expect(assertIdentityDocumentForBooking(dbWith({gated: true, has_doc: true}) as never, USER)).resolves.toBeUndefined();
    await expect(assertIdentityDocumentForBooking(dbWith({gated: false, has_doc: false}) as never, USER)).resolves.toBeUndefined();
    await expect(assertIdentityDocumentForBooking(dbWith(undefined) as never, USER)).resolves.toBeUndefined();
  });

  it('the ops kill-switch lets bookings through without touching the db', async () => {
    process.env.IDENTITY_DOCUMENT_GATE = 'off';
    expect(identityGateEnabled()).toBe(false);
    const db = dbWith({gated: true, has_doc: false});
    await expect(assertIdentityDocumentForBooking(db as never, USER)).resolves.toBeUndefined();
    expect(db.qOne).not.toHaveBeenCalled();
    // And /auth/me reports the same truth the gate applies.
    const facts = await resolveIdentityDocument(dbWith({gated: true, has_doc: false}) as never, USER);
    expect(facts).toMatchObject({status: 'missing', required: false});
  });

  it('resolves status / required / type / date for /auth/me and the console', async () => {
    const facts = await resolveIdentityDocument(
      dbWith({gated: true, has_doc: true, doc_type: 'passport', submitted_at: '2026-09-12T10:00:00.000Z', has_back: false}) as never, USER);
    expect(facts).toEqual({status: 'submitted', required: true, doc_type: 'passport', submitted_at: '2026-09-12T10:00:00.000Z', has_back: false});
    const missing = await resolveIdentityDocument(dbWith({gated: false, has_doc: false, doc_type: null, submitted_at: null, has_back: null}) as never, USER);
    expect(missing).toEqual({status: 'missing', required: false, doc_type: null, submitted_at: null, has_back: false});
  });
});

function mkService(opts: {row?: Record<string, unknown> | null} = {}) {
  const calls: Array<{sql: string; params?: unknown[]}> = [];
  const db = {
    q: jest.fn().mockImplementation((sql: string, params?: unknown[]) => { calls.push({sql, params}); return Promise.resolve([]); }),
    qOne: jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
      calls.push({sql, params});
      if (/FROM public\.identity_documents d/.test(sql)) return Promise.resolve(opts.row ?? undefined);
      // The status read after a submit (identityGate's FACTS_SQL).
      if (/LEFT JOIN public\.identity_documents d/.test(sql)) {
        return Promise.resolve({gated: true, has_doc: true, doc_type: 'national_id', submitted_at: '2026-09-12T10:00:00.000Z', has_back: true});
      }
      return Promise.resolve(undefined);
    }),
  };
  const audit = {recordAdmin: jest.fn().mockResolvedValue(undefined)};
  const config = {get: jest.fn().mockReturnValue(ROOT)};
  const svc = new IdentityDocumentService(db as never, config as never, audit as never);
  return {svc, db, audit, calls};
}
const ADMIN = {user_id: 'adm-1', role: 'SUPERVISOR' as const, call_sign: 'OPS-7', region: 'AE'};

describe('IdentityDocumentService.submit', () => {
  it('validates before it writes: type, presence, size, magic bytes, passport-has-no-back', async () => {
    const {svc, db} = mkService();
    await expect(svc.submit(USER, 'driving_licence', JPEG, undefined)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.submit(USER, 'passport', undefined, undefined)).rejects.toMatchObject({message: 'front_missing'});
    await expect(svc.submit(USER, 'passport', Buffer.alloc(MAX_IMAGE_BYTES + 1, 0xff), undefined)).rejects.toMatchObject({message: 'front_too_large'});
    await expect(svc.submit(USER, 'passport', Buffer.from('<svg/>'), undefined)).rejects.toMatchObject({message: 'front_not_an_image'});
    await expect(svc.submit(USER, 'passport', JPEG, PNG)).rejects.toMatchObject({message: 'passport_has_no_back'});
    await expect(svc.submit(USER, 'national_id', JPEG, Buffer.from('not-an-image'))).rejects.toMatchObject({message: 'back_not_an_image'});
    expect(db.q).not.toHaveBeenCalled();
  });

  it('upserts the WHOLE row — front and back sealed under the owner + side AAD, plaintext never stored', async () => {
    const {svc, calls} = mkService();
    const facts = await svc.submit(USER, 'national_id', JPEG, PNG);
    const ins = calls.find(c => /INSERT INTO public\.identity_documents/.test(c.sql));
    expect(ins).toBeDefined();
    expect(ins!.sql).toMatch(/ON CONFLICT \(user_id\) DO UPDATE SET/);
    // A replace overwrites the back too (NULL for a passport), never leaves a stale one.
    expect(ins!.sql).toMatch(/back_sealed = EXCLUDED\.back_sealed/);
    const [uid, type, fMime, fLen, fSealed, bMime, bLen, bSealed] = ins!.params as [string, string, string, number, Buffer, string, number, Buffer];
    expect([uid, type, fMime, fLen, bMime, bLen]).toEqual([USER, 'national_id', 'image/jpeg', JPEG.length, 'image/png', PNG.length]);
    expect(fSealed.includes(Buffer.from('front-of-card'))).toBe(false);
    const key = deriveIdentityKey(ROOT);
    expect(openIdentityImage(fSealed, key, USER, 'front').equals(JPEG)).toBe(true);
    expect(openIdentityImage(bSealed, key, USER, 'back').equals(PNG)).toBe(true);
    expect(facts.status).toBe('submitted');
  });

  it('a passport stores a NULL back side', async () => {
    const {svc, calls} = mkService();
    await svc.submit(USER, 'passport', JPEG, undefined);
    const ins = calls.find(c => /INSERT INTO public\.identity_documents/.test(c.sql))!;
    expect(ins.params!.slice(5)).toEqual([null, null, null]);
  });
});

describe('IdentityDocumentService.readForOps', () => {
  it('404s when nothing is on file and writes no audit', async () => {
    const {svc, audit} = mkService({row: null});
    await expect(svc.readForOps(ADMIN, USER)).rejects.toBeInstanceOf(NotFoundException);
    expect(audit.recordAdmin).not.toHaveBeenCalled();
  });

  it('opens both sides as data URLs, bumps the view counter and audits on subject pii', async () => {
    const key = deriveIdentityKey(ROOT);
    const {svc, audit, calls} = mkService({row: {
      doc_type: 'national_id', front_mime: 'image/jpeg', front_sealed: sealIdentityImage(JPEG, key, USER, 'front'),
      back_mime: 'image/png', back_sealed: sealIdentityImage(PNG, key, USER, 'back'),
      submitted_at: '2026-09-12T10:00:00.000Z', view_count: 2,
    }});
    const out = await svc.readForOps(ADMIN, USER);
    expect(out.doc_type).toBe('national_id');
    expect(out.view_count).toBe(3);
    expect(out.images.map(i => i.side)).toEqual(['front', 'back']);
    expect(out.images[0].data_url).toBe(`data:image/jpeg;base64,${JPEG.toString('base64')}`);
    expect(out.images[1].data_url).toBe(`data:image/png;base64,${PNG.toString('base64')}`);
    expect(calls.some(c => /SET view_count = view_count \+ 1/.test(c.sql))).toBe(true);
    expect(audit.recordAdmin).toHaveBeenCalledWith(ADMIN, 'identity_document.view', 'pii', USER, {doc_type: 'national_id', sides: 2});
    // ids only — the bytes never ride the audit row.
    const meta = JSON.stringify(audit.recordAdmin.mock.calls[0][4]);
    expect(meta).not.toMatch(/base64|front-of-card/);
  });

  it('is FAIL-CLOSED: the audit row lands BEFORE any byte is opened, and a failed audit discloses nothing', async () => {
    const key = deriveIdentityKey(ROOT);
    const {svc, audit, calls} = mkService({row: {
      doc_type: 'passport', front_mime: 'image/jpeg', front_sealed: sealIdentityImage(JPEG, key, USER, 'front'),
      back_mime: null, back_sealed: null, submitted_at: '2026-09-12T10:00:00.000Z', view_count: 0,
    }});
    audit.recordAdmin.mockRejectedValueOnce(new Error('audit insert failed'));
    await expect(svc.readForOps(ADMIN, USER)).rejects.toThrow(/audit insert failed/);
    expect(calls.some(c => /SET view_count = view_count \+ 1/.test(c.sql))).toBe(false);
    // The action is in the fail-closed set, so the real OpsAuditService re-throws too.
    const auditSrc = readFileSync(join(__dirname, '..', 'ops', 'ops-audit.service.ts'), 'utf8');
    const critical = auditSrc.slice(auditSrc.indexOf('CRITICAL_ACTIONS = new Set'), auditSrc.indexOf(']);', auditSrc.indexOf('CRITICAL_ACTIONS = new Set')));
    expect(critical).toMatch(/'identity_document\.view'/);
  });

  it('refuses an erased account (the read joins users.deleted_at IS NULL) and erasure deletes the row', () => {
    const read = body(src('identity/identity-document.service.ts'), /async readForOps\(/);
    expect(read).toMatch(/JOIN public\.users u ON u\.id = d\.user_id AND u\.deleted_at IS NULL/);
    const erase = body(src('ops/ops-data.service.ts'), /async eraseUser\(adminId: string, userId: string, reason: string\)/);
    expect(erase).toMatch(/DELETE FROM public\.identity_documents WHERE user_id = \$1/);
  });

  it('a passport (no back) yields one image', async () => {
    const key = deriveIdentityKey(ROOT);
    const {svc} = mkService({row: {
      doc_type: 'passport', front_mime: 'image/jpeg', front_sealed: sealIdentityImage(JPEG, key, USER, 'front'),
      back_mime: null, back_sealed: null, submitted_at: '2026-09-12T10:00:00.000Z', view_count: 0,
    }});
    const out = await svc.readForOps(ADMIN, USER);
    expect(out.images).toHaveLength(1);
  });
});

describe('routes', () => {
  it('owner surface lives at users/me/identity-document (GET status, POST submit)', () => {
    expect(Reflect.getMetadata(PATH_METADATA, IdentityDocumentController)).toBe('users/me/identity-document');
    expect(Reflect.getMetadata(PATH_METADATA, IdentityDocumentController.prototype.status)).toBe('/');
    expect(Reflect.getMetadata(PATH_METADATA, IdentityDocumentController.prototype.submit)).toBe('/');
  });

  it('the owner surface is throttled per USER (UserThrottlerGuard bound after JwtAuthGuard)', () => {
    const guards = (Reflect.getMetadata('__guards__', IdentityDocumentController) as Array<{name: string}>).map(g => g.name);
    expect(guards).toEqual(['JwtAuthGuard', 'UserThrottlerGuard']);
  });

  it('the ops read hangs off the user detail path, on its own route', () => {
    expect(Reflect.getMetadata(PATH_METADATA, OpsDataController.prototype.getUserIdentityDocument)).toBe('users/:id/identity-document');
  });
});

// ─── Wiring scans (no test constructs the real spend services end-to-end) ──
// Comments stripped, CRLF-tolerant, anchored INSIDE the executing function.
function src(rel: string): string {
  return readFileSync(join(__dirname, '..', rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/\r\n/g, '\n');
}
function body(all: string, head: RegExp): string {
  const m = head.exec(all);
  if (!m) throw new Error(`function head not found: ${head}`);
  return all.slice(m.index, m.index + 4000);
}

describe('wiring', () => {
  it('BookingService.create gates FIRST — before the tier gate and the open-bookings cap', () => {
    const b = body(src('booking/booking.service.ts'), /async create\(\s*clientId: string, dto: CreateBookingDto/);
    const gate = b.indexOf('await assertIdentityDocumentForBooking(this.db, clientId)');
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(b.indexOf("dto.type === 'itinerary'"));
  });

  it('ProApplicationsService.create gates FIRST', () => {
    const b = body(src('pro-applications/pro-applications.service.ts'), /async create\(userId: string, dto: CreateProApplicationDto\)/);
    const gate = b.indexOf('await assertIdentityDocumentForBooking(this.db, userId)');
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(b.indexOf("dto.intended_use === 'custom'"));
  });

  it('/auth/me carries identity_document_status + identity_document_required from the same resolver', () => {
    const b = body(src('auth/auth.service.ts'), /async getMe\(userId: string\)/);
    expect(b).toMatch(/resolveIdentityDocument\(this\.db, userId\)/);
    expect(b).toMatch(/identity_document_status: identityDoc\.status/);
    expect(b).toMatch(/identity_document_required: identityDoc\.required/);
  });

  it('/auth/me and the console detail read are best-effort — an unreachable table never 500s a boot', () => {
    const me = body(src('auth/auth.service.ts'), /async getMe\(userId: string\)/);
    expect(me).toMatch(/resolveIdentityDocument\(this\.db, userId\)\.catch\(\(\) => IDENTITY_FACTS_UNKNOWN\)/);
    const detail = body(src('ops/ops-data.service.ts'), /async getUserDetail\(userId: string\)/);
    expect(detail).toMatch(/resolveIdentityDocument\(this\.db, userId\)\.catch\(\(\) => IDENTITY_FACTS_UNKNOWN\)/);
    // The booking gate itself stays HARD — no catch around the assert.
    const create = body(src('booking/booking.service.ts'), /async create\(\s*clientId: string, dto: CreateBookingDto/);
    expect(create).toMatch(/await assertIdentityDocumentForBooking\(this\.db, clientId\);/);
    expect(create).not.toMatch(/assertIdentityDocumentForBooking\(this\.db, clientId\)\.catch/);
  });

  it('the user detail body carries facts only — the images have their own audited route', () => {
    const b = body(src('ops/ops-data.service.ts'), /async getUserDetail\(userId: string\)/);
    expect(b).toMatch(/resolveIdentityDocument\(this\.db, userId\)/);
    expect(b).not.toMatch(/front_sealed|data_url/);
  });
});
