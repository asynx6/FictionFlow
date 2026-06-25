/**
 * State management ringan (vanilla JS).
 * - stories: ringkasan list
 * - activeStory: detail story + voice presets + messages
 * - models: daftar model dari provider
 */
const state = {
  stories: [],
  activeStory: null,
  models: [],
  voicePresets: [],
  messages: [],
  modelsLoading: false,
};

const listeners = new Set();

export function getState() {
  return state;
}

export function subscribe(fn) {
  listeners.add(fn);
  fn(state);
  return () => listeners.delete(fn);
}

export function patch(partial) {
  Object.assign(state, partial);
  for (const fn of listeners) {
    try { fn(state); } catch { /* ignore */ }
  }
}

export function setActiveStory(story) {
  state.activeStory = story;
  notify();
}

export function setMessages(messages) {
  state.messages = messages;
  notify();
}

export function appendMessage(message) {
  state.messages = [...state.messages, message];
  notify();
}

export function updateLastAssistantMessage(updater) {
  const arr = [...state.messages];
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i].role === 'assistant') {
      arr[i] = { ...arr[i], ...updater(arr[i]) };
      state.messages = arr;
      notify();
      return;
    }
  }
}

export function setVoicePresets(presets) {
  state.voicePresets = presets;
  notify();
}

export function setModels(models) {
  state.models = models;
  notify();
}

function notify() {
  for (const fn of listeners) {
    try { fn(state); } catch { /* ignore */ }
  }
}
