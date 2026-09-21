import {useAuthStore} from '@store/authStore';
import {DEPT_CHAT_V2} from '@utils/constants';

/**
 * OP-10 — Dept Chat v2 gate, server-driven.
 *
 * `DEPT_CHAT_V2` is baked at Metro time from EXPO_PUBLIC_DEPT_CHAT_V2, so
 * flipping it meant a store release. The server now reports
 * `dept_chat_v2_enabled` on /auth/me (from DEPT_CHAT_V2_ENABLED, the same env
 * the server-side guard already enforces), which the auth snapshot carries.
 * An older server leaves the field undefined and the baked flag stays the
 * fail-open fallback, so nothing changes until the server is deployed.
 */
export function resolveDeptChatV2(serverFlag: boolean | undefined): boolean {
  return serverFlag ?? DEPT_CHAT_V2;
}

export function useDeptChatV2(): boolean {
  return useAuthStore(s => resolveDeptChatV2(s.user?.dept_chat_v2_enabled));
}

/** Non-hook read for callbacks/effects that cannot subscribe. */
export function isDeptChatV2(): boolean {
  return resolveDeptChatV2(useAuthStore.getState().user?.dept_chat_v2_enabled);
}
