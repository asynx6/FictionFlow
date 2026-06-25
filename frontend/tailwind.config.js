/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './public/**/*.html',
    './public/js/**/*.js',
  ],
  theme: {
    extend: {
      colors: {
        theme: {
          bg: 'rgb(var(--theme-bg) / <alpha-value>)',
          text: 'rgb(var(--theme-text) / <alpha-value>)',
          muted: 'rgb(var(--theme-muted) / <alpha-value>)',
          accent: 'rgb(var(--theme-accent) / <alpha-value>)',
          hover: 'rgb(var(--theme-hover) / <alpha-value>)',
          border: 'rgb(var(--theme-border) / <alpha-value>)',
          surface: 'rgb(var(--theme-surface) / <alpha-value>)',
        }
      },
      fontFamily: {
        sans: ['DM Sans', 'system-ui', 'sans-serif'],
        serif: ['Crimson Pro', 'Georgia', 'serif'],
      }
    },
  },
  plugins: [],
};
