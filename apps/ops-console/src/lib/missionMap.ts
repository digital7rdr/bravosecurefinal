/**
 * B-811 — the mission map's telemetry status pill, as a pure rule so the node
 * test project can pin it (the three former absolute-positioned pills were
 * merged into ONE dock entry; this is the branch table that merge preserved).
 */
export type TelemetryStatus = 'cpo+principal' | 'cpo' | 'principal' | null;

export function telemetryStatus(hasCpoFix: boolean, hasPrincipalFix: boolean): TelemetryStatus {
  if (!hasCpoFix && !hasPrincipalFix) {return 'cpo+principal';}
  if (!hasCpoFix) {return 'cpo';}
  if (!hasPrincipalFix) {return 'principal';}
  return null;
}

export function telemetryStatusLabel(hasCpoFix: boolean, hasPrincipalFix: boolean): string | null {
  const s = telemetryStatus(hasCpoFix, hasPrincipalFix);
  if (s === 'cpo+principal') {return '⏳ AWAITING TELEMETRY · CPO + PRINCIPAL';}
  if (s === 'cpo') {return '⏳ AWAITING CPO TELEMETRY';}
  if (s === 'principal') {return '⏳ AWAITING PRINCIPAL TELEMETRY';}
  return null;
}
