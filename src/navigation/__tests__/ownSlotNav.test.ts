/**
 * B-872/N1 — behavioural pins for the own-slot navigation helpers.
 *
 * `navigation.replace()` is stamped with `source` only, never `target`
 * (@react-navigation/core `useNavigationCache`), and StackRouter only honours
 * `source` when `action.target === state.key` — so an untargeted REPLACE lands
 * on `state.index`, the FOCUSED route. A poll firing while the user had pushed
 * SOS therefore swapped SOS. These helpers dispatch the same action WITH the
 * target, so a tick always acts on its own slot.
 */
let focusEffectCb: (() => void | (() => void)) | null = null;

jest.mock('@react-navigation/native', () => {
  const actual = jest.requireActual('@react-navigation/native');
  return {
    ...actual,
    useFocusEffect: (cb: () => void | (() => void)) => {
      focusEffectCb = cb;
    },
  };
});

import {renderHook} from '@testing-library/react-native';
import {replaceOwnSlot, useFocusDeferredNav} from '../ownSlotNav';

type Dispatched = {type: string; payload?: unknown; source?: string; target?: string};

function makeNav(stateKey: string | undefined) {
  const dispatched: Dispatched[] = [];
  return {
    dispatched,
    nav: {
      dispatch: (a: Dispatched) => { dispatched.push(a); },
      getState: () => (stateKey === undefined ? undefined : {key: stateKey}),
      // Shape-only: the helper borrows this signature for its own arg typing.
      replace: (_name: string, _params?: object) => undefined,
    },
  };
}

describe('replaceOwnSlot', () => {
  it('targets the CALLER’s own route, not whatever is focused', () => {
    const {nav, dispatched} = makeNav('stack-1');
    replaceOwnSlot(nav, 'finding-7', 'AgencyAccepted', {bookingId: 'b1'});
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      type: 'REPLACE',
      payload: {name: 'AgencyAccepted', params: {bookingId: 'b1'}},
      source: 'finding-7',
      // Without the target StackRouter ignores `source` entirely — this is the
      // whole fix, so it is asserted explicitly.
      target: 'stack-1',
    });
  });

  it('falls back to an untargeted replace when the navigator state has no key', () => {
    const {nav, dispatched} = makeNav(undefined);
    replaceOwnSlot(nav, 'finding-7', 'NoDetail', {bookingId: 'b1'});
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].type).toBe('REPLACE');
    expect(dispatched[0].target).toBeUndefined();
  });

  it('falls back when the caller cannot name its own route key', () => {
    const {nav, dispatched} = makeNav('stack-1');
    replaceOwnSlot(nav, undefined, 'NoDetail', {bookingId: 'b1'});
    expect(dispatched[0].source).toBeUndefined();
    expect(dispatched[0].target).toBeUndefined();
  });

  it('never throws when getState() does', () => {
    const dispatched: Dispatched[] = [];
    const nav = {
      dispatch: (a: Dispatched) => { dispatched.push(a); },
      getState: (): {key: string} | undefined => { throw new Error('detached'); },
      replace: (_name: string, _params?: object) => undefined,
    };
    expect(() => replaceOwnSlot(nav, 'k', 'NoDetail')).not.toThrow();
    expect(dispatched).toHaveLength(1);
  });
});

describe('useFocusDeferredNav', () => {
  beforeEach(() => { focusEffectCb = null; });

  it('runs immediately while the screen is focused', () => {
    const ran: string[] = [];
    const {result} = renderHook(() => useFocusDeferredNav({isFocused: () => true}));
    result.current(() => ran.push('now'));
    expect(ran).toEqual(['now']);
  });

  it('defers a blurred unwind and RE-ARMS it on the next focus', () => {
    const ran: string[] = [];
    const {result} = renderHook(() => useFocusDeferredNav({isFocused: () => false}));
    result.current(() => ran.push('later'));
    // Nothing yet — the user is on SOS.
    expect(ran).toEqual([]);
    expect(focusEffectCb).not.toBeNull();
    focusEffectCb!();
    expect(ran).toEqual(['later']);
    // One-shot: a second focus must not replay it.
    focusEffectCb!();
    expect(ran).toEqual(['later']);
  });

  it('keeps only the LATEST deferred action', () => {
    const ran: string[] = [];
    const {result} = renderHook(() => useFocusDeferredNav({isFocused: () => false}));
    result.current(() => ran.push('first'));
    result.current(() => ran.push('second'));
    focusEffectCb!();
    expect(ran).toEqual(['second']);
  });
});
