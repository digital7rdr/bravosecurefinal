/**
 * PG-M4 — delivered / read receipts for rows OUTSIDE the hydrated window.
 *
 * `applyEnvelopeDelivered` and the read-receipt lane scan the in-memory
 * window and dropped anything older; the relay's delivered replay is
 * emit-then-delete, so those bubbles stayed on one tick forever. The fallback
 * loads the row by envelope id from SQL, applies the same aggregate, and
 * writes it back.
 *
 * The LAST describe is the anti-drift pin: the same inputs go through the
 * store action and through `receiptRow.ts`, and the results must agree.
 */
jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem:    async (k: string) => store.get(k) ?? null,
      setItem:    async (k: string, v: string) => { store.set(k, v); },
      removeItem: async (k: string) => { store.delete(k); },
      clear:      async () => { store.clear(); },
    },
  };
});

import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import type {LocalConversation, LocalMessage} from '../store/types';
import {hydratedEnvelopeMatch} from '../runtime/envelopeDelivered';
import {useMessengerStore} from '../store/messengerStore';
import {applyDeliveredToSql, applyReadReceiptsToSql, type ReceiptSql} from '../runtime/receiptSqlFallback';
import {applyDeliveredReceiptToRow, applyReadReceiptToRow} from '../runtime/receiptRow';

function ownRow(over: Partial<LocalMessage> = {}): LocalMessage {
  return {
    id: 'm-old', conversation_id: 'c1', sender_id: 'self', type: 'text', content: 'old',
    status: 'sent', is_encrypted: true, created_at: '2026-08-01T00:00:00.000Z',
    peer: {userId: 'bob', deviceId: 1}, envelope_id: 'env-old', ...over,
  };
}

function fakeSql(rows: LocalMessage[]): ReceiptSql & {written: LocalMessage[]} {
  const written: LocalMessage[] = [];
  return {
    written,
    findByEnvelopeId: async (id) => rows.find(r => r.envelope_id === id || Object.values(r.envelope_ids ?? {}).includes(id)) ?? null,
    upsertCoalesced:  (m) => { written.push(m); },
  };
}

function seedState(convs: Array<Partial<LocalConversation> & {id: string}>): ReturnType<typeof useMessengerStore.getState> {
  const s = useMessengerStore.getState();
  s.reset();
  s.setOwner('me');
  for (const c of convs) {
    s.upsertConversation({
      type: 'direct', participants: ['bob'], unread_count: 0, is_muted: false,
      created_at: '2026-08-01T00:00:00.000Z', peer: {userId: 'bob', deviceId: 1},
      session_state: 'established', ...c,
    } as LocalConversation);
  }
  return useMessengerStore.getState();
}

describe('PG-M4 — applyDeliveredToSql', () => {
  it('a direct row outside the window advances sent → delivered on the SQL copy', async () => {
    const state = seedState([{id: 'c1'}]);
    const sql = fakeSql([ownRow()]);
    expect(await applyDeliveredToSql('env-old', {sql, state})).toBe(1);
    expect(sql.written).toHaveLength(1);
    expect(sql.written[0].status).toBe('delivered');
  });

  it('a group leg receipt records the member and flips only when every shipped leg acked', async () => {
    const state = seedState([{id: 'g1', type: 'group', participants: ['me', 'bob', 'carol'], peer: undefined}]);
    const row = ownRow({conversation_id: 'g1', envelope_id: 'env-bob', envelope_ids: {bob: 'env-bob', carol: 'env-carol'}});
    const sql = fakeSql([row]);
    expect(await applyDeliveredToSql('env-bob', {sql, state})).toBe(0);      // one of two legs
    expect(sql.written[0].receipts?.bob?.status).toBe('delivered');
    expect(sql.written[0].status).toBe('sent');
    const sql2 = fakeSql([sql.written[0]]);
    expect(await applyDeliveredToSql('env-carol', {sql: sql2, state})).toBe(1); // second leg completes
    expect(sql2.written[0].status).toBe('delivered');
  });

  it('never regresses: a row already read stays read; unknown ids are a no-op', async () => {
    const state = seedState([{id: 'c1'}]);
    const sql = fakeSql([ownRow({status: 'read'})]);
    expect(await applyDeliveredToSql('env-old', {sql, state})).toBe(0);
    expect(sql.written).toHaveLength(0);
    expect(await applyDeliveredToSql('env-nope', {sql, state})).toBe(0);
  });
});

describe('PG-M4 — applyReadReceiptsToSql', () => {
  it('flips a direct row outside the window to read, with the same ownership guards', async () => {
    const state = seedState([{id: 'c1'}]);
    const sql = fakeSql([ownRow({status: 'delivered'})]);
    const n = await applyReadReceiptsToSql({envelopeIds: ['env-old'], receipterUid: 'bob', ts: 5}, {sql, state});
    expect(n).toBe(1);
    expect(sql.written[0].status).toBe('read');
    expect(sql.written[0].receipts?.bob).toEqual({status: 'read', ts: 5});
  });

  it('refuses a receipt from a peer the message did not travel through (BS-RR1)', async () => {
    const state = seedState([{id: 'c1'}]);
    const sql = fakeSql([ownRow({status: 'delivered'})]);
    const n = await applyReadReceiptsToSql({envelopeIds: ['env-old'], receipterUid: 'eve', ts: 5}, {sql, state});
    expect(n).toBe(0);
    expect(sql.written).toHaveLength(0);
  });

  it("refuses to receipt a row we did not send, and ignores ids that are not this receipter's leg", async () => {
    const state = seedState([{id: 'g1', type: 'group', participants: ['me', 'bob', 'carol'], peer: undefined}]);
    const theirs = ownRow({sender_id: 'bob', envelope_id: 'env-theirs'});
    const mine   = ownRow({conversation_id: 'g1', envelope_id: 'env-bob', envelope_ids: {bob: 'env-bob', carol: 'env-carol'}});
    const sql = fakeSql([theirs, mine]);
    // carol's receipt names bob's leg id → not her leg → refused.
    expect(await applyReadReceiptsToSql({envelopeIds: ['env-theirs', 'env-bob'], receipterUid: 'carol', ts: 5}, {sql, state})).toBe(0);
    expect(sql.written).toHaveLength(0);
  });
});

