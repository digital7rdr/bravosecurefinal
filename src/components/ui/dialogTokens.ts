/**
 * The obsidian/cobalt dialog vocabulary, extracted from BravoAlertHost (B-88).
 *
 * Why this file exists: `Alert.alert` can only render title/message/buttons, so
 * any dialog needing an input or a date picker has to be a bespoke Modal. Those
 * bespoke dialogs must look identical to the app-wide one — and the way that
 * goes wrong here is a second hand-copied palette that silently drifts. One
 * definition, imported by both.
 */
export const DIALOG = {
  text:      '#FFFFFF',
  textDim:   'rgba(229,233,242,0.72)',
  textMute:  'rgba(180,188,204,0.45)',
  hair2:     'rgba(255,255,255,0.09)',
  glassFill: 'rgba(255,255,255,0.04)',
  accent:    '#1E88FF',
  onAccent:  '#3BA6FF',
  danger:    '#F87171',
  amber:     '#F5C76B',
  backdrop:  'rgba(4,6,10,0.72)',
} as const;

export const CARD_GRADIENT = ['#131A28', '#0C111B'] as const;
export const FILL_GRADIENT = ['#4C86F0', '#166ED1'] as const;

/** Geometry shared by every Bravo dialog. */
export const DIALOG_METRICS = {
  cardRadius:      22,
  cardMaxWidth:    340,
  backdropPadding: 24,
  medallionSize:   44,
  buttonRadius:    14,
  buttonMinHeight: 48,
} as const;
