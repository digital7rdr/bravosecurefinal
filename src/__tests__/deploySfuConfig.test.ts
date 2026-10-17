import {readFileSync} from 'node:fs';
import {join} from 'node:path';

/**
 * Bugs 25/26 (2026-10-17) — group, channel and mission calls failed on
 * production. Every one of them goes through the SFU in messenger-service,
 * which in production:
 *   - refuses to create a room without SFU_ANNOUNCED_IP (sfu.service.ts,
 *     "sfu_announced_ip_unconfigured"),
 *   - refuses every join without SFU_ROOM_TOKEN_SECRET (messenger.gateway.ts,
 *     "room_token_required"),
 *   - and needs its media ports reachable from phones.
 * None of the three was set by the deploy files. These pins keep the env
 * generator, the redeploy script and the compose file in agreement.
 */
const DIR = join(process.cwd(), 'deploy', 'production');
const read = (f: string) => readFileSync(join(DIR, f), 'utf8');

const KEYS = ['SFU_ANNOUNCED_IP', 'SFU_LISTEN_IP', 'SFU_RTC_MIN_PORT', 'SFU_RTC_MAX_PORT', 'SFU_ROOM_TOKEN_SECRET'];

function envValue(src: string, key: string): string | null {
  const m = src.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return m ? m[1].trim() : null;
}
function ensureValue(src: string, key: string): string | null {
  const m = src.match(new RegExp(`^ensure_env \\.env\\.messenger ${key} "([^"]*)"`, 'm'));
  return m ? m[1] : null;
}

describe('SFU production config (group calls)', () => {
  const makeEnv = read('make-env.sh');
  const deploy = read('deploy.sh');
  const compose = read('docker-compose.prod.yml');

  it('make-env.sh writes every SFU key into .env.messenger', () => {
    const block = makeEnv.slice(makeEnv.indexOf('cat > .env.messenger <<EOF'));
    for (const k of KEYS) {expect(envValue(block, k)).not.toBeNull();}
    expect(envValue(block, 'SFU_ROOM_TOKEN_SECRET')).toBe('${SFU_TOKEN}');
    expect(makeEnv).toMatch(/^SFU_TOKEN="\$\(gen\)"/m);
  });

  it('deploy.sh appends the same keys to an existing box (never rotates)', () => {
    for (const k of KEYS) {expect(deploy).toMatch(new RegExp(`^ensure_env \\.env\\.messenger ${k} "`, 'm'));}
    // The secret is generated on the box, not committed.
    expect(ensureValue(deploy, 'SFU_ROOM_TOKEN_SECRET')).toMatch(/^\$\(openssl rand /);
  });

  it('the announced IP is the box coturn already announces', () => {
    const ip = compose.match(/--external-ip=([\d.]+)/)![1];
    const block = makeEnv.slice(makeEnv.indexOf('cat > .env.messenger <<EOF'));
    expect(envValue(block, 'SFU_ANNOUNCED_IP')).toBe(ip);
    expect(ensureValue(deploy, 'SFU_ANNOUNCED_IP')).toBe(ip);
  });

  it('messenger-service publishes exactly the SFU port range, UDP and TCP', () => {
    const block = makeEnv.slice(makeEnv.indexOf('cat > .env.messenger <<EOF'));
    const min = envValue(block, 'SFU_RTC_MIN_PORT');
    const max = envValue(block, 'SFU_RTC_MAX_PORT');
    expect(ensureValue(deploy, 'SFU_RTC_MIN_PORT')).toBe(min);
    expect(ensureValue(deploy, 'SFU_RTC_MAX_PORT')).toBe(max);
    const svc = compose.slice(compose.indexOf('  messenger-service:'), compose.indexOf('  ops-console:'));
    expect(svc).toContain(`- '${min}-${max}:${min}-${max}/udp'`);
    expect(svc).toContain(`- '${min}-${max}:${min}-${max}/tcp'`);
    // Two ports per participant; keep the published range small enough for
    // docker to publish quickly and large enough for real calls.
    const span = Number(max) - Number(min) + 1;
    expect(span).toBeGreaterThanOrEqual(100);
    expect(span).toBeLessThanOrEqual(1000);
  });

  it('the SFU range does not collide with the coturn relay range', () => {
    const lo = Number(compose.match(/--min-port=(\d+)/)![1]);
    const hi = Number(compose.match(/--max-port=(\d+)/)![1]);
    const block = makeEnv.slice(makeEnv.indexOf('cat > .env.messenger <<EOF'));
    const min = Number(envValue(block, 'SFU_RTC_MIN_PORT'));
    const max = Number(envValue(block, 'SFU_RTC_MAX_PORT'));
    expect(max < lo || min > hi).toBe(true);
  });
});
