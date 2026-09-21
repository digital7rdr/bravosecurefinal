import {BadRequestException, NotFoundException} from '@nestjs/common';
import {promises as fsp} from 'node:fs';
import {join} from 'node:path';
import {AgentService} from './agent.service';
import {AgentStateMachine} from './state-machine.service';
import type {AgentStatus} from './state-machine.service';
import type {DocSlot} from './dto/agent.dto';
import type {DatabaseService} from '../database/database.service';
import type {RedisService} from '../redis/redis.service';
import type {CpoAssignmentService} from '../booking/assignment/cpo-assignment.service';
import type {WalletService} from '../wallet/wallet.service';
import type {DepartmentService} from '../department/department.service';
import type {ProofOfCompletionService} from './proof-of-completion.service';
import type {ConfigService} from '@nestjs/config';

/**
 * B-823 — an agent must be able to remove a compliance-pack document they
 * uploaded by mistake. The reset has to undo every trace of the old evidence
 * (the doc row, the mirrored KYC check, the reviewed 'docs' pipeline step and
 * the bytes on disk) WITHOUT walking the agent status backwards, and it must
 * refuse once ops has verified the officer.
 */
const HOST = 'http://host';
const FILE_URL = `${HOST}/uploads/u1/123-passport.pdf`;

interface Call {sql: string; params: unknown[]}

const doneDoc = (over: Record<string, unknown> = {}) => ({
  id: 'd1', user_id: 'u1', slot: 'passport', required: true,
  title: 'Passport / National ID', state: 'done', file_url: FILE_URL,
  uploaded_at: new Date(), reviewed_at: null, reviewer_id: null, ...over,
});

function mk(opts: {
  status?: AgentStatus;
  doc?: Record<string, unknown> | null;
  docRefs?: string;
  kycRefs?: string;
} = {}) {
  const status = opts.status ?? 'DOCS_PENDING';
  const doc = opts.doc === undefined ? doneDoc() : opts.doc;
  const calls: Call[] = [];

  const q = jest.fn().mockImplementation((sql: string, params: unknown[] = []) => {
    calls.push({sql, params});
    return Promise.resolve([]);
  });

  const qOne = jest.fn().mockImplementation((sql: string, params: unknown[] = []) => {
    calls.push({sql, params});
    if (/SELECT \* FROM agents/.test(sql)) {
      return Promise.resolve({user_id: 'u1', status});
    }
    if (/COUNT\(\*\)::text AS n FROM agent_documents/.test(sql)) {
      return Promise.resolve({n: opts.docRefs ?? '0'});
    }
    if (/COUNT\(\*\)::text AS n FROM agent_kyc_checks/.test(sql)) {
      return Promise.resolve({n: opts.kycRefs ?? '0'});
    }
    if (/SELECT \* FROM agent_documents/.test(sql)) {
      return Promise.resolve(doc);
    }
    if (/UPDATE agent_documents/.test(sql)) {
      return Promise.resolve(
        doc ? {...doc, state: 'upload', file_url: null, reviewed_at: null} : null,
      );
    }
    return Promise.resolve(null);
  });

  const svc = new AgentService(
    {q, qOne} as unknown as DatabaseService, new AgentStateMachine(),
    {} as unknown as RedisService, {} as unknown as CpoAssignmentService,
    {} as unknown as WalletService, {} as unknown as DepartmentService,
    {} as unknown as ProofOfCompletionService, {get: () => 0} as unknown as ConfigService,
  );
  return {svc, calls};
}

const matching = (calls: Call[], re: RegExp) => calls.filter(c => re.test(c.sql));

let unlink: jest.SpyInstance;
let prevBase: string | undefined;

beforeEach(() => {
  prevBase = process.env.PUBLIC_BASE_URL;
  process.env.PUBLIC_BASE_URL = HOST;
  unlink = jest.spyOn(fsp, 'unlink').mockResolvedValue(undefined);
});

afterEach(() => {
  unlink.mockRestore();
  if (prevBase === undefined) {delete process.env.PUBLIC_BASE_URL;}
  else {process.env.PUBLIC_BASE_URL = prevBase;}
});

