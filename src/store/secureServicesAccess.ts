/**
 * 2026-10-25 (owner) — Secure Services is for PAID plans. A personal client on
 * the free plan (Bravo Messenger, tier 'lite') sees it locked with an upgrade
 * path; Bravo Messenger Pro, Enterprise, company-workspace members and clients
 * with a Bravo Secure Pro plan under way keep it.
 *
 * The server decides (`plan_locked_modules` on /auth/me) and enforces it
 * (403 tier_insufficient on new bookings, Secure Pro applications and
 * protection sessions). This module only decides what the app SHOWS.
 * Existing bookings, tracking and SOS are never affected.
 */
import {Alert} from '@utils/alert';
import type {User} from '@appTypes/index';

export const SECURE_SERVICES_UPGRADE_TITLE = 'Secure Services needs a paid plan';
export const SECURE_SERVICES_UPGRADE_MESSAGE =
  'Secure Services is included with Bravo Messenger Pro and Enterprise. Upgrade your plan to book protection.';

/** True when this account may NOT open Secure Services. */
export function secureServicesLocked(user: User | null | undefined): boolean {
  if (!user) {return false;}
  const locked = user.plan_locked_modules;
  if (Array.isArray(locked)) {return locked.includes('secure_lite');}
  // An older server that does not report the field: never lock on a guess.
  return false;
}

/** Explain the lock; "View plans" runs `onViewPlans` when given. */
export function promptSecureServicesUpgrade(onViewPlans?: () => void): void {
  Alert.alert(SECURE_SERVICES_UPGRADE_TITLE, SECURE_SERVICES_UPGRADE_MESSAGE, onViewPlans
    ? [{text: 'Not now', style: 'cancel'}, {text: 'View plans', onPress: onViewPlans}]
    : [{text: 'OK'}]);
}
