export const Events = {
  THEME_CHANGED: 'THEME_CHANGED',
  TTS_START: 'TTS_START',
  TTS_LOADING: 'TTS_LOADING', // fetch /api/tts in flight
  TTS_PLAYING: 'TTS_PLAYING', // audio element started playing
  TTS_END: 'TTS_END'
};

export const EventBus = {
  events: {},
  on(event, listener) {
    if (!this.events[event]) this.events[event] = [];
    this.events[event].push(listener);
  },
  off(event, listener) {
    const list = this.events[event];
    if (!list) return;
    const i = list.indexOf(listener);
    if (i >= 0) list.splice(i, 1);
  },
  emit(event, data) {
    if (this.events[event]) {
      this.events[event].forEach(l => l(data));
    }
  }
};