describe('AgentService.removeDocument — B-823', () => {
  it('(a) resets every evidence column and un-mirrors the matching KYC check', async () => {
    const {svc, calls} = mk();
    const out = await svc.removeDocument('u1', 'passport');
    expect(out.document.state).toBe('upload');

    const [reset] = matching(calls, /UPDATE agent_documents/);
    expect(reset).toBeDefined();
    expect(reset.sql).toMatch(/state = 'upload'/);
    for (const col of [
      'file_url', 'file_hash_sha256', 'uploaded_at',
      'reviewed_at', 'reviewer_id', 'expires_at', 'issuing_body',
    ]) {
      expect(reset.sql).toMatch(new RegExp(`${col} = NULL`));
    }
    expect(reset.params).toEqual(['u1', 'passport']);

    const [unmirror] = matching(calls, /UPDATE agent_kyc_checks/);
    expect(unmirror).toBeDefined();
    expect(unmirror.sql).toMatch(/state = 'queued'/);
    // Only when the check still points at THIS file — an ops-uploaded
    // replacement must survive the agent removing their own copy.
    expect(unmirror.sql).toMatch(/file_url = \$3/);
    expect(unmirror.params).toEqual(['u1', 'gov_id', FILE_URL]);

    // The FSM never walks backwards.
    expect(matching(calls, /UPDATE agents SET status/)).toHaveLength(0);
  });

  it('(a2) a slot with no KYC twin skips the un-mirror', async () => {
    const {svc, calls} = mk({doc: doneDoc({slot: 'insurance'})});
    await svc.removeDocument('u1', 'insurance');
    expect(matching(calls, /UPDATE agent_kyc_checks/)).toHaveLength(0);
  });

  it('(b) a REVIEWED document reopens the docs review step; an unreviewed one does not', async () => {
    const reviewed = mk({doc: doneDoc({reviewed_at: new Date()})});
    await reviewed.svc.removeDocument('u1', 'passport');
    const [reopen] = matching(reviewed.calls, /UPDATE agent_review_pipeline/);
    expect(reopen).toBeDefined();
    expect(reopen.sql).toMatch(/state = 'in_progress'/);
    expect(reopen.sql).toMatch(/settled_at = NULL/);
    expect(reopen.sql).toMatch(/step = 'docs' AND state = 'done'/);

    const fresh = mk();
    await fresh.svc.removeDocument('u1', 'passport');
    expect(matching(fresh.calls, /UPDATE agent_review_pipeline/)).toHaveLength(0);
  });

  it('(c) a verified officer cannot self-service their evidence', async () => {
    for (const status of ['APPROVED', 'ACTIVE'] as AgentStatus[]) {
      const {svc, calls} = mk({status});
      await expect(svc.removeDocument('u1', 'passport')).rejects.toThrow(BadRequestException);
      await expect(svc.removeDocument('u1', 'passport')).rejects.toThrow(/document_locked/);
      expect(matching(calls, /UPDATE agent_documents/)).toHaveLength(0);
      expect(unlink).not.toHaveBeenCalled();
    }
  });

  it('(c2) every pre-approval status may remove', async () => {
    for (const status of [
      'DRAFT', 'PROFILE_COMPLETE', 'KYC_PENDING', 'DOCS_PENDING',
      'SUBMITTED', 'UNDER_REVIEW', 'REJECTED',
    ] as AgentStatus[]) {
      const {svc, calls} = mk({status});
      await expect(svc.removeDocument('u1', 'passport')).resolves.toBeDefined();
      expect(matching(calls, /UPDATE agent_documents/)).toHaveLength(1);
    }
  });

  it('(d) an empty slot is an idempotent no-op that returns the row', async () => {
    const {svc, calls} = mk({doc: doneDoc({state: 'upload', file_url: null})});
    const out = await svc.removeDocument('u1', 'passport');
    expect(out.document.state).toBe('upload');
    expect(matching(calls, /UPDATE agent_documents/)).toHaveLength(0);
    expect(unlink).not.toHaveBeenCalled();
  });

  it('(d2) a slot that does not exist is a 404', async () => {
    const {svc} = mk({doc: null});
    await expect(svc.removeDocument('u1', 'passport')).rejects.toThrow(NotFoundException);
  });

  it('(e) an unknown slot is refused before any read', async () => {
    const {svc, calls} = mk();
    await expect(svc.removeDocument('u1', 'selfie' as DocSlot)).rejects.toThrow(/invalid_slot/);
    expect(calls).toHaveLength(0);
  });

  it('(f) the bytes are unlinked only for OUR unreferenced upload', async () => {
    const own = mk();
    await own.svc.removeDocument('u1', 'passport');
    expect(unlink).toHaveBeenCalledWith(join(process.cwd(), 'uploads', 'u1', '123-passport.pdf'));

    unlink.mockClear();
    const other = mk({doc: doneDoc({file_url: `${HOST}/uploads/u2/123-passport.pdf`})});
    await other.svc.removeDocument('u1', 'passport');
    expect(unlink).not.toHaveBeenCalled();

    unlink.mockClear();
    const external = mk({doc: doneDoc({file_url: 'https://cdn.example.com/uploads/u1/123-passport.pdf'})});
    await external.svc.removeDocument('u1', 'passport');
    expect(unlink).not.toHaveBeenCalled();

    unlink.mockClear();
    const stillKyc = mk({kycRefs: '1'});
    await stillKyc.svc.removeDocument('u1', 'passport');
    expect(unlink).not.toHaveBeenCalled();

    unlink.mockClear();
    const stillDoc = mk({docRefs: '1'});
    await stillDoc.svc.removeDocument('u1', 'passport');
    expect(unlink).not.toHaveBeenCalled();
  });

  it('(g) a traversal segment never reaches unlink', async () => {
    for (const url of [
      `${HOST}/uploads/u1/%2e%2e%2f%2e%2e%2fetc%2fpasswd`,
      `${HOST}/uploads/u1/..`,
      `${HOST}/uploads/u1/a/b.pdf`,
      'not a url at all',
    ]) {
      unlink.mockClear();
      const {svc} = mk({doc: doneDoc({file_url: url})});
      await expect(svc.removeDocument('u1', 'passport')).resolves.toBeDefined();
      expect(unlink).not.toHaveBeenCalled();
    }
  });

  it('(h) an unlink failure never fails the request', async () => {
    unlink.mockRejectedValue(Object.assign(new Error('ENOENT'), {code: 'ENOENT'}));
    const {svc} = mk();
    await expect(svc.removeDocument('u1', 'passport')).resolves.toBeDefined();
  });
});
