/**
 * Test stand-in for `@navigation/deepLinkReady` in the notification-tap suites.
 *
 * Those suites are about WHERE a tap goes (and what happens when navigation is
 * never ready). The real helper also waits for the signed-in shell to mount,
 * which these suites do not model — they mock `navigationRef` alone. This
 * keeps their contract exactly: ready when the mocked ref says ready, give up
 * after `timeoutMs` otherwise. The shell wait itself is tested in
 * src/navigation/__tests__/deepLinkReady.test.ts.
 */
export async function waitForShellReady(opts: {lane: string; timeoutMs?: number}): Promise<boolean> {
  const {navigationRef} = require('@navigation/navigationRef') as {navigationRef: {isReady?: () => boolean}};
  const t0 = Date.now();
  const max = opts.timeoutMs ?? 25_000;
  while (Date.now() - t0 < max) {
    if (!navigationRef.isReady || navigationRef.isReady()) {return true;}
    await new Promise(r => setTimeout(r, 100));
  }
  return !navigationRef.isReady || navigationRef.isReady();
}

export function shellEntryRoute(): string {return 'MessengerTab';}
