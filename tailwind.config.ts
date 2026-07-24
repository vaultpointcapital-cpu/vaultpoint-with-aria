import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: 'class',
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        background: '#0A0C10',
        surface: '#111318',
        'surface-elevated': '#181C23',
        border: '#1E2330',
        accent: {
          DEFAULT: '#6C63FF',
          foreground: '#FFFFFF',
          // Lighter tint for small/normal-size text and links rendered on
          // bg-surface or bg-surface-elevated — the DEFAULT violet only
          // clears WCAG AA (4.5:1) against the page background, not
          // against card surfaces (~4.3:1, fails). Use this token instead
          // of DEFAULT for any text-accent usage that isn't large text.
          light: '#8C84FF',
        },
        success: '#00E5A0',
        warning: '#FF6B35',
        info: '#3B9EFF',
        gold: '#FFD700',
        rose: '#EC4899',
        text: {
          primary: '#F0F2F8',
          secondary: '#8B92A5',
          // Was #4A5168 (~2.4:1 against background/surface — fails WCAG
          // AA's 4.5:1 for normal text). This shade clears ~4.9-5.2:1
          // while staying visibly more muted than text-secondary.
          tertiary: '#7B8399',
        },
      },
      fontFamily: {
        display: ['Space Grotesk', 'sans-serif'],
        body: ['Inter', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      borderRadius: {
        lg: '14px',
        xl: '16px',
      },
      animation: {
        'pulse-slow': 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};

export default config;
