/**
 * Ops console rate limiting (booking-lane critic, 2026-09-04).
 *
 * The global HTTP throttler ENFORCES by default and, because APP_GUARDs run
 * before JwtAuthGuard, its bucket is keyed per IP. No ops controller bound a
 * throttler, so the whole `/ops/*` surface fell into that one bucket — and the
 * console is a browser SWR client polling at 2 s / 5 s with 5–10 hooks per page.
 * Four seats behind one office NAT 429 each other out of the console.
 *
 * Two halves are pinned, and BOTH are needed: binding the guard is what gives an
 * ops user a per-USER bucket, and it is ALSO the exact mechanism that makes
 * `GlobalHttpThrottlerGuard.shouldSkip` skip the route.
 *
 * ─── WHY THIS SUITE DISCOVERS ITS OWN SUBJECTS ───────────────────────────────
 * The first version listed 14 controllers by hand. Upstream's Dispatch v2 then
 * added a 15th (`ops/dispatch/areas`, polled by the console's AreasPanel) which
 * shipped unbound and unthrottled, and a hardcoded list is structurally incapable
 * of noticing that. So the subjects are DISCOVERED: every `*.controller.ts` under
 * src is scanned for its `@Controller('…')` literal and anything routed under
 * `ops` is a subject. The next controller anyone adds is covered the day it lands.
 *
 * The discriminator is the ROUTE, not the folder, and that distinction is load-
 * bearing in both directions:
 *   • `dispatch/dispatch-admin.controller.ts`   → 'ops/dispatch'  — INCLUDED
 *     (and pro-*-ops, protection-ops likewise) though they live outside ops/.
 *   • `ops/admin-invite-accept.controller.ts`   → 'auth/admin'    — EXCLUDED
 *     though it lives INSIDE ops/. It is the unauthenticated invite-accept
 *     endpoint; a folder rule would have wrongly demanded an admin throttler on it.
 */
import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import {ThrottlerGuard} from '@nestjs/throttler';
import {PATH_METADATA} from '@nestjs/common/constants';
import type {ExecutionContext} from '@nestjs/common';
import {GlobalHttpThrottlerGuard} from '../common/guards/global-http-throttler.guard';
import {UserThrottlerGuard} from '../common/guards/user-throttler.guard';
import {OPS_THROTTLE} from './ops-throttle';

const SRC = path.resolve(__dirname, '..');
const GUARDS_METADATA = '__guards__';

/** Repo scan rule: strip comments first, so prose can never satisfy or fail a scan. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)                       // CRLF-safe
    .map(line => {
      const i = line.indexOf('//');
      return i >= 0 ? line.slice(0, i) : line;
    })
    .join('\n');
}

function controllerFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {controllerFiles(p, out);}
    else if (e.name.endsWith('.controller.ts')) {out.push(p);}
  }
  return out;
}

interface Subject {
  file: string;      // path relative to src, for readable failures
  abs: string;
  route: string;
  source: string;    // comment-stripped
}

/** Every controller ROUTED under `ops`, discovered from source. */
const OPS_SUBJECTS: Subject[] = controllerFiles(SRC)
  .map(abs => {
    const source = stripComments(fs.readFileSync(abs, 'utf8'));
    const m = source.match(/@Controller\(\s*'([^']*)'\s*\)/);
    return {
      abs,
      file: path.relative(SRC, abs).replace(/\\/g, '/'),
      route: m ? m[1] : '',
      source,
    };
  })
  .filter(s => /^ops(\/|$)/.test(s.route))
  .sort((a, b) => a.file.localeCompare(b.file));

/** Load the controller class a discovered file exports. */
function classOf(s: Subject): Function {
  const mod = require(s.abs) as Record<string, unknown>;
  const found = Object.values(mod).find(
    v => typeof v === 'function' && Reflect.getMetadata(PATH_METADATA, v) === s.route,
  );
  if (!found) {throw new Error(`no @Controller('${s.route}') class exported from ${s.file}`);}
  return found as Function;
}

const guardsOn = (target: Function): Function[] =>
  (Reflect.getMetadata(GUARDS_METADATA, target) ?? []) as Function[];

