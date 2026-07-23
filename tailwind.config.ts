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
        },
        success: '#00E5A0',
        warning: '#FF6B35',
        info: '#3B9EFF',
        gold: '#FFD700',
        rose: '#EC4899',
        text: {
          primary: '#F0F2F8',
          secondary: '#8B92A5',
          tertiary: '#4A5168',
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
