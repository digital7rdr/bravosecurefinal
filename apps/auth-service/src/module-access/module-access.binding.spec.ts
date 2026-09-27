/**
 * Module Access — the binding contract, read from the REAL decorator metadata.
 *
 * 1. Every gated class binds ModuleAccessGuard AFTER JwtAuthGuard (it needs
 *    req.user). Every gated handler sits in a class whose guards include
 *    JwtAuthGuard (class guards run before handler guards).
 * 2. Every catalog module is enforced somewhere — no switch in the console that
 *    does nothing on the server.
 * 3. SAFETY: SOS, panic, VBG heartbeat / check-in / telemetry / tracking and
 *    in-flight protection-session endpoints are NEVER gated.
 */
import 'reflect-metadata';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {GUARDS_METADATA, PATH_METADATA} from '@nestjs/common/constants';
import {REQUIRE_MODULE_KEY, ModuleAccessGuard} from './module-access.guard';
import {MODULES} from './module-catalog';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';

const SRC = path.resolve(__dirname, '..');

function controllerFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {controllerFiles(p, out);}
    else if (e.name.endsWith('.controller.ts')) {out.push(p);}
  }
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctor = {name: string; prototype: any};
const CONTROLLERS: {file: string; cls: Ctor}[] = controllerFiles(SRC).flatMap(abs => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require(abs) as Record<string, unknown>;
  return Object.values(mod)
    .filter((v): v is Ctor => typeof v === 'function' && Reflect.getMetadata(PATH_METADATA, v) !== undefined)
    .map(cls => ({file: path.relative(SRC, abs).replace(/\\/g, '/'), cls}));
});

const guardsOf = (t: object): unknown[] => (Reflect.getMetadata(GUARDS_METADATA, t) ?? []) as unknown[];
const handlers = (cls: Ctor) => Object.getOwnPropertyNames(cls.prototype)
  .filter(n => n !== 'constructor' && typeof cls.prototype[n] === 'function')
  .map(n => ({name: n, fn: cls.prototype[n] as object}));
const routeOf = (cls: Ctor) => String(Reflect.getMetadata(PATH_METADATA, cls));

describe('module access — binding contract', () => {
  it('discovers controllers (guard against a vacuous scan)', () => {
    expect(CONTROLLERS.length).toBeGreaterThan(40);
  });

  it('gated classes bind ModuleAccessGuard after JwtAuthGuard', () => {
    const gated = CONTROLLERS.filter(c => Reflect.getMetadata(REQUIRE_MODULE_KEY, c.cls));
    expect(gated.map(c => routeOf(c.cls)).sort()).toEqual(
      ['attendance', 'attendance/roster', 'department', 'family', 'incidents', 'news', 'org/workspace']);
    for (const c of gated) {
      const g = guardsOf(c.cls);
      expect([c.file, g.indexOf(JwtAuthGuard) >= 0 && g.indexOf(JwtAuthGuard) < g.indexOf(ModuleAccessGuard)])
        .toEqual([c.file, true]);
    }
  });

  it('gated handlers bind ModuleAccessGuard and live under a JwtAuthGuard class', () => {
    let count = 0;
    for (const c of CONTROLLERS) {
      for (const h of handlers(c.cls)) {
        if (!Reflect.getMetadata(REQUIRE_MODULE_KEY, h.fn)) {continue;}
        count++;
        expect([c.file, h.name, guardsOf(h.fn).includes(ModuleAccessGuard)]).toEqual([c.file, h.name, true]);
        expect([c.file, guardsOf(c.cls).includes(JwtAuthGuard)]).toEqual([c.file, true]);
      }
    }
    expect(count).toBe(13); // vbg 5 · pro-applications 5 · protection 1 · job portal 2
  });

  it('every catalog module is enforced on the server (no dead switches)', () => {
    const viaMeta = new Set<string>();
    for (const c of CONTROLLERS) {
      const k = Reflect.getMetadata(REQUIRE_MODULE_KEY, c.cls);
      if (k) {viaMeta.add(k);}
      for (const h of handlers(c.cls)) {
        const hk = Reflect.getMetadata(REQUIRE_MODULE_KEY, h.fn);
        if (hk) {viaMeta.add(hk);}
      }
    }
    // Bookings are gated per service type inside create(), not by metadata.
    const booking = fs.readFileSync(path.join(SRC, 'booking', 'booking.controller.ts'), 'utf8');
    expect(booking).toMatch(/moduleAccess\.assertEnabled\(/);
    expect(booking).toContain("'executive_protection' : 'secure_lite'");
    for (const m of MODULES) {
      const enforced = viaMeta.has(m.key) || m.key === 'secure_lite' || m.key === 'executive_protection';
      expect([m.key, enforced]).toEqual([m.key, true]);
    }
  });

  it('SAFETY — SOS, panic, check-ins, telemetry and in-flight sessions are never gated', () => {
    const find = (route: string) => CONTROLLERS.find(c => routeOf(c.cls) === route)!;
    const sos = find('sos');
    expect(sos).toBeDefined();
    expect(Reflect.getMetadata(REQUIRE_MODULE_KEY, sos.cls)).toBeUndefined();
    for (const h of handlers(sos.cls)) {expect(Reflect.getMetadata(REQUIRE_MODULE_KEY, h.fn)).toBeUndefined();}

    const neverGated: Record<string, string[]> = {
      vbg: ['panic', 'monitoring/heartbeat', 'biometric/checkin', 'monitoring/status', 'telemetry', 'track'],
      protection: ['sessions/current', 'sessions/:id/readiness', 'sessions/:id/locations', 'sessions/:id/end'],
    };
    for (const [route, paths] of Object.entries(neverGated)) {
      const c = find(route);
      expect(Reflect.getMetadata(REQUIRE_MODULE_KEY, c.cls)).toBeUndefined(); // no class-wide gate
      for (const h of handlers(c.cls)) {
        const p = Reflect.getMetadata(PATH_METADATA, h.fn);
        if (paths.includes(p)) {
          expect([route, p, Reflect.getMetadata(REQUIRE_MODULE_KEY, h.fn)]).toEqual([route, p, undefined]);
        }
      }
      const seen = handlers(c.cls).map(h => Reflect.getMetadata(PATH_METADATA, h.fn));
      for (const p of paths) {expect([route, seen.includes(p)]).toEqual([route, true]);} // non-vacuous
    }
  });
});
