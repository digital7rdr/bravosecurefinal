/**
 * Tile icons of the Bravo Secure home site: line icons in the brand blue,
 * keyed by platform_apps.icon. The shield tile uses the Bravo mark itself.
 */
const p = {fill: 'none', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const};

export function AppIcon({name}: {name: string}) {
  switch (name) {
    case 'shield':
      // eslint-disable-next-line @next/next/no-img-element -- static SVG brand mark
      return <img src="/bravo-mark-light.svg" alt="" className="hub-icon-mark" width={96} height={72}/>;
    case 'chat':
      return <svg viewBox="0 0 64 64" {...p}><rect x="8" y="10" width="48" height="34" rx="8"/><path d="M20 44v10l10-10"/><circle cx="22" cy="27" r="2.2" fill="currentColor"/><circle cx="32" cy="27" r="2.2" fill="currentColor"/><circle cx="42" cy="27" r="2.2" fill="currentColor"/></svg>;
    case 'team':
      return <svg viewBox="0 0 64 64" {...p}><rect x="8" y="10" width="48" height="36" rx="7"/><path d="M24 54h16M32 46v8"/><circle cx="32" cy="23" r="5"/><path d="M23 38c1.5-5 5-7 9-7s7.5 2 9 7"/><circle cx="19" cy="26" r="3.5"/><circle cx="45" cy="26" r="3.5"/><path d="M13 37c1-3 3-4.5 6-4.5M51 37c-1-3-3-4.5-6-4.5"/></svg>;
    case 'globe':
      return <svg viewBox="0 0 64 64" {...p}><circle cx="32" cy="32" r="22"/><path d="M10 32h44M32 10c7 7 9 15 9 22s-2 15-9 22c-7-7-9-15-9-22s2-15 9-22z"/><path d="M14 21h36M14 43h36"/></svg>;
    case 'chart':
      return <svg viewBox="0 0 64 64" {...p}><rect x="8" y="10" width="48" height="40" rx="7"/><path d="M20 40V30M28 40V22M36 40V27M44 40V18"/></svg>;
    case 'calendar':
      return <svg viewBox="0 0 64 64" {...p}><rect x="9" y="13" width="46" height="42" rx="7"/><path d="M9 25h46M21 8v10M43 8v10"/><path d="M19 33h4M30 33h4M41 33h4M19 43h4M30 43h4M41 43h4" strokeWidth="3.4"/></svg>;
    case 'vault':
      return <svg viewBox="0 0 64 64" {...p}><path d="M8 18a5 5 0 0 1 5-5h12l5 6h21a5 5 0 0 1 5 5v24a5 5 0 0 1-5 5H13a5 5 0 0 1-5-5z"/><rect x="25" y="32" width="14" height="11" rx="2"/><path d="M28 32v-3a4 4 0 0 1 8 0v3"/></svg>;
    case 'video':
      return <svg viewBox="0 0 64 64" {...p}><rect x="6" y="17" width="38" height="30" rx="6"/><path d="m44 28 14-8v24l-14-8z"/></svg>;
    default:
      return <svg viewBox="0 0 64 64" {...p}><rect x="10" y="10" width="44" height="44" rx="8"/></svg>;
  }
}
