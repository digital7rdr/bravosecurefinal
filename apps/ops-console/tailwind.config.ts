import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      // Mirrors --font-sans / --font-mono in src/app/globals.css — keep the
      // two in sync (same rule as the colour tokens below).
      fontFamily: {
        sans: ['Manrope', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Roboto', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      // Bravo Secure brand system (2026-09-21) — live bravo-secure.com identity,
      // superseding Obsidian (audit 2026-08-07 IS-10). Literal hexes (not CSS vars)
      // so Tailwind alpha modifiers (bg-act/10 …) keep working — values MUST
      // mirror the :root tokens in src/app/globals.css.
      colors: {
        canvas:   '#06142B',
        primary:  '#0A1F3F',
        depth:    '#040E1F',
        s1:       '#132A48',
        s2:       '#0E2240',
        s3:       '#0B1C36',
        act:      '#1E88FF',
        'act-hov':'#3BA6FF',
        'act-dim':'#1C4A85',
        acc:      '#00A3FF',
        glow:     '#4CC2FF',
        t1:       '#FFFFFF',
        t2:       '#B8C7E0',
        t3:       '#7E8AA6',
        bd1:      '#22406A',
        bd2:      '#17304F',
        ok:       '#00C853',
        warn:     '#FFC107',
        err:      '#FF3B3B',
        'err-solid': '#D50000',
        info:     '#3BA6FF',
      },
      keyframes: {
        pulse: { '50%': { boxShadow: '0 0 0 4px rgba(220,38,38,0.15)' } },
        mpulse: {
          '0%': { opacity: '0.8', transform: 'scale(0.8)' },
          '100%': { opacity: '0', transform: 'scale(2.2)' },
        },
      },
      animation: {
        pulse:  'pulse 2s ease-in-out infinite',
        mpulse: 'mpulse 2.2s ease-out infinite',
      },
    },
  },
  plugins: [],
};

export default config;
