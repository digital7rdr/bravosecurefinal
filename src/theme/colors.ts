// Bravo Secure — Design Token: Colors
// Brand Kit v4 | ODX-BRAVO-PROP-2026-001 — Command Center palette

export const Colors = {
  // ─── Brand ───────────────────────────────────────────
  primary:      '#1E88FF',   // action-default
  primaryDark:  '#166ED1',   // action-pressed
  primaryLight: '#3BA6FF',   // action-hover
  accent:       '#00A3FF',   // accent-blue (highlights, key accents)
  danger:       '#D50000',   // color-error
  warning:      '#FFC107',   // color-warning
  success:      '#00C853',   // color-success

  // ─── Backgrounds ────────────────────────────────────
  // 2026-09-21 — RESTORED to the live bravo-secure.com identity (founder
  // instruction). B-90 T-13 had retargeted these to the Obsidian system
  // (#07090D / #05070B) and left a "do NOT point these back at Command
  // Navy" note; that note is now superseded — the site's own canvas IS
  // Command Navy, so these two values are the brand, not a legacy relic.
  // Measured from the live site 2026-09-21: deep navy rgb(6,20,43) and
  // navy rgb(10,31,63). The surfaces below were already on this palette
  // and are unchanged.
  background:       '#0A1F3F',   // Command Navy — main app bg
  backgroundDepth:  '#06142B',   // Tactical Midnight — depth layers
  surface:          '#1B3A66',   // surface-1: cards, tiles, panels
  surfaceElevated:  '#162F54',   // surface-2: nested cards, modals
  surfaceOverlay:   '#122747',   // surface-3: drawers, overlays
  surfaceBorder:    '#1C3B66',   // border-subtle
  borderDefault:    '#244C82',   // border-default

  // ─── Text ───────────────────────────────────────────
  textPrimary:   '#FFFFFF',   // titles, key data
  textSecondary: '#B8C7E0',   // supporting text
  textMuted:     '#7E8AA6',   // metadata, timestamps, hints
  textInverse:   '#0A1F3F',

  // ─── Messenger bubbles ──────────────────────────────
  bubbleOutgoing:     '#1E88FF',
  bubbleIncoming:     '#162F54',
  bubbleOutgoingText: '#FFFFFF',
  bubbleIncomingText: '#FFFFFF',

  // ─── Functional ─────────────────────────────────────
  online:    '#00C853',
  offline:   '#7E8AA6',
  away:      '#FFC107',
  encrypted: '#00A3FF',

  // ─── Tabs ───────────────────────────────────────────
  tabActive:   '#1E88FF',
  tabInactive: '#B8C7E0',
  tabBar:      '#0A1F3F',

  // ─── Map / Operational (RESTRICTED — maps and system visuals only) ──
  mapOverlay: 'rgba(6, 20, 43, 0.7)',
  mapGrid:    '#4CC2FF',
  sosRed:     '#FF3B3B',

  // ─── Transparent ────────────────────────────────────
  overlay:      'rgba(6, 20, 43, 0.85)',
  overlayLight: 'rgba(10, 31, 63, 0.5)',
} as const;

export type ColorKey = keyof typeof Colors;

/**
 * Palette — de-facto colours already used across multiple Lite screens that
 * are NOT part of the official Command-Center token set above. Centralised
 * here so screens stop re-declaring magic hex (the booking flow shares one
 * slate palette; the agent wallet/earnings screens share a gold/purple
 * identity). These intentionally preserve the exact values the screens
 * already render — this is a "name the constant" refactor, not a re-theme.
 * Any change to the official look should go through Colors + design review.
 */
export const Palette = {
  // Booking-flow slate set (cards, borders, body/label text on dark navy).
  slateSurface:  '#0D1929',
  slateBorder:   '#1E2D45',
  slateText:     '#F1F5F9',  // near-white headings
  slateMuted:    '#94A3B8',  // secondary text
  slateDim:      '#64748B',  // tertiary text
  slateFaint:    '#475569',  // labels / faint
  slateIce:      '#CBD5E1',  // icon tint on dark
  blueText:      '#60A5FA',  // info/blue accents
  greenText:     '#4ade80',  // success accents
  redText:       '#F87171',  // error accents
  amberText:     '#F59E0B',  // ops-approval / warning accents

  // Agent wallet / earnings identity.
  agentGold:     '#D4AF37',
  agentPurple:   '#7C3AED',
} as const;

export type PaletteKey = keyof typeof Palette;
