import {candidateKind, sdpCandidateKinds} from './ice-kinds';

describe('ice-kinds — candidate kind without the address', () => {
  it('reads type and transport from a trickled candidate', () => {
    expect(candidateKind('candidate:842163049 1 udp 1677729535 203.0.113.7 50443 typ srflx raddr 0.0.0.0 rport 0 generation 0')).toBe('srflx/udp');
    expect(candidateKind('candidate:1 1 UDP 2122260223 192.168.1.5 54321 typ host')).toBe('host/udp');
    expect(candidateKind('candidate:3 1 udp 41885439 31.97.126.211 49170 typ relay raddr 1.2.3.4 rport 5')).toBe('relay/udp');
    expect(candidateKind('candidate:4 1 tcp 1518280447 192.168.1.5 9 typ host tcptype active')).toBe('host/tcp');
    expect(candidateKind('')).toBeNull();
    expect(candidateKind('garbage')).toBeNull();
  });

  it('summarises the candidates inside an SDP', () => {
    const sdp = ['v=0', 'a=candidate:1 1 udp 2122260223 192.168.1.5 54321 typ host',
      'a=candidate:2 1 udp 2122260223 10.0.0.2 54322 typ host',
      'a=candidate:3 1 udp 41885439 31.97.126.211 49170 typ relay raddr 1.2.3.4 rport 5', 'a=end-of-candidates'].join('\r\n');
    expect(sdpCandidateKinds(sdp)).toBe('host/udp×2,relay/udp×1');
    expect(sdpCandidateKinds('v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111')).toBe('none');
  });

  it('never returns an address or port', () => {
    const out = candidateKind('candidate:9 1 udp 1 198.51.100.23 61000 typ relay');
    expect(out).not.toMatch(/\d+\.\d+/);
  });
});
