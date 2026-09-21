/**
 * B-801 critic finding — a nested-navigate payload is IDENTITY-keyed.
 *
 * `navigate('MessengerTab', {screen, params, initial: false})` from a sibling
 * tab is applied to the nested stack in `useNavigationBuilder` only when
 * `route.params !== previousParams` (the `initial: false` branch fires on the
 * FIRST state initialisation only). TabRouter, for its part, hands the tab route
 * back UNCHANGED when the incoming `params` is the very object it already holds
 * — so a module-level constant payload re-aims the nested stack exactly once per
 * tab mount, and every later tap just focuses the tab where it was. The
 * ProDashboard tiles (Documents, Bravo Feed) therefore build a FRESH payload per
 * tap (`targetParams` is a factory).
 *
 * This pins the ROUTER half against the installed `@react-navigation/routers`
 * (a router that cloned params, or deep-compared them, fails tests 1/2), and the
 * CORE half by a source scan of the installed `useNavigationBuilder` for the
 * identity compare itself — so a library upgrade that changes either rule fails
 * here rather than silently making the factory unnecessary or insufficient. The
 * screen half (`m.targetParams()` is called, not passed) is pinned by source
 * scan in `proDashboardNewsDoor.test.ts` / `proDashboardDocumentsVault.test.ts`.
 */
import {readFileSync} from 'fs';
import {join} from 'path';
import {TabRouter, CommonActions} from '@react-navigation/routers';

const routeNames = ['SecureTab', 'MessengerTab'];
const opts = {
  routeNames,
  routeParamList: {SecureTab: undefined, MessengerTab: undefined} as Record<string, object | undefined>,
  routeGetIdList: {} as Record<string, undefined>,
};

function tabState() {
  const router = TabRouter({});
  let state = router.getInitialState(opts);
  const dispatch = (action: ReturnType<typeof CommonActions.navigate>) => {
    const next = router.getStateForAction(state, action, opts);
    if (!next) {throw new Error('router refused ' + JSON.stringify(action));}
    state = next as typeof state;
    return state;
  };
  return {dispatch, get: () => state};
}

const PAYLOAD = {screen: 'MessengerHome', params: {tab: 'News'}, initial: false};

describe('nested navigate payload identity (TabRouter, installed version)', () => {
  it('the SAME payload object on a repeat tap leaves the tab route params identity-equal → the nested stack sees no change', () => {
    const t = tabState();
    t.dispatch(CommonActions.navigate('MessengerTab', PAYLOAD));
    const first = t.get().routes[1].params;
    expect(first).toBe(PAYLOAD);

    t.dispatch(CommonActions.navigate('SecureTab'));
    t.dispatch(CommonActions.navigate('MessengerTab', PAYLOAD));
    // Identity-equal: `useNavigationBuilder`'s `route.params !== previousParams`
    // is false, so the nested `navigate({name: screen, params})` never runs.
    expect(t.get().routes[1].params).toBe(first);
  });

  it('a FRESH payload object per tap changes the identity → the nested stack re-navigates', () => {
    const t = tabState();
    const factory = () => ({...PAYLOAD, params: {...PAYLOAD.params}});
    t.dispatch(CommonActions.navigate('MessengerTab', factory()));
    const first = t.get().routes[1].params;

    t.dispatch(CommonActions.navigate('SecureTab'));
    t.dispatch(CommonActions.navigate('MessengerTab', factory()));
    const second = t.get().routes[1].params;
    expect(second).not.toBe(first);
    expect(second).toEqual(PAYLOAD);
  });

  it('a bare navigate(\'MessengerTab\') in between resets the identity — which is why the constant LOOKED repeat-safe on device', () => {
    const t = tabState();
    t.dispatch(CommonActions.navigate('MessengerTab', PAYLOAD));
    const first = t.get().routes[1].params;
    t.dispatch(CommonActions.navigate('SecureTab'));
    t.dispatch(CommonActions.navigate('MessengerTab')); // the flow bar's plain focus
    const cleared = t.get().routes[1];
    expect(cleared.params).toBeUndefined();
    t.dispatch(CommonActions.navigate('SecureTab'));
    t.dispatch(CommonActions.navigate('MessengerTab', PAYLOAD));
    // Same object again, but the route was cleared in between — so the router
    // emits a NEW route object (identity changed → the nested stack re-applies
    // it). It "works" by accident of the intervening tap; not a contract.
    expect(t.get().routes[1]).not.toBe(cleared);
    expect(t.get().routes[1].params).toBe(first);
  });

  it('the CORE half still keys on params identity (installed useNavigationBuilder)', () => {
    // The factory is necessary because of THIS compare. If a core upgrade moved
    // to a deep compare the factory would be redundant; if it dropped the
    // `initial: false` first-mount branch the cold path would break. Pin both.
    const core = readFileSync(
      join(__dirname, '..', '..', '..', 'node_modules', '@react-navigation', 'core', 'lib', 'module', 'useNavigationBuilder.js'),
      'utf8',
    );
    expect(core).toMatch(/route\.params\.initial === false && isFirstStateInitialization \|\| route\.params !== previousParams/);
  });
});
