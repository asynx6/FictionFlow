export const Events = {
  THEME_CHANGED: 'THEME_CHANGED',
  TTS_START: 'TTS_START',
  TTS_END: 'TTS_END'
};

export const EventBus = {
  events: {},
  on(event, listener) {
    if (!this.events[event]) this.events[event] = [];
    this.events[event].push(listener);
  },
  emit(event, data) {
    if (this.events[event]) {
      this.events[event].forEach(l => l(data));
    }
  }
};
