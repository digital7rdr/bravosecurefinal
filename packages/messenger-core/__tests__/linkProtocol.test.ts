import {
  linkCipher, encodeLinkQr, parseLinkQr, newLinkKey, chunkRows, LinkReplayGuard,
  b64uEncode, b64uDecode, type LinkMessage, type LinkMsgRow,
} from '../src/link/linkProtocol';

const LINK = 'AAAAAAAAAAAAAAAAAAAAAA';

describe('link protocol', () => {
  it('QR round-trips and rejects junk', () => {
    const key = newLinkKey();
    const qr = encodeLinkQr(LINK, key);
    expect(qr.startsWith('bravo-link:1:')).toBe(true);
    const p = parseLinkQr(qr)!;
    expect(p.linkId).toBe(LINK);
    expect(Array.from(p.key)).toEqual(Array.from(key));
    expect(parseLinkQr('https://evil.example')).toBeNull();
    expect(parseLinkQr(`bravo-link:1:${LINK}:short`)).toBeNull();
    expect(parseLinkQr(`${qr}:extra`)).toBeNull();
  });

  it('base64url round-trips', () => {
    const b = new Uint8Array([0, 255, 62, 63, 1, 2, 3]);
    expect(Array.from(b64uDecode(b64uEncode(b)))).toEqual(Array.from(b));
  });

  it('seals and opens per direction; wrong key, direction or link fails closed', async () => {
    const key = newLinkKey();
    const a = await linkCipher(LINK, key);
    const b = await linkCipher(LINK, key);
    const msg: LinkMessage = {t: 'send', id: 'm1', ts: 1, ref: 'r1', peerUserId: 'p', text: 'hi ✓'};
    const item = await a.seal('w2p', msg);
    expect(item.startsWith('lnk1.')).toBe(true);
    expect(await b.open('w2p', item)).toEqual(msg);
    expect(await b.open('p2w', item)).toBeNull();
    const other = await linkCipher(LINK, newLinkKey());
    expect(await other.open('w2p', item)).toBeNull();
    const otherLink = await linkCipher('BBBBBBBBBBBBBBBBBBBBBB', key);
    expect(await otherLink.open('w2p', item)).toBeNull();
    // Flip one ciphertext character to a DIFFERENT one (the old version could
    // pick the character already there, ~1 run in 64, and "tamper" nothing).
    const at = Math.floor(item.length / 2);
    const tampered = item.slice(0, at) + (item[at] === 'A' ? 'B' : 'A') + item.slice(at + 1);
    expect(tampered).not.toBe(item);
    expect(await b.open('w2p', tampered)).toBeNull();
    expect(await b.open('w2p', 'garbage')).toBeNull();
    for (let i = 0; i < 50; i++) {
      const it = await a.seal('w2p', {...msg, id: `m${i}`});
      for (const pos of [5, Math.floor(it.length / 2), it.length - 2]) {
        const t = it.slice(0, pos) + (it[pos] === 'A' ? 'B' : 'A') + it.slice(pos + 1);
        expect(await b.open('w2p', t)).toBeNull();
      }
    }
  });

  it('chunks rows under the cap', () => {
    const rows: LinkMsgRow[] = Array.from({length: 50}, (_, i) => ({id: `m${i}`, dir: 'in', body: 'x'.repeat(100), at: i, status: 'read'}));
    const chunks = chunkRows(rows, 1000);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flat()).toEqual(rows);
    for (const c of chunks) expect(JSON.stringify(c).length).toBeLessThan(1200);
  });

  it('replay guard applies an id once', () => {
    const g = new LinkReplayGuard(2);
    expect(g.fresh('a')).toBe(true);
    expect(g.fresh('a')).toBe(false);
    g.fresh('b'); g.fresh('c');
    expect(g.fresh('a')).toBe(true);
  });
});
