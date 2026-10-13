/**
 * "Share to Bravo" (2026-10-13) — the share payload from BravoShareIntentModule
 * becomes chat-tray assets: kinds by MIME, app-owned copies marked ephemeral
 * (deleted after send / on cancel), content:// or foreign paths refused, text
 * kept, the 10-item cap, and a readable header line.
 */
jest.mock('react-native', () => ({
  Platform: {OS: 'android'},
  NativeModules: {},
  NativeEventEmitter: class {},
}));

import {normalizeShare, kindForMime, describeShare} from '../share/incomingShare';

describe('incoming share', () => {
  it('maps a screenshot to an ephemeral image asset', () => {
    const s = normalizeShare({items: [{uri: 'file:///data/user/0/com.bravosecure.app/cache/share-in/a.png', mimeType: 'image/png', name: 'Screenshot_1.png', size: 1000}]});
    expect(s).toEqual({text: null, items: [{
      uri: 'file:///data/user/0/com.bravosecure.app/cache/share-in/a.png', mime: 'image/png', kind: 'image',
      meta: {name: 'Screenshot_1.png'}, ephemeralSource: true,
    }]});
    expect(describeShare(s!)).toBe('1 photo');
  });

  it('kinds by MIME', () => {
    expect(kindForMime('video/mp4')).toBe('video');
    expect(kindForMime('audio/mpeg')).toBe('audio');
    expect(kindForMime('application/pdf')).toBe('file');
    expect(kindForMime('image/jpeg')).toBe('image');
  });

  it('keeps text, joins a subject, and ignores anything that is not a local copy', () => {
    const s = normalizeShare({text: 'https://example.com/a', subject: 'Look at this', items: [{uri: 'content://evil/1', mimeType: 'image/png'}]});
    expect(s).toEqual({text: 'Look at this\nhttps://example.com/a', items: []});
    expect(describeShare(s!)).toBe('a message');
  });

  it('nothing shared → null', () => {
    expect(normalizeShare(null)).toBeNull();
    expect(normalizeShare({text: '  ', items: []})).toBeNull();
  });

  it('caps at 10 items and describes a mix', () => {
    const items = Array.from({length: 12}, (_, i) => ({uri: `file:///c/share-in/${i}.jpg`, mimeType: i === 0 ? 'application/pdf' : 'image/jpeg'}));
    const s = normalizeShare({items})!;
    expect(s.items).toHaveLength(10);
    expect(describeShare(s)).toBe('9 photos and 1 document');
  });
});
