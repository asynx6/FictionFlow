/**
 * Theme toggle button — pasang di header, klik untuk cycle theme.
 * Dipakai di index.html dan story.html.
 */
import {
  getCurrentTheme,
  cycleTheme,
  getThemeMeta,
} from './themeManager.js';

const ICON_MAP = {
  dark: '🌙',
  light: '☀️',
  child: '🧸',
};

const LABEL_MAP = {
  dark: 'Gelap',
  light: 'Terang',
  child: 'Anak',
};

export function mountThemeToggle(container) {
  if (!container) return;
  const refresh = () => {
    const theme = getCurrentTheme();
    container.dataset.theme = theme;
    container.setAttribute('aria-label', `Tema saat ini: ${LABEL_MAP[theme]}. Klik untuk ganti.`);
    container.title = `Tema: ${LABEL_MAP[theme]} (klik untuk ganti)`;
    const iconEl = container.querySelector('[data-theme-icon]');
    const labelEl = container.querySelector('[data-theme-label]');
    if (iconEl) iconEl.textContent = ICON_MAP[theme];
    if (labelEl) labelEl.textContent = LABEL_MAP[theme];
  };

  container.addEventListener('click', () => {
    cycleTheme();
    refresh();
  });

  document.addEventListener('fictionflow:theme-change', refresh);
  refresh();
}
