import React, {useMemo} from 'react';
import {View, StyleSheet} from 'react-native';
import Svg, {Path, Rect} from 'react-native-svg';
import {create} from 'qrcode';

/**
 * A QR code drawn with react-native-svg (2026-10-11). Used by the
 * authenticator set-up so the code can be scanned with an authenticator app
 * on another phone or tablet — the same code the web sign-in shows.
 * Dark modules on white with a quiet zone: inverted codes trip some scanners.
 */
export function qrPath(value: string, quiet = 2): {size: number; d: string} {
  const qr = create(value, {errorCorrectionLevel: 'M'});
  const n = qr.modules.size;
  const data = qr.modules.data;
  let d = '';
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (data[y * n + x]) {d += `M${x + quiet} ${y + quiet}h1v1h-1z`;}
    }
  }
  return {size: n + quiet * 2, d};
}

export function QrCode({value, size = 196, label = 'Authenticator set-up QR code', testID = 'totp-qr'}: {value: string; size?: number; label?: string; testID?: string}) {
  const qr = useMemo(() => {
    try {return qrPath(value);} catch {return null;}
  }, [value]);
  if (!qr) {return null;}
  return (
    <View style={[s.box, {width: size + 16, height: size + 16}]} accessible accessibilityLabel={label} testID={testID}>
      <Svg width={size} height={size} viewBox={`0 0 ${qr.size} ${qr.size}`}>
        <Rect x={0} y={0} width={qr.size} height={qr.size} fill="#FFFFFF"/>
        <Path d={qr.d} fill="#06142B"/>
      </Svg>
    </View>
  );
}

const s = StyleSheet.create({
  box: {alignSelf: 'center', alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFFFFF', borderRadius: 14, padding: 8},
});
