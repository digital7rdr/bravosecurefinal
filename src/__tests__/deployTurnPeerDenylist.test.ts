import {readFileSync} from 'node:fs';
import {join} from 'node:path';

/**
 * 2026-10-25 — "video and audio does not work". coturn 4.6 treated the
 * one-address IPv6 range `::-::` as matching every IPv4 peer (log: "A peer IP
 * … denied in the range: ::-::"), so every relay permission was refused with
 * 403 Forbidden IP: calls between phones on different networks connected
 * with no media. The SSRF denylist must stay, minus that entry.
 */
const compose = readFileSync(join(process.cwd(), 'deploy', 'production', 'docker-compose.prod.yml'), 'utf8');
const args = compose.split('\n').filter(l => !l.trim().startsWith('#')).join('\n');

describe('coturn peer denylist', () => {
  it('never lists the IPv6 unspecified range that blocks every peer', () => {
    expect(args).not.toMatch(/denied-peer-ip=::-::/);
  });
  it.each([
    '127.0.0.0-127.255.255.255', '10.0.0.0-10.255.255.255', '172.16.0.0-172.31.255.255',
    '192.168.0.0-192.168.255.255', '169.254.0.0-169.254.255.255', '::1-::1',
  ])('still denies %s (SSRF protection, audit P0-C4)', range => {
    expect(args).toContain(`--denied-peer-ip=${range}`);
  });
});
