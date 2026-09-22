/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{html,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          50: '#f6f7f8',
          100: '#ebeef1',
          200: '#d3dae2',
          500: '#5b6b7c',
          700: '#2c3a48',
          900: '#141b22',
        },
        accent: {
          DEFAULT: '#1a73e8',
          soft: '#e8f0fe',
        },
      },
      fontFamily: {
        sans: ['"IBM Plex Sans"', 'Segoe UI', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
};
