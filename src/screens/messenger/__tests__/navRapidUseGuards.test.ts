/**
 * NAV-04/05/15/18/19/22 (2026-08-26 back-navigation & rapid-use audit) —
 * messenger-side pins. These screens mount RN trees the node project cannot
 * import, so the pins are comment-stripped source scans (house rules: files
 * are CRLF — normalize first; strip comments so prose can never satisfy or
 * defeat an assertion; anchor at the decision site).
 */
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {join} from 'node:path';

const ROOT = process.cwd();
const read = (p: string) =>
  readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const HOME  = 'src/screens/messenger/MessengerHomeScreen.tsx';
const FILES = 'src/screens/messenger/FilesScreen.tsx';
const GROUPS = 'src/screens/messenger/GroupsScreen.tsx';
const CHAT  = 'src/screens/messenger/ChatScreen.tsx';
const DEPT  = 'src/screens/messenger/DepartmentChatScreen.tsx';
const CONFIRMATION = 'src/screens/booking/BookingConfirmationScreen.tsx';
const ACCEPTED = 'src/screens/booking/AgencyAcceptedScreen.tsx';

/**
 * NAV-04/NAV-05 — every BackHandler registration in a screen that stays
 * mounted under pushed routes must be FOCUS-scoped. RN dispatches
 * hardwareBackPress LIFO, none of the pushed screens registers a handler, so
 * a mount-scoped (useEffect) handler here SWALLOWS the first back press on
 * every screen above it — the client's "back button does nothing" verbatim.
 *
 * The scan: for each `BackHandler.addEventListener` site, the nearest
 * preceding hook opener must be `useFocusEffect`, never `useEffect`.
 */
function assertBackHandlersFocusScoped(file: string) {
  const src = strip(read(file));
  const sites: number[] = [];
  let at = src.indexOf('BackHandler.addEventListener');
  while (at !== -1) {
    sites.push(at);
    at = src.indexOf('BackHandler.addEventListener', at + 1);
  }
  expect(sites.length).toBeGreaterThan(0); // control: the handlers exist
  for (const site of sites) {
    const before = src.slice(0, site);
    const lastFocus = before.lastIndexOf('useFocusEffect(');
    const lastPlain = before.lastIndexOf('useEffect(');
    expect(lastFocus).toBeGreaterThan(-1);
    // `useFocusEffect(` contains no `useEffect(` substring, so the two
    // indexes are independent; the focus opener must be the nearer one.
    expect(lastFocus).toBeGreaterThan(lastPlain);
  }
}

/**
 * B-872/N2 — the two hard-coded entries above missed BookingConfirmation and
 * AgencyAccepted, each of which registers a `popToTop` handler mount-scoped
 * and therefore answered for Invoice / SOS pushed on top of it. The scan now
 * ENUMERATES every screen source, so the next one cannot slip in either.
 */
const SCREENS_DIR = 'src/screens';

/**
 * The ONLY legitimate mount-scoped registrations in the tree: the two
 * full-screen call surfaces. Back there means "minimize the live call", they
 * own the whole screen for the call's lifetime, and their handler defers to an
 * open Modal's own onRequestClose rather than to a pushed route. Anything else
 * added here needs the same written justification.
 */
const MOUNT_SCOPED_BY_DESIGN = new Set([
  'src/screens/messenger/CallScreen.tsx',
  'src/screens/messenger/GroupCallScreen.tsx',
]);

function listSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir))) {
    if (entry === '__tests__' || entry === '__mocks__') {continue;}
    const rel = `${dir}/${entry}`;
    if (statSync(join(ROOT, rel)).isDirectory()) {
      out.push(...listSources(rel));
    } else if (/\.tsx?$/.test(entry)) {
      out.push(rel);
    }
  }
  return out;
}

const BACK_HANDLER_FILES = listSources(SCREENS_DIR).filter(f =>
  strip(read(f)).includes('BackHandler.addEventListener'),
);

describe('NAV-04/05 + B-872/N2 — EVERY screen registers hardware back FOCUS-scoped', () => {
  it('the enumeration actually found the known registrations (control)', () => {
    // A broken walker would make every case below pass vacuously.
    expect(BACK_HANDLER_FILES.length).toBeGreaterThanOrEqual(15);
    expect(BACK_HANDLER_FILES).toContain(HOME);
    expect(BACK_HANDLER_FILES).toContain(FILES);
    expect(BACK_HANDLER_FILES).toContain(CONFIRMATION);
    expect(BACK_HANDLER_FILES).toContain(ACCEPTED);
  });

  it.each(BACK_HANDLER_FILES.filter(f => !MOUNT_SCOPED_BY_DESIGN.has(f)))('%s', file => {
    assertBackHandlersFocusScoped(file);
  });

  it.each([...MOUNT_SCOPED_BY_DESIGN])('%s is mount-scoped BY DESIGN (documented exception)', file => {
    const src = strip(read(file));
    const at = src.indexOf('BackHandler.addEventListener');
    expect(at).toBeGreaterThan(-1);
    const before = src.slice(0, at);
    expect(before.lastIndexOf('useEffect(')).toBeGreaterThan(before.lastIndexOf('useFocusEffect('));
  });
});

describe('NAV-18/19 — the dept-channel focus refetch keeps the Set identity when unchanged', () => {
  // An unconditional setDeptGroupIds(new Set(...)) hands React a fresh
  // identity on EVERY focus, invalidating the list-order memo and forcing a
  // full re-sort + FlatList re-render while the pop animation runs.
  it('MessengerHomeScreen guards the write with sameIdSet', () => {
    const src = strip(read(HOME));
    const at = src.indexOf('setDeptGroupIds(');
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 260)).toMatch(/sameIdSet\(prev, next\)/);
  });
  it('GroupsScreen guards the write with sameIdSet', () => {
    const src = strip(read(GROUPS));
    const at = src.indexOf('setDeptGroupIds(');
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 260)).toMatch(/sameIdSet\(prev, nextSet\)/);
  });
});

describe('NAV-15 — reactions carry an in-flight ref (one crypto seal per deliberate tap)', () => {
  // setActionMsg(null) closes the sheet but is React state — stale for the
  // whole mash burst. The ref is the synchronous truth.
  it.each([CHAT, DEPT])('%s', file => {
    const src = strip(read(file));
    const at = src.indexOf('const reactToMessage');
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at - 400, at + 700);
    expect(body).toMatch(/reactionInFlightRef/);
    expect(body).toMatch(/if \(reactionInFlightRef\.current\) \{return;\}/);
  });
});

describe('NAV-22 — the unmount draft flush is deferred off the back-pop commit', () => {
  it('ChatScreen defers the O(conversations+groups) persist by one macrotask', () => {
    const src = strip(read(CHAT));
    // Anchor at the unmount-cleanup site: the flush must sit inside a
    // setTimeout, not run synchronously in the cleanup.
    const at = src.indexOf('const tail = textRef.current;');
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 200)).toMatch(
      /setTimeout\(\(\) => persistDraftRef\.current\?\.\(tail\), 0\)/,
    );
  });
});