describe('PG-M4r — the fallback never touches a HYDRATED row (critic round)', () => {
  it('hydratedEnvelopeMatch answers for scalar AND leg ids — matched-but-not-flipped must not fall back', () => {
    const state = seedState([{id: 'g1', type: 'group', participants: ['me', 'bob', 'carol'], peer: undefined}]);
    state.appendMessage('g1', ownRow({conversation_id: 'g1', envelope_id: undefined, envelope_ids: {bob: 'env-bob', carol: 'env-carol'}}));
    expect(hydratedEnvelopeMatch('env-bob')).toBe(true);     // a leg id
    expect(hydratedEnvelopeMatch('env-carol')).toBe(true);
    expect(hydratedEnvelopeMatch('env-nope')).toBe(false);
  });

  it('isRowHydrated short-circuits the write (the 50 ms coalesce race)', async () => {
    const state = seedState([{id: 'c1'}]);
    const sql = fakeSql([ownRow()]);
    expect(await applyDeliveredToSql('env-old', {sql, state, isRowHydrated: () => true})).toBe(0);
    expect(sql.written).toHaveLength(0);
    const n = await applyReadReceiptsToSql({envelopeIds: ['env-old'], receipterUid: 'bob', ts: 5}, {sql, state, isRowHydrated: () => true});
    expect(n).toBe(0);
    expect(sql.written).toHaveLength(0);
  });

  it('the runtime gates the delivered fallback on hydratedEnvelopeMatch and passes a live isRowHydrated (source scan)', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'modules', 'messenger', 'runtime', 'productionRuntime.ts'), 'utf8').replace(/\r\n/g, '\n');
    expect(src).toMatch(/!flipped && deps\.sqlMessages && !hydratedEnvelopeMatch\(frame\.data\.envelopeId\)/);
    expect((src.match(/isRowHydrated: \(cid, id\) =>/g) ?? []).length).toBe(2);
  });
});

describe('PG-M4 — differential: receiptRow agrees with the store aggregate', () => {
  const cases: Array<{name: string; conv: Partial<LocalConversation> & {id: string}; row: LocalMessage; leg: string}> = [
    {name: 'direct delivered', conv: {id: 'c1'}, row: ownRow(), leg: 'bob'},
    {
      name: 'group partial (2 shipped, 1 acks)',
      conv: {id: 'g1', type: 'group', participants: ['me', 'bob', 'carol'], peer: undefined},
      row: ownRow({conversation_id: 'g1', envelope_ids: {bob: 'env-bob', carol: 'env-carol'}}),
      leg: 'bob',
    },
    {
      name: 'group complete (only shipped legs count)',
      conv: {id: 'g1', type: 'group', participants: ['me', 'bob', 'carol', 'dave'], peer: undefined},
      row: ownRow({conversation_id: 'g1', envelope_ids: {bob: 'env-bob', carol: 'env-carol'}, receipts: {carol: {status: 'read', ts: 1}}}),
      leg: 'bob',
    },
  ];

  for (const c of cases) {
    it(`delivered — ${c.name}`, () => {
      const state = seedState([c.conv]);
      state.appendMessage(c.row.conversation_id, c.row);
      state.recordDeliveredReceipt(c.row.conversation_id, c.row.id, c.leg, 7);
      const viaStore = useMessengerStore.getState().messages[c.row.conversation_id].find(m => m.id === c.row.id)!;
      const isGroup = c.conv.type === 'group';
      const participants = (c.conv.participants ?? []).filter(u => u !== 'me');
      const viaRow = applyDeliveredReceiptToRow(c.row, c.leg, 7, {isGroup, participants})!;
      expect(viaRow.status).toBe(viaStore.status);
      expect(viaRow.receipts).toEqual(viaStore.receipts);
    });

    it(`read — ${c.name}`, () => {
      const state = seedState([c.conv]);
      state.appendMessage(c.row.conversation_id, c.row);
      state.recordReadReceipts(c.row.conversation_id, [c.row.id], c.leg, 9);
      const viaStore = useMessengerStore.getState().messages[c.row.conversation_id].find(m => m.id === c.row.id)!;
      const isGroup = c.conv.type === 'group';
      const participants = (c.conv.participants ?? []).filter(u => u !== 'me');
      const viaRow = applyReadReceiptToRow(c.row, c.leg, 9, {isGroup, participants})!;
      expect(viaRow.status).toBe(viaStore.status);
      expect(viaRow.receipts).toEqual(viaStore.receipts);
    });
  }
});
