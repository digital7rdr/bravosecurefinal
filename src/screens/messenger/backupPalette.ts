/**
 * Findings 13 + 15 — the three backup screens (BackupSetupScreen,
 * BackupRestoreScreen, RestoreProgressOverlay) each hard-coded the same
 * base palette. This is the single source for the shared tokens so a
 * future retheme touches ONE place instead of three. Each screen still
 * spreads in its own screen-specific accents (e.g. the overlay's brighter
 * `ok`/`glow`) so this extraction is a pure de-duplication with no visual
 * change.
 */
export const BACKUP_BASE = {
  bg:    '#0A1F3F',
  surf2: '#122747',
  bd:    'rgba(255,255,255,0.09)',
  bd2:   'rgba(255,255,255,0.06)',
  tx1:   '#FFFFFF',
  tx2:   'rgba(229,233,242,0.62)',
  tx3:   'rgba(180,188,204,0.45)',
  warn:  '#FFC107',
  err:   '#FF3B3B',
  act:   '#1E88FF',
} as const;
