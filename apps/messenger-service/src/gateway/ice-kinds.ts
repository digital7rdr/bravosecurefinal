/**
 * 2026-10-25 — calls rang but could not connect, and the server log could not
 * say why: it deliberately never logs a candidate (it carries the phone's IP
 * address). These helpers extract only the candidate KIND — host / srflx /
 * prflx / relay — and its transport, so the log shows whether a phone offered
 * a relay path at all. No address, port or foundation ever leaves here.
 */

/** "host/udp" for one candidate line (a=candidate:… or candidate:…), or null. */
export function candidateKind(line: string | null | undefined): string | null {
  if (!line) return null;
  const m = /candidate:\S+\s+\d+\s+(\w+)\s+\d+\s+\S+\s+\d+\s+typ\s+(\w+)/i.exec(line);
  if (!m) return null;
  return `${m[2].toLowerCase()}/${m[1].toLowerCase()}`;
}

/** "host/udp×2,relay/udp×1" for the candidates inside an SDP, or "none". */
export function sdpCandidateKinds(sdp: string | null | undefined): string {
  if (!sdp) return 'none';
  const counts = new Map<string, number>();
  for (const line of sdp.split(/\r?\n/)) {
    if (!line.startsWith('a=candidate:')) continue;
    const k = candidateKind(line);
    if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  if (counts.size === 0) return 'none';
  return [...counts.entries()].sort().map(([k, n]) => `${k}×${n}`).join(',');
}
