/**
 * 2026-10-30 — owner requests (app side):
 *  1. groups: make / dismiss group admins (WhatsApp-style)
 *  2. no "LITE" chip on Secure Services
 *  5. Messenger footer: CHANNELS and CONTACTS no longer overlap; unread counts
 *     on the Chats and Channels tabs
 *  8. password reset asks for the email when texts are not set up
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const read = (...p: string[]): string => readFileSync(join(process.cwd(), ...p), 'utf8').replace(/\r\n/g, '\n');
const strip = (src: string): string => src
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map(l => l.replace(/(^|\s)\/\/.*$/, '$1')).join('\n');

describe('1 — group admins', () => {
  const info = strip(read('src/screens/messenger/ChatInfoScreen.tsx'));
  it('an admin can make a member an admin, or dismiss one (never the creator)', () => {
    expect(info).toMatch(/text: 'Make group admin'/);
    expect(info).toMatch(/\} else if \(m\.userId !== groupState\?\.owner\) \{\s*buttons\.push\(\{text: 'Dismiss as admin'/);
    expect(info).toMatch(/fn\(\{groupId: conversationId, userId, admin\}\)/);
  });
  it('the runtime sends it as a rename carrying `admins` (older phones stay in epoch step)', () => {
    const rt = read('src/modules/messenger/runtime/productionRuntime.ts');
    expect(rt).toMatch(/setGroupAdmin: async \(\{groupId, userId, admin\}\)/);
    expect(rt).toMatch(/\{type: 'rename' as const, name: cur\.name, atEpoch: cur\.epoch, admins: \[\{userId, admin\}\]\}/);
  });
});

describe('2 — no "LITE" on Secure Services', () => {
  it('the Secure Services header shows PRO for a Pro plan and nothing otherwise', () => {
    const src = strip(read('src/screens/booking/BookingHomeScreen.tsx'));
    expect(src).not.toMatch(/>LITE</);
    expect(src).toMatch(/'PRO · MEMBER' : 'PRO'/);
  });
});

describe('5 — Messenger footer', () => {
  it('labels are upper-cased in the string (Android measured the transform in the original case)', () => {
    const src = strip(read('src/screens/messenger/MessengerTabBar.tsx'));
    expect(src).toMatch(/text=\{tab\.label\.toUpperCase\(\)\}/);
    expect(src).not.toMatch(/textTransform: 'uppercase'/);
    expect(src).toMatch(/labelClip: \{alignSelf: 'stretch', minWidth: 0, overflow: 'hidden'\}/);
  });

  it('counts unread behind Chats (not muted) and Channels (department conversations)', () => {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const {messengerTabCounts} = require('@screens/messenger/MessengerTabBar') as typeof import('@screens/messenger/MessengerTabBar');
      const counts = messengerTabCounts({
        'direct:a': {unread_count: 3},
        'direct:b': {unread_count: 2, is_muted: true},
        g1: {unread_count: 4},
        dept1: {unread_count: 5},
        dept2: {unread_count: 0},
      }, {deptConversationIds: {dept1: true, dept2: true}, deptGroupByChannel: {}});
      expect(counts).toEqual({chats: 7, channels: 5});
    });
  });
});

describe('8 — password reset', () => {
  it('asks for the email address when the server says texts are off', () => {
    const src = strip(read('src/screens/auth/ForgotPasswordScreen.tsx'));
    expect(src).toMatch(/if \(r\.sms === false && r\.email === true\) \{setEmailOnly\(true\);\}/);
    expect(src).toMatch(/if \(emailOnly && !identifier\.includes\('@'\)\)/);
  });
});