describe('ops surface — per-USER throttling', () => {
  it('discovery finds every ops-routed controller (guard against a vacuous scan)', () => {
    // The count is a floor, not a pin: a new ops controller must ADD to this and
    // then be held to the assertions below, never quietly shrink the subject set.
    expect(OPS_SUBJECTS.length).toBeGreaterThanOrEqual(15);
    const routes = OPS_SUBJECTS.map(s => s.route);
    // Routed under ops but living OUTSIDE ops/ — the folder rule would miss these.
    expect(routes).toContain('ops/dispatch');            // dispatch/dispatch-admin
    expect(routes).toContain('ops/pro-applications');
    expect(routes).toContain('ops/protection');
    expect(routes).toContain('ops/referral-codes');
    expect(routes).toContain('ops/dispatch/areas');      // the 15th, Dispatch v2
    // Inside ops/ but NOT an admin surface — the folder rule would wrongly include it.
    expect(OPS_SUBJECTS.map(s => s.file)).not.toContain('ops/admin-invite-accept.controller.ts');
  });

  it('every ops controller binds a ThrottlerGuard subclass', () => {
    const missing = OPS_SUBJECTS
      .filter(s => !guardsOn(classOf(s)).some(
        g => g === UserThrottlerGuard || g?.prototype instanceof ThrottlerGuard))
      .map(s => s.file);
    expect(missing).toEqual([]);
  });

  it('binds it LAST, after JwtAuthGuard — getTracker needs req.user to key per user', () => {
    for (const s of OPS_SUBJECTS) {
      const names = guardsOn(classOf(s)).map(g => g.name);
      expect([s.file, names[names.length - 1]]).toEqual([s.file, UserThrottlerGuard.name]);
      expect([s.file, names.includes('JwtAuthGuard')]).toEqual([s.file, true]);
      expect([s.file, names.indexOf('JwtAuthGuard') < names.indexOf(UserThrottlerGuard.name)])
        .toEqual([s.file, true]);
    }
  });

  /**
   * The import is asserted from SOURCE, not from behaviour: a missing
   * `import {Throttle} from '@nestjs/throttler'` is a TS2304 that a jest run
   * scoped to another folder will not surface. That exact break shipped once —
   * 12 of 14 controllers got the decorator with no import, because the insert
   * anchored on a single-line @nestjs/common import that most of them do not have.
   */
  it('imports Throttle and UserThrottlerGuard by name (the TS2304 that shipped once)', () => {
    for (const s of OPS_SUBJECTS) {
      expect([s.file, /import \{[^}]*\bThrottle\b[^}]*\} from '@nestjs\/throttler';/.test(s.source)])
        .toEqual([s.file, true]);
      expect([s.file, /import \{[^}]*\bUserThrottlerGuard\b[^}]*\} from/.test(s.source)])
        .toEqual([s.file, true]);
    }
  });

  it('carries the ops rate on the class, comfortably above the console poll mix', () => {
    // @Throttle({default: {...}}) stores one key per field, suffixed by the named
    // bucket. Assert the VALUES — a decorator present with the wrong number is the
    // failure mode that matters.
    for (const s of OPS_SUBJECTS) {
      const ctrl = classOf(s);
      expect([s.file, Reflect.getMetadata('THROTTLER:LIMITdefault', ctrl)])
        .toEqual([s.file, OPS_THROTTLE.default.limit]);
      expect([s.file, Reflect.getMetadata('THROTTLER:TTLdefault', ctrl)])
        .toEqual([s.file, OPS_THROTTLE.default.ttl]);
    }
    // A page runs up to ~10 SWR hooks, fastest at 2 s ⇒ ~300 req/min per TAB, and a
    // seat legitimately keeps several tabs open. 1200/min clears four worst-case
    // tabs and still bounds a runaway render loop.
    expect(OPS_THROTTLE.default.limit).toBeGreaterThanOrEqual(4 * 300);
    expect(OPS_THROTTLE.default.ttl).toBe(60_000);
  });

  /**
   * The half that matters most: the REAL global guard's REAL shouldSkip, run
   * against the REAL controller metadata. If it returns false the route rejoins
   * the shared per-IP bucket and the office-NAT bug is back.
   */
  describe('GlobalHttpThrottlerGuard.shouldSkip', () => {
    const shouldSkip = (ctrl: Function, handler: Function): Promise<boolean> => {
      const guard = new GlobalHttpThrottlerGuard({} as never, {} as never, {} as never);
      const ctx = {
        getType: () => 'http',
        getClass: () => ctrl,
        getHandler: () => handler,
      } as unknown as ExecutionContext;
      return (guard as unknown as {
        shouldSkip(c: ExecutionContext): Promise<boolean>;
      }).shouldSkip(ctx);
    };

    it('skips every ops controller, so the bucket is per-user not per-IP', async () => {
      for (const s of OPS_SUBJECTS) {
        const ctrl = classOf(s);
        const handler = Object.getOwnPropertyNames(ctrl.prototype)
          .filter(k => k !== 'constructor')
          .map(k => (ctrl.prototype as Record<string, unknown>)[k])
          .find(v => typeof v === 'function') as Function;
        expect([s.file, await shouldSkip(ctrl, handler)]).toEqual([s.file, true]);
      }
    });

    it('does NOT skip a controller with no throttler bound (the scan is real)', async () => {
      class Unbound { handler() { /* no guards */ } }
      expect(await shouldSkip(Unbound, Unbound.prototype.handler)).toBe(false);
    });
  });
});
