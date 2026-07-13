import { Events, EventBus } from '../core/eventBus.js';

class ThemeManager {
  constructor() {
    this.STORAGE_KEY = 'fictionflow_theme';
    // Migrasi: pengguna lama dengan tema 'child' (yellow-amber) → 'coffee' (warm latte).
    // Dilakukan sekali di constructor supaya first-load konsisten.
    this.#migrateLegacyTheme();
    this.currentTheme = this.#resolveInitialTheme();
    // Apply immediately synchronously before any render to avoid theme flash
    document.documentElement.setAttribute('data-theme', this.currentTheme);
    this.#applyThemeColor(this.currentTheme);
  }

  // OS chrome (mobile address bar / installed PWA) color per theme, so the
  // browser chrome matches the active theme instead of always showing the dark
  // #1a1a1a from the static <meta name="theme-color"> (TEMUAN-066).
  #THEME_COLORS = { dark: '#1a1a1a', light: '#f5f5f5', coffee: '#3b2f2f' };

  #applyThemeColor(theme) {
    const color = this.#THEME_COLORS[theme];
    if (!color) return;
    let meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.setAttribute('name', 'theme-color');
      document.head.appendChild(meta);
    }
    meta.setAttribute('content', color);
  }

  #migrateLegacyTheme() {
    const saved = localStorage.getItem(this.STORAGE_KEY);
    if (saved === 'child') {
      localStorage.setItem(this.STORAGE_KEY, 'coffee');
    }
  }

  #resolveInitialTheme() {
    const savedTheme = localStorage.getItem(this.STORAGE_KEY);
    if (['dark', 'light', 'coffee'].includes(savedTheme)) return savedTheme;

    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
      return 'light';
    }
    return 'dark';
  }

  init() {
    // Theme already applied synchronously; init just ensures event bus listeners are ready.
    EventBus.emit(Events.THEME_CHANGED, { theme: this.currentTheme });
  }

  setTheme(theme) {
    if (!['dark', 'light', 'coffee'].includes(theme)) return;

    this.currentTheme = theme;
    localStorage.setItem(this.STORAGE_KEY, theme);
    document.documentElement.setAttribute('data-theme', theme);
    this.#applyThemeColor(theme);
    EventBus.emit(Events.THEME_CHANGED, { theme });
  }

  toggleTheme() {
    const cycle = {
      dark: 'light',
      light: 'coffee',
      coffee: 'dark'
    };
    this.setTheme(cycle[this.currentTheme]);
  }

  getTheme() {
    return this.currentTheme;
  }
}

// Singleton
export const themeManager = new ThemeManager();
