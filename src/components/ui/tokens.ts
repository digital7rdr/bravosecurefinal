/**
 * Shared design tokens for the cross-role component library (BUILD_RUNBOOK Step 18 / B3).
 * Obsidian + platinum-cobalt — the same palette the Service-Provider / CPO surfaces use
 * (OrgRosterScreen, OrgComplianceScreen, CpoNavigator) so client, agency, and CPO render
 * identically. One source so the ten shared components never drift apart.
 */
export const UI = {
  bg: '#0A1F3F',
  surface: 'rgba(255,255,255,0.025)',
  text: '#FFFFFF',
  textDim: 'rgba(229,233,242,0.62)',
  textMute: 'rgba(180,188,204,0.45)',
  hair: 'rgba(255,255,255,0.09)',
  accent: '#1E88FF',
  accentSoft: '#3BA6FF',
  accentDeep: '#166ED1',
  signal: '#4ADE80',
  amber: '#F5C76B',
  alert: '#FF5D5D',
  fSans: 'Manrope_500Medium',
  fSemi: 'Manrope_600SemiBold',
  fBold: 'Manrope_700Bold',
} as const;
