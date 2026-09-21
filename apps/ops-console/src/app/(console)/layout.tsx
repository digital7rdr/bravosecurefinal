/**
 * IA-12 — the console chrome is mounted ONCE, here.
 *
 * Every one of the 33 pages used to import and render the Shell itself, so the
 * rail, the top bar, the SOS alert bar, the silent token refresh and the idle
 * timer were torn down and rebuilt on every navigation. Hoisting it into the
 * route group's layout keeps a single instance alive across navigations (the
 * SOS bar in particular must never remount mid-emergency) and makes "is this
 * page inside the console?" a structural fact rather than a per-file habit.
 *
 * `/login` and `/accept-invite` live OUTSIDE this group — they have no rail and
 * must not fire the authenticated bootstrap.
 */

import type {ReactNode} from 'react';
import {Shell} from '@/components/Shell';

export default function ConsoleLayout({children}: {children: ReactNode}) {
  return <Shell>{children}</Shell>;
}
