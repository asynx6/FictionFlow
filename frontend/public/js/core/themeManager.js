import { Events, EventBus } from '../core/eventBus.js';

class ThemeManager {
  constructor() {
    this.STORAGE_KEY = 'fictionflow_theme';
    this.currentTheme = this.#resolveInitialTheme();
    // Apply immediately synchronously before any render to avoid theme flash
    document.documentElement.setAttribute('data-theme', this.currentTheme);
  }

  #resolveInitialTheme() {
    const savedTheme = localStorage.getItem(this.STORAGE_KEY);
    if (['dark', 'light', 'child'].includes(savedTheme)) return savedTheme;

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
    if (!['dark', 'light', 'child'].includes(theme)) return;

    this.currentTheme = theme;
    localStorage.setItem(this.STORAGE_KEY, theme);
    document.documentElement.setAttribute('data-theme', theme);
    EventBus.emit(Events.THEME_CHANGED, { theme });
  }

  toggleTheme() {
    const cycle = {
      dark: 'light',
      light: 'child',
      child: 'dark'
    };
    this.setTheme(cycle[this.currentTheme]);
  }

  getTheme() {
    return this.currentTheme;
  }
}

// Singleton
export const themeManager = new ThemeManager();
