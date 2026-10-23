'use client';

/**
 * Linked devices (2026-10-12) — "Use Bravo Messenger on this computer".
 *
 * Shown instead of the chat while the account has the Bravo app on a phone
 * but this browser is not linked to it yet. The QR code carries a one-time
 * link id and this browser's freshly made link key; the phone scans it,
 * approves, and from then on mirrors its chats here. A new code replaces the
 * old one every few minutes.
 */
import {useEffect, useState} from 'react';
import QRCode from 'qrcode';
import {useMessenger} from '@/components/messenger/MessengerProvider';

export function LinkPhonePanel() {
  const {beginPairing, pairing, error} = useMessenger();
  const [img, setImg] = useState<string | null>(null);

  useEffect(() => beginPairing(), [beginPairing]);

  useEffect(() => {
    let live = true;
    if (!pairing?.qr) { setImg(null); return; }
    void QRCode.toDataURL(pairing.qr, {margin: 1, width: 296, errorCorrectionLevel: 'M', color: {dark: '#06142B', light: '#FFFFFF'}})
      .then(url => { if (live) setImg(url); });
    return () => { live = false; };
  }, [pairing?.qr]);

  return (
    <div className="chat-locked card" style={{maxWidth: 760}}>
      <div style={{display: 'flex', gap: 32, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'center', textAlign: 'left'}}>
        <div style={{flex: '1 1 260px', minWidth: 0}}>
          <h3 style={{marginTop: 0}}>Use Bravo Messenger on this computer</h3>
          <ol style={{paddingLeft: 20, lineHeight: 1.7, margin: '12px 0', listStyle: 'decimal'}}>
            <li>Open the <b>Bravo</b> app on your phone.</li>
            <li>Go to <b>Messenger → Settings → Linked devices</b>.</li>
            <li>Tap <b>Link a browser</b> and point your phone at this code.</li>
          </ol>
          <p style={{opacity: 0.75, fontSize: 13, margin: 0}}>
            Your chats, groups and contacts appear here and stay in sync with your phone. Messages stay end-to-end
            encrypted; the code works once and only for your account.
          </p>
          {(pairing?.error || error) && (
            <div className="auth-err" style={{marginTop: 14}}>
              {pairing?.error ? 'Could not create a link code. Retrying…' : error}
            </div>
          )}
        </div>
        <div style={{width: 296, height: 296, borderRadius: 12, background: '#FFFFFF', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto'}}>
          {img
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={img} width={296} height={296} alt="Link code — scan it with the Bravo app" />
            : <span style={{color: '#06142B', fontSize: 13}}>Preparing code…</span>}
        </div>
      </div>
    </div>
  );
}
