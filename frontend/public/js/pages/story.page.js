import { api } from '../core/api.js';
import { apiClient } from '../api/apiClient.js';
import { themeManager } from '../core/themeManager.js';
import { Events, EventBus } from '../core/eventBus.js';
import { ttsEngine } from '../core/ttsEngine.js';
import { renderMarkdown } from '../core/markdownRenderer.js';
// Bug-B6: import the singleton ttsQueue (with pagehide hard-reset wire-up)
// so that navigation round-trip doesn't leak Audio/Blob URL state.
import { ttsQueue, TtsQueueManager } from '../core/ttsQueueManager.js';

const FONT_SIZE_KEY = 'fictionflow_font_size';
const READING_MODE_KEY = 'fictionflow_reading_mode';
const FONT_SIZE_MIN = 14;
const FONT_SIZE_MAX = 22;
const FONT_SIZE_DEFAULT = 16;

const FONT_SIZE_MAP = {
  14: 'font-size-xs',
  15: 'font-size-sm',
  16: 'font-size-md',
  17: 'font-size-lg',
  18: 'font-size-xl',
  20: 'font-size-2xl',
  22: 'font-size-3xl',
};

const currentUtterance = {
  id: null,
  isPlaying: false,
  isPaused: false,
  // Mode aktif: 'single'. Web Speech dihapus total (pakai Edge TTS only).
  mode: null,
  // True saat POST /api/tts dalam flight (loading state untuk button).
  isLoading: false,
};

// Audio playback delegate — singleton imported from ttsQueueManager.js
// (also wires pagehide hard-reset for B6 navigation round-trip).

function stopSpeaking() {
  ttsQueue.stop();
  resetUtteranceState();
  EventBus.emit(Events.TTS_END);
  updateGlobalTtsButtons();
}

/** Shared reset: dipanggil dari stopSpeaking user-action DAN dari
 * ttsQueueManager 'tts:playback-finished' event (natural playback complete). */
function resetUtteranceState() {
  if (!currentUtterance.isLoading && !currentUtterance.isPlaying && !currentUtterance.isPaused && currentUtterance.id === null) {
    return; // already clean
  }
  currentUtterance.id = null;
  currentUtterance.isLoading = false;
  currentUtterance.isPlaying = false;
  currentUtterance.isPaused = false;
  currentUtterance.mode = null;
}

// Reset state saat TTS selesai natural (queue emit CustomEvent 'tts:playback-finished').
window.addEventListener('tts:playback-finished', () => {
  resetUtteranceState();
  EventBus.emit(Events.TTS_END);
  updateGlobalTtsButtons();
});

// Transition loading → playing saat audio.decode() selesai + audio.play() resolve.
window.addEventListener('tts:playback-started', () => {
  if (currentUtterance.id == null) return;
  currentUtterance.isLoading = false;
  currentUtterance.isPlaying = true;
  EventBus.emit(Events.TTS_PLAYING);
  updateGlobalTtsButtons();
});

// UI feedback saat fetch gagal (Backend timeout/error). Reset state
// + show transient toast (3s) supaya user tahu kenapa tidak ada audio.
window.addEventListener('tts:playback-failed', (ev) => {
  if (currentUtterance.id == null) return;
  resetUtteranceState();
  EventBus.emit(Events.TTS_END);
  updateGlobalTtsButtons();
  const msg = ev?.detail?.message || 'TTS error';
  showTransientError(`Audio gagal dimuat: ${msg}`);
});

/**
 * Show transient non-blocking error toast di top-right — auto-dismiss 4s.
 * Tidak interrupt alur user — informational saja boleh diulangi klik.
 */
let _toastTimer = null;
function showTransientError(text) {
  let toast = document.getElementById('tts-error-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'tts-error-toast';
    toast.setAttribute('role', 'status');
    toast.style.cssText = [
      'position:fixed', 'top:80px', 'right:24px', 'z-index:80',
      'max-width:340px', 'padding:10px 14px', 'border-radius:12px',
      'background-color:rgba(220,38,38,0.92)', 'color:#fff',
      'font-size:13px', 'line-height:1.3',
      'box-shadow:0 6px 24px rgba(0,0,0,0.25)',
      'backdrop-filter:blur(6px)',
      'opacity:0', 'transition:opacity 0.2s ease',
      'pointer-events:auto',
    ].join(';');
    document.body.appendChild(toast);
  }
  toast.textContent = text;
  toast.style.opacity = '1';
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => {
    toast.style.opacity = '0';
  }, 4000);
}

function pauseSpeaking() {
  if (!currentUtterance.isPlaying || currentUtterance.isPaused) return;
  // Pause non-blocking; fetches tetap hidup agar resume tidak re-fetch.
  ttsQueue.pause();
  currentUtterance.isPaused = true;
  updateGlobalTtsButtons();
}

function resumeSpeaking() {
  if (!currentUtterance.isPaused) return;
  ttsQueue.resume();
  currentUtterance.isPaused = false;
  updateGlobalTtsButtons();
}

function updateGlobalTtsButtons() {
  // State-based show/hide: 5 actions → 5 buttons per toolbar.
  // - data-state='idle'     → only play icon
  // - data-state='loading'  → only hourglass icon
  // - data-state='playing'  → pause + stop
  // - data-state='paused'   → resume + stop
  const state = !currentUtterance.id
    ? 'idle'
    : currentUtterance.isLoading
      ? 'loading'
      : currentUtterance.isPaused
        ? 'paused'
        : 'playing';

  document.querySelectorAll('.tts-toolbar').forEach((tb) => {
    const tbMsgId = tb.getAttribute('data-msg-id');
    const isCurrent = currentUtterance.id === tbMsgId;
    // Apply state only to the toolbar of the playing msg.
    if (!isCurrent) {
      tb.setAttribute('data-state', 'idle');
    } else {
      tb.setAttribute('data-state', state);
    }
  });
}

/**
 * Pilih voice browser yang paling cocok dengan locale/gender dari segment.
 * Locale/voice_name dari LLM diabaikan — kita pakai pack user (id-ID / en-US)
 * supaya narasi + dialog konsisten gender di seluruh cerita.
 */
function pickBrowserVoiceForSegment(segment) {
  const voices = ttsEngine.getVoices() || [];
  if (voices.length === 0) return null;
  const pack = getActiveVoicePack();
  const gender = segment?.gender;

  // 1) Locale prefix match (id-ID / en-US).
  const localeMatch = voices.find((v) => (v.lang || '').toLowerCase() === pack.toLowerCase());
  if (localeMatch) return localeMatch;
  // 2) Locale prefix loosened.
  const prefixMatch = voices.find((v) => (v.lang || '').toLowerCase().startsWith(pack.split('-')[0]));
  if (prefixMatch) return prefixMatch;
  // 3) Gender-based filter.
  if (gender === 'female') {
    const f = voices.find((v) => /female|woman|zira|samantha|gadis|jenny/i.test(v.name));
    if (f) return f;
  } else if (gender === 'male') {
    const m = voices.find((v) => /male|man|david|mark|daniel|ardi|guy/i.test(v.name));
    if (m) return m;
  }
  // 4) First voice.
  return voices[0] ?? null;
}

/** Get active voice pack dari `<select id="voicePack">`, fallback id-ID. */
function getActiveVoicePack() {
  return (voicePack?.value || localStorage.getItem('fictionflow_voice_pack') || 'id-ID').toString();
}

/**
 * Render an AI avatar element into a target container.
 * Kalau avatar_enabled + URL valid → render <img>. Else → render inisial huruf.
 * Returns true kalau img berhasil dirender; false kalau fallback ke inisial.
 * Idempotent: aman dipanggil ulang tiap kali story di-reload.
 */
function isAvatarActive(story) {
  if (!story) return false;
  const enabled = story.avatar_enabled === 1 || story.avatar_enabled === true;
  const url = (story.avatar_url ?? '').toString().trim();
  return enabled && !!url && /^https?:\/\//i.test(url);
}

function renderAvatarInto(target, story, { sizeClasses = 'w-9 h-9 sm:w-10 sm:h-10 text-lg' } = {}) {
  if (!target) return;
  const initial = (story?.ai_name ?? '?').toString().charAt(0).toUpperCase();
  if (isAvatarActive(story)) {
    target.innerHTML = `<img src="${escapeHtmlAttr(story.avatar_url)}" alt="${escapeHtmlAttr(story?.ai_name ?? 'AI')}" class="${sizeClasses} rounded-full object-cover bg-gradient-to-br from-theme-accent/20 to-theme-accent/5 border border-theme-accent/20 shadow-sm" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'${sizeClasses} rounded-full flex items-center justify-center bg-gradient-to-br from-theme-accent/20 to-theme-accent/5 border border-theme-accent/20 text-theme-accent font-serif font-bold shadow-sm',textContent:'${initial}'}))" />`;
  } else {
    target.textContent = initial;
  }
}

function escapeHtmlAttr(s) {
  return String(s ?? '').replace(/[&"'<>]/g, (c) => ({ '&': '&amp;', '"': '&quot;', "'": '&#39;', '<': '&lt;', '>': '&gt;' }[c]));
}

function isValidAvatarUrl(value) {
  const v = (value ?? '').toString().trim();
  if (!v) return false;
  try {
    const u = new URL(v);
    return (u.protocol === 'http:' || u.protocol === 'https:') && v.length <= 2048;
  } catch {
    return false;
  }
}

/** Map pack + gender → EdgeTTS voice_name yang valid. Sumber kebenaran tunggal. */
function pickEdgeVoiceForSegment(pack, gender) {
  const g = (gender ?? '').toString();
  if (pack === 'en-US') {
    return g === 'female' ? 'en-US-JennyNeural' : 'en-US-GuyNeural';
  }
  // Default: id-ID.
  return g === 'female' ? 'id-ID-GadisNeural' : 'id-ID-ArdiNeural';
}

/**
 * Logika playback pindah ke ttsQueueManager. Method ini jadi no-op (kept
 * untuk backward-compat dengan legacy callers).
 */
function playSegment(_seg) {
  // no-op — ttsQueueManager._speakCurrent() handles fetch + Audio + fallback.
}

function playSegmentBrowser(_seg) {
  // no-op — ttsQueueManager._speakFallbackBrowser() handles Web Speech fallback.
}

function playNextSegment() {
  // no-op — ttsQueueManager manages sequencing per segment events.
}

/**
 * Map simpan audio_segments per message bubble, agar tombol TTS bisa akses.
 * Key = message id, value = array dari SSE done.audio_segments.
 */
const currentAudioSegments = {};

const DEFAULT_TTS_VOICE = 'id-ID-ArdiNeural';

const VALID_TTS_VOICES = new Set([
  'id-ID-ArdiNeural',
  'id-ID-GadisNeural',
  'en-US-GuyNeural',
  'en-US-JennyNeural',
]);

/**
 * Module-level cache untuk currentStory. Di-update dari loadStoryAndMessages
 * setiap kali story fetched. speakMessage() function (dideklarasikan di top-
 * level module) membaca dari cache ini — tidak bisa langsung akses variable
 * `currentStory` karena variable itu scoped ke DOMContentLoaded callback.
 */
let __currentStoryCache = null;

/**
 * Pilih Edge TTS voice dari currentStory.tts_voice (sumber kebenaran).
 * Fallback ke default Indonesian male kalau story belum ada / value invalid.
 */
function resolveStoryVoice() {
  const v = __currentStoryCache && __currentStoryCache.tts_voice;
  if (typeof v === 'string' && VALID_TTS_VOICES.has(v)) return v;
  return DEFAULT_TTS_VOICE;
}

async function speakMessage(msgId, textOrSegments) {
  // TTS selalu aktif. Tidak ada toggle "Aktifkan Suara" lagi — server-side
  // Edge TTS selalu jalan jika user klik tombol speaker.
  // Pause/resume kalau klik tombol yang sama.
  if (currentUtterance.id === msgId && currentUtterance.isPlaying) {
    if (currentUtterance.isPaused) {
      resumeSpeaking();
    } else {
      pauseSpeaking();
    }
    return;
  }

  // Klik tombol untuk message BERBEDA → kill apapun yang sedang jalan
  // (audio element + blob URL + inflight fetch + Web Speech) via stopSpeaking().
  stopSpeaking();

  const voice = resolveStoryVoice();
  let unifiedText = '';

  // Kumpulkan full text jadi 1 chunk, tidak peduli inputnya cached segments
  // atau string mentah. Hasilnya single POST /api/tts → single MP3 → audio
  // mulus tanpa gap antar fetch/segment.
  const segments = Array.isArray(textOrSegments) ? textOrSegments : null;
  if (segments && segments.length > 0) {
    // Cached chunks (audio_segments[]) → gabung.
    unifiedText = segments
      .map((s) => (s?.text ?? '').toString().replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join(' ');
  } else if (typeof textOrSegments === 'string') {
    unifiedText = textOrSegments;
  }

  // Strip notts/markdown residue.
  const cleaned = ttsEngine.parseTtsText(unifiedText);
  if (!cleaned || !cleaned.trim()) {
    console.warn('[tts] cleaned text kosong, abort. msgId=', msgId);
    return;
  }

  const aiGenderRaw = __currentStoryCache?.ai_gender?.toString?.() ?? '';
  const gender = aiGenderRaw === 'female' ? 'female' : 'male';

  const singleChunk = [{
    tag: 'NARASI',
    text: cleaned.trim(),
    voice: voice,
    gender: gender,
  }];

  currentUtterance.id = msgId;
  currentUtterance.mode = 'single';
  currentUtterance.isLoading = true; // fetch in flight
  currentUtterance.isPlaying = false;
  currentUtterance.isPaused = false;
  EventBus.emit(Events.TTS_START);
  EventBus.emit(Events.TTS_LOADING); // custom: button show spinner
  ttsQueue.enqueueSegments(singleChunk);
  ttsQueue.play();
  updateGlobalTtsButtons();
}

function speakLastAiMessage() {
  const aiBubbles = document.querySelectorAll('.msg-ai-block');
  if (!aiBubbles.length) return;
  const last = aiBubbles[aiBubbles.length - 1];
  const ttsBtn = last.querySelector('.tts-btn');
  if (ttsBtn) ttsBtn.click();
}

document.addEventListener('DOMContentLoaded', async () => {
  themeManager.init();

  // URL Params
  const urlParams = new URLSearchParams(window.location.search);
  const storyId = urlParams.get('id');

  if (!storyId) {
    alert('ID Sesi tidak ditemukan.');
    window.location.href = '/';
    return;
  }

  // DOM Elements - Theme
  const themeToggleBtn = document.getElementById('themeToggleBtn');
  const themeIcon = document.getElementById('themeIcon');
  const toolbarThemeIcon = document.getElementById('toolbarThemeIcon');

  // DOM Elements - Header
  const headerAiName = document.getElementById('headerAiName');
  const headerAvatar = document.getElementById('headerAvatar');
  const headerContext = document.getElementById('headerContext');
  const mainHeader = document.getElementById('mainHeader');

  // DOM Elements - Reading Toolbar
  const readingToolbar = document.getElementById('readingToolbar');
  const decreaseFontBtn = document.getElementById('decreaseFontBtn');
  const increaseFontBtn = document.getElementById('increaseFontBtn');
  const fontSizeLabel = document.getElementById('fontSizeLabel');
  const fontSizeSlider = document.getElementById('fontSizeSlider');
  const settingsFontSizeLabel = document.getElementById('settingsFontSizeLabel');
  const exitReadingModeBtn = document.getElementById('exitReadingModeBtn');
  const readingModeFooterBtn = document.getElementById('readingModeFooterBtn');
  const toolbarTtsBtn = document.getElementById('toolbarTtsBtn');
  const toolbarThemeBtn = document.getElementById('toolbarThemeBtn');
  const toolbarSettingsBtn = document.getElementById('toolbarSettingsBtn');
  const readingProgressBar = document.getElementById('readingProgressBar');

  // DOM Elements - Reading Mode Toggle
  const readingModeToggle = document.getElementById('readingModeToggle');

  // DOM Elements - Settings
  const settingsToggleBtn = document.getElementById('settingsToggleBtn');
  const settingsPanel = document.getElementById('settingsPanel');
  const settingsDrawer = document.getElementById('settingsDrawer');
  const settingsBackdrop = document.getElementById('settingsBackdrop');
  const closeSettingsBtn = document.getElementById('closeSettingsBtn');
  const viewMemoryBtn = document.getElementById('viewMemoryBtn');
  const factCountBadge = document.getElementById('factCountBadge');

  // DOM Elements - Avatar Settings
  const avatarEnabledToggle = document.getElementById('avatarEnabledToggle');
  const avatarUrlInput = document.getElementById('avatarUrlInput');
  const avatarUrlError = document.getElementById('avatarUrlError');
  const avatarUrlPreviewWrap = document.getElementById('avatarUrlPreviewWrap');
  const avatarUrlPreview = document.getElementById('avatarUrlPreview');
  let avatarSaveTimer = null;

  // DOM Elements - Memory Modal
  const memoryModal = document.getElementById('memoryModal');
  const memoryDialog = document.getElementById('memoryDialog');
  const memoryBackdrop = document.getElementById('memoryBackdrop');
  const closeMemoryBtn = document.getElementById('closeMemoryBtn');
  const memoryList = document.getElementById('memoryList');

  // DOM Elements - TTS
  const ttsToggle = document.getElementById('ttsToggle');
  const voicePack = document.getElementById('voicePack');
  const ttsIndicator = document.getElementById('ttsIndicator');

  // DOM Elements - Chat
  const chatContainer = document.getElementById('chatContainer');
  const chatList = document.getElementById('chatList');
  const loadingChat = document.getElementById('loadingChat');
  const chatForm = document.getElementById('chatForm');
  const messageInput = document.getElementById('messageInput');
  const sendBtn = document.getElementById('sendBtn');
  const typingIndicator = document.getElementById('typingIndicator');
  const scrollToBottomBtn = document.getElementById('scrollToBottomBtn');

  // DOM Elements - AI Provider Error Dialog
  const aiErrorDialog = document.getElementById('aiErrorDialog');
  const aiErrorPanel = document.getElementById('aiErrorPanel');
  const aiErrorBackdrop = document.getElementById('aiErrorBackdrop');
  const aiErrorMessage = document.getElementById('aiErrorMessage');
  const continueErrorBtn = document.getElementById('continueErrorBtn');
  const cancelErrorBtn = document.getElementById('cancelErrorBtn');

  // State
  let currentStory = null;
  let isAiResponding = false;
  let autoScroll = true;
  let pendingError = null;
  let pendingUserBubble = null;
  let pendingAiBubble = null;
  // Single-slot refs for AI error dialog handlers — menghindari listener accumulation.
  let _onContinueError = null;
  let _onCancelError = null;
  let _factPollTimerId = null;

  // `data-segments` attribute stores LLM audio_segments JSON via setAttribute.
  // JSON.stringify does NOT escape `<`/`>` — but setAttribute+getAttribute is
  // HTML-attribute safe (no decoding). DO NOT assign this value to innerHTML
  // of any element. Use _stashSegments() to write; _readSegments() to consume.
  function _stashSegments(ttsBtn, segs) {
    ttsBtn.setAttribute('data-segments', JSON.stringify(segs));
  }
  function _readSegments(ttsBtn) {
    const raw = ttsBtn && ttsBtn.getAttribute && ttsBtn.getAttribute('data-segments');
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  function _setAiErrorHandlers({ onContinue, onCancel }) {
    _onContinueError = onContinue;
    _onCancelError = onCancel;
    if (continueErrorBtn) continueErrorBtn.onclick = () => { if (_onContinueError) _onContinueError(); };
    if (cancelErrorBtn) cancelErrorBtn.onclick = () => { if (_onCancelError) _onCancelError(); };
  }

  function _clearAiErrorHandlers() {
    _onContinueError = null;
    _onCancelError = null;
    if (continueErrorBtn) continueErrorBtn.onclick = null;
    if (cancelErrorBtn) cancelErrorBtn.onclick = null;
  }

  let readingMode = false;
  let fontSize = FONT_SIZE_DEFAULT;

  // --- Reading Experience Logic ---
  const clampFontSize = (v) => Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, v));
  const resolveInitialFontSize = () => {
    const saved = parseInt(localStorage.getItem(FONT_SIZE_KEY), 10);
    return clampFontSize(Number.isFinite(saved) ? saved : FONT_SIZE_DEFAULT);
  };

  const applyFontSize = (size) => {
    fontSize = clampFontSize(size);
    localStorage.setItem(FONT_SIZE_KEY, fontSize);
    if (fontSizeLabel) fontSizeLabel.textContent = `${fontSize}px`;
    if (settingsFontSizeLabel) settingsFontSizeLabel.textContent = `${fontSize}px`;
    if (fontSizeSlider) fontSizeSlider.value = fontSize;

    Object.values(FONT_SIZE_MAP).forEach((cls) => chatContainer.classList.remove(cls));
    const sizeClass = FONT_SIZE_MAP[fontSize] || FONT_SIZE_MAP[FONT_SIZE_DEFAULT];
    chatContainer.classList.add(sizeClass);
    // Set CSS variable dan kelas aktif di msg-content agar styling menang dari text-[15px]
    chatContainer.style.setProperty('--reading-font-size', `${fontSize}px`);
    chatContainer.querySelectorAll('.msg-ai-block .msg-content').forEach((el) => {
      el.classList.add('font-size-active');
    });
  };

  const changeFontSize = (delta) => applyFontSize(fontSize + delta);

  const applyReadingMode = (active) => {
    readingMode = !!active;
    localStorage.setItem(READING_MODE_KEY, readingMode ? 'true' : 'false');
    document.body.classList.toggle('is-reading-mode', readingMode);
    if (readingToolbar) readingToolbar.classList.toggle('hidden', !readingMode);
    if (mainHeader) mainHeader.classList.toggle('hidden', readingMode);
    if (readingModeToggle) readingModeToggle.checked = readingMode;
  };

  const toggleReadingMode = () => applyReadingMode(!readingMode);

  const updateProgressBar = () => {
    if (!readingProgressBar) return;
    const scrollTop = chatContainer.scrollTop;
    const scrollHeight = chatContainer.scrollHeight - chatContainer.clientHeight;
    if (scrollHeight <= 0) {
      readingProgressBar.style.width = '0%';
      return;
    }
    const progress = Math.min(100, Math.max(0, (scrollTop / scrollHeight) * 100));
    readingProgressBar.style.width = `${progress}%`;
  };

  const updateThemeIcons = () => {
    const theme = themeManager.getTheme();
    const icon = theme === 'dark' ? 'dark_mode' : (theme === 'light' ? 'light_mode' : 'child_care');
    if (themeIcon) themeIcon.textContent = icon;
    if (toolbarThemeIcon) toolbarThemeIcon.textContent = icon;
  };

  const cycleTheme = () => {
    themeManager.toggleTheme();
    updateThemeIcons();
  };

  applyFontSize(resolveInitialFontSize());
  applyReadingMode(localStorage.getItem(READING_MODE_KEY) === 'true');
  updateThemeIcons();

  // Reading toolbar events
  if (decreaseFontBtn) decreaseFontBtn.addEventListener('click', () => changeFontSize(-1));
  if (increaseFontBtn) increaseFontBtn.addEventListener('click', () => changeFontSize(1));
  if (fontSizeSlider) {
    fontSizeSlider.addEventListener('input', (e) => applyFontSize(parseInt(e.target.value, 10)));
  }
  if (exitReadingModeBtn) exitReadingModeBtn.addEventListener('click', () => applyReadingMode(false));
  if (readingModeFooterBtn) readingModeFooterBtn.addEventListener('click', toggleReadingMode);
  if (readingModeToggle) readingModeToggle.addEventListener('change', (e) => applyReadingMode(e.target.checked));
  if (toolbarTtsBtn) toolbarTtsBtn.addEventListener('click', speakLastAiMessage);

  const updateTtsToggleUi = () => {
    const enabled = ttsToggle ? ttsToggle.checked : false;
    if (toolbarTtsBtn) {
      toolbarTtsBtn.classList.toggle('active', enabled);
      toolbarTtsBtn.title = enabled ? 'Dengarkan pesan terakhir (TTS aktif)' : 'Aktifkan TTS dulu di pengaturan';
    }
  };
  if (ttsToggle) ttsToggle.addEventListener('change', updateTtsToggleUi);
  if (toolbarThemeBtn) toolbarThemeBtn.addEventListener('click', cycleTheme);
  if (toolbarSettingsBtn) toolbarSettingsBtn.addEventListener('click', openSettings);

  // Theme header button
  if (themeToggleBtn) themeToggleBtn.addEventListener('click', cycleTheme);

  // Reading toolbar keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && readingMode) {
      applyReadingMode(false);
      return;
    }
    const target = e.target;
    if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable)) return;
    if (e.key === 't' || e.key === 'T') {
      cycleTheme();
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      if (e.key === 'ArrowUp' || e.key === '+') {
        e.preventDefault();
        changeFontSize(1);
      } else if (e.key === 'ArrowDown' || e.key === '-') {
        e.preventDefault();
        changeFontSize(-1);
      } else if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        toggleReadingMode();
      }
    }
  });

  // --- Drawer Logic ---
  function openSettings() {
    settingsPanel.classList.remove('hidden');
    setTimeout(() => {
      settingsDrawer.classList.remove('translate-x-full');
      settingsBackdrop.classList.add('opacity-100');
    }, 10);
  }

  function closeSettings() {
    settingsDrawer.classList.add('translate-x-full');
    settingsBackdrop.classList.remove('opacity-100');
    setTimeout(() => {
      settingsPanel.classList.add('hidden');
    }, 300);
  }

  if (settingsToggleBtn) settingsToggleBtn.addEventListener('click', openSettings);
  if (closeSettingsBtn) closeSettingsBtn.addEventListener('click', closeSettings);
  if (settingsBackdrop) settingsBackdrop.addEventListener('click', closeSettings);

  // --- AI Provider Error Dialog ---
  const openAiErrorDialog = (errorMessage) => {
    if (aiErrorMessage) aiErrorMessage.textContent = errorMessage || 'AI provider sedang tidak tersedia.';
    aiErrorDialog.classList.remove('hidden');
    setTimeout(() => {
      aiErrorPanel.classList.remove('scale-95', 'opacity-0');
      aiErrorPanel.classList.add('scale-100', 'opacity-100');
    }, 10);
  };

  const closeAiErrorDialog = () => {
    _clearAiErrorHandlers();
    aiErrorPanel.classList.remove('scale-100', 'opacity-100');
    aiErrorPanel.classList.add('scale-95', 'opacity-0');
    setTimeout(() => {
      aiErrorDialog.classList.add('hidden');
      pendingError = null;
      pendingUserBubble = null;
      pendingAiBubble = null;
    }, 200);
  };

  if (aiErrorBackdrop) aiErrorBackdrop.addEventListener('click', closeAiErrorDialog);

  const openMemoryModal = async () => {
    closeSettings();
    memoryModal.classList.remove('hidden');
    setTimeout(() => {
      memoryDialog.classList.remove('scale-95', 'opacity-0');
      memoryDialog.classList.add('scale-100', 'opacity-100');
    }, 10);

    memoryList.innerHTML = `<div class="flex justify-center p-4"><span class="material-icons-round animate-spin text-theme-accent">autorenew</span></div>`;

    try {
      const res = await api.get(`/stories/${storyId}`);
      const storyData = res.data?.story ?? res.data;

      let mems = [];
      const rawMem = storyData?.dynamic_memory;
      if (rawMem) {
        let parsed;
        if (typeof rawMem === 'string') {
          try { parsed = JSON.parse(rawMem); } catch { parsed = null; }
        } else {
          parsed = rawMem;
        }
        if (Array.isArray(parsed)) {
          mems = parsed;
        } else if (parsed && Array.isArray(parsed.facts)) {
          mems = parsed.facts;
        }
      }

      factCountBadge.textContent = `${mems.length} fakta`;

      if (mems.length === 0) {
        memoryList.innerHTML = `<p class="text-sm text-theme-muted text-center py-6">Belum ada fakta yang diingat AI.</p>`;
      } else {
        const escapeHtml2 = (s) => String(s ?? '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#039;');
        memoryList.innerHTML = mems.map(fact => {
          const category = fact.category ?? 'umum';
          const key = fact.key ?? '';
          const value = fact.value ?? fact.fact ?? fact.content ?? '';
          const learned = fact.learned_at ? new Date(fact.learned_at).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' }) : '';
          return `
            <div class="p-3 bg-theme-bg rounded-xl border border-theme-border/30 mb-2 shadow-sm">
              <div class="flex justify-between items-start mb-1 gap-2">
                <span class="text-xs font-semibold text-theme-accent bg-theme-accent/10 px-2 py-0.5 rounded uppercase tracking-wider truncate">${escapeHtml2(category)}</span>
                <span class="text-[10px] text-theme-muted whitespace-nowrap">${learned}</span>
              </div>
              ${key ? `<p class="text-[11px] text-theme-muted font-mono mb-1">${escapeHtml2(key)}</p>` : ''}
              <p class="text-sm text-theme-text mt-1 leading-relaxed">${escapeHtml2(value)}</p>
            </div>
          `;
        }).join('');
      }
    } catch (err) {
      memoryList.innerHTML = `<p class="text-sm text-red-500 text-center py-6">Gagal memuat memori.</p>`;
    }
  };

  const closeMemoryWindow = () => {
    memoryDialog.classList.remove('scale-100', 'opacity-100');
    memoryDialog.classList.add('scale-95', 'opacity-0');
    setTimeout(() => {
      memoryModal.classList.add('hidden');
    }, 200);
  };

  if (viewMemoryBtn) viewMemoryBtn.addEventListener('click', openMemoryModal);
  if (closeMemoryBtn) closeMemoryBtn.addEventListener('click', closeMemoryWindow);
  if (memoryBackdrop) memoryBackdrop.addEventListener('click', closeMemoryWindow);

  // --- TTS Initialization ---
  // Pack-based: 2 pilihan (Indonesian / English US). Tidak pakai list browser
  // voices lagi — setiap pack berisi 1 male + 1 female Neural voice dari EdgeTTS,
  // dan Web Speech API fallback otomatis pakai locale yang sama.
  const initTTS = async () => {
    await ttsEngine.init();
    // Voice dibaca dari currentStory.tts_voice (sumber kebenaran: SQL kolom
    // stories.tts_voice). Populated di loadStoryAndMessages() setelah fetch
    // story berhasil. Jangan pakai localStorage — tidak reliable cross-session.
  };

  if (avatarEnabledToggle && avatarUrlInput) {
    const setAvatarError = (msg) => {
      if (!avatarUrlError) return;
      if (msg) {
        avatarUrlError.textContent = msg;
        avatarUrlError.classList.remove('hidden');
      } else {
        avatarUrlError.textContent = '';
        avatarUrlError.classList.add('hidden');
      }
    };
    const scheduleSave = () => {
      if (!currentStory) return;
      if (avatarSaveTimer) clearTimeout(avatarSaveTimer);
      avatarSaveTimer = setTimeout(async () => {
        if (!currentStory) return;
        const wantsEnabled = !!avatarEnabledToggle.checked;
        const rawUrl = avatarUrlInput.value;
        const url = rawUrl.trim();
        if (wantsEnabled && !url) {
          // Auto-disable sesuai requirement: enable tanpa URL → paksa off + error toast.
          avatarEnabledToggle.checked = false;
          setAvatarError('Aktifkan toggle membutuhkan URL gambar.');
          currentStory.avatar_enabled = 0;
        } else if (wantsEnabled && !isValidAvatarUrl(url)) {
          setAvatarError('URL tidak valid. Gunakan http/https, max 2048 karakter.');
          currentStory.avatar_enabled = 0;
          avatarEnabledToggle.checked = false;
        } else {
          setAvatarError('');
          if (currentStory.avatar_enabled !== (wantsEnabled ? 1 : 0) ||
              (currentStory.avatar_url ?? null) !== (url || null)) {
            currentStory.avatar_enabled = wantsEnabled ? 1 : 0;
            currentStory.avatar_url = url || null;
            try {
              await apiClient.updateStory(currentStory.id, {
                avatar_enabled: currentStory.avatar_enabled === 1,
                avatar_url: currentStory.avatar_url,
              });
              // Refresh semua avatar in-place supaya dashboard/profil sinkron.
              renderAvatarInto(headerAvatar, currentStory);
              document.querySelectorAll('.ai-avatar-slot').forEach((node) => {
                renderAvatarInto(node, currentStory, { sizeClasses: 'w-8 h-8 sm:w-9 sm:h-9 text-sm' });
              });
            } catch (err) {
              console.warn('[avatar] gagal simpan:', err?.message);
              setAvatarError(err?.message || 'Gagal menyimpan.');
            }
          }
        }
      }, 350);
    };
    avatarEnabledToggle.addEventListener('change', scheduleSave);
    avatarUrlInput.addEventListener('input', () => {
      const url = avatarUrlInput.value.trim();
      if (avatarUrlPreviewWrap && avatarUrlPreview) {
        if (isValidAvatarUrl(url)) {
          avatarUrlPreview.src = url;
          avatarUrlPreviewWrap.classList.remove('hidden');
          setAvatarError('');
        } else if (!url) {
          avatarUrlPreviewWrap.classList.add('hidden');
          setAvatarError('');
        } else {
          avatarUrlPreviewWrap.classList.add('hidden');
        }
      }
      scheduleSave();
    });
  }

  if (voicePack) voicePack.addEventListener('change', async (e) => {
    const newVoice = (e.target.value || '').toString();
    if (!newVoice) return;
    const story = __currentStoryCache || currentStory;
    if (!story || !story.id) {
      console.warn('[tts] voicePack change tanpa currentStory — abort save.');
      return;
    }
    // Optimistic update ke local + module-cache supaya speakMessage berikutnya
    // langsung pakai voice baru tanpa refresh.
    currentStory.tts_voice = newVoice;
    __currentStoryCache.tts_voice = newVoice;
    try {
      await apiClient.updateStory(story.id, { tts_voice: newVoice });
      console.log('[tts] voicePack saved to story:', newVoice);
    } catch (err) {
      console.warn('[tts] gagal simpan tts_voice ke story:', err?.message);
    }
  });

  // ttsToggle dihapus dari UI — TTS selalu ON.
  updateTtsToggleUi();

  EventBus.on(Events.TTS_START, () => {
    if (ttsIndicator) {
      ttsIndicator.classList.remove('hidden');
      ttsIndicator.classList.add('flex');
    }
  });

  EventBus.on(Events.TTS_END, () => {
    if (ttsIndicator) {
      ttsIndicator.classList.add('hidden');
      ttsIndicator.classList.remove('flex');
    }
  });


  // --- Chat Logic ---

  const stripReasoningContent = (text) => {
    if (typeof text !== 'string') return text;
    const tags = ['ctrl32', 'think', 'reasoning', 'thought', 'analysis'];
    let cleaned = text;
    for (const tag of tags) {
      cleaned = cleaned.replace(new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), '');
      cleaned = cleaned.replace(new RegExp(`<\\/${tag}>`, 'gi'), '');
    }
    cleaned = cleaned.replace(/<ctrl32>.*?<\/ctrl32>/gi, '');
    cleaned = cleaned.replace(/<ctrl32>/gi, '');
    return cleaned;
  };

  const finalizeResponse = (text) => {
    let cleaned = stripReasoningContent(text);
    cleaned = cleaned.replace(/\[(MIKA|NARASI|AI|KARAKTER)\]\s*/gi, '');
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
    return cleaned.trim();
  };

  const formatTextWithMarkdown = (text) => {
    if (!text) return '';
    try {
      let parsed = renderMarkdown(text);
      parsed = parsed.replace(/<notts>([\s\S]*?)<\/notts>/g, '<span class="text-theme-muted italic">*$1*</span>');
      parsed = parsed.replace(/<tts>([\s\S]*?)<\/tts>/g, '$1');
      parsed = parsed.replace(/\[(MIKA|NARASI|AI|KARAKTER)\]\s*/gi, '');
      return parsed;
    } catch (err) {
      console.warn('[story] markdown render error:', err);
      return escapeHtml(text).replace(/\n/g, '<br>');
    }
  };

  const escapeHtml = (str) => {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  };

  const updateBubbleContent = (bubble, text, isTyping = false) => {
    const contentEl = bubble.querySelector('.msg-content');
    if (!contentEl) return;
    let html = formatTextWithMarkdown(text);
    if (isTyping) html += '<span class="inline-block w-2 h-4 bg-theme-accent animate-pulse ml-1 align-middle"></span>';
    contentEl.innerHTML = html;
  };

  /**
   * Bubbles yang di-streaming dibuat dengan temp id (`temp-${Date.now()}`,
   * `ai-${Date.now()}`). Setelah backend konfirmasi id final via SSE 'meta'
   * (untuk user) atau 'done' (untuk AI), kita update DOM references. SEBELUM
   * fix ini, hanya satu `.tts-btn` (play button) yang di-update — toolbar +
   * 4 tombol lain (loading/pause/resume/stop) tetap pakai temp id. Akibatnya
   * saat user klik play, currentUtterance.id jadi id real, tapi toolbar
   * masih pakai temp id → `updateGlobalTtsButtons` tidak match → toolbar
   * stuck di `idle` (volume_up icon) meskipun audio sudah mulai bunyi.
   * Sekarang: update toolbar + SEMUA button + re-eval state real-time.
   */
  const setBubbleRealId = (bubble, realId) => {
    if (!bubble || realId == null) return;
    bubble.id = `msg-${realId}`;
    const newIdStr = String(realId);
    const toolbar = bubble.querySelector('.tts-toolbar');
    if (toolbar) {
      toolbar.setAttribute('data-msg-id', newIdStr);
    }
    // Update semua action buttons (play/loading/pause/resume/stop) di
    // bubble ini. Hindari pakai `.tts-btn` saja karena itu hanya match
    // play + loading (keduanya `tts-play-icon tts-btn`).
    bubble.querySelectorAll('[data-action]').forEach((btn) => {
      btn.setAttribute('data-msg-id', newIdStr);
    });
    // Kalau state machine aktif sudah menunjuk message ini (clicks happened
    // sebelumnya dengan temp id, atau user langsung klik setelah streaming
    // selesai supaya match → toolbar bergerak ke state yang betul.
    if (currentUtterance && String(currentUtterance.id) === newIdStr) {
      updateGlobalTtsButtons();
    }
  };

  const createMessageBubble = (msg) => {
    const isUser = msg.role === 'user';
    const div = document.createElement('div');
    div.className = `flex w-full ${isUser ? 'justify-end' : 'justify-start'} mb-5 sm:mb-6 group msg-entrance`;
    div.id = `msg-${msg.id}`;

    const messageContent = (msg.content ?? msg.raw_content ?? '').toString();
    const contentHtml = formatTextWithMarkdown(messageContent);
    const timeLabel = new Date(msg.created_at).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });

    if (isUser) {
      div.innerHTML = `
        <div class="msg-user-block" style="display:block !important;max-width:min(280px,70vw) !important;width:auto !important;flex:0 1 auto !important;text-align:right;">
           <div class="msg-content shadow-sm" style="display:inline-block !important;padding:5px 10px !important;line-height:1.2 !important;border-radius:14px !important;border-top-right-radius:4px !important;background-color:rgb(var(--theme-hover)/0.7) !important;color:rgb(var(--theme-text)) !important;font-family:'DM Sans',sans-serif !important;font-size:14px !important;border:1px solid rgb(var(--theme-border) / 0.3) !important;max-width:100% !important;word-break:break-word !important;white-space:pre-wrap !important;overflow-wrap:break-word !important;">
             ${contentHtml}
           </div>
           <span class="msg-time" style="display:block;width:100%;text-align:right;margin-top:2px;font-size:10px;color:rgb(var(--theme-muted));">${timeLabel}</span>
        </div>
      `;
    } else {
      const avatarHtml = isAvatarActive(currentStory)
        ? `<img src="${escapeHtmlAttr(currentStory.avatar_url)}" alt="${escapeHtmlAttr(currentStory.ai_name)}" class="avatar ai-avatar-slot w-8 h-8 sm:w-9 sm:h-9 rounded-full object-cover" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'avatar',textContent:'${currentStory.ai_name.charAt(0).toUpperCase()}'}))" />`
        : `<div class="avatar" aria-hidden="true">${currentStory.ai_name.charAt(0).toUpperCase()}</div>`;
      div.innerHTML = `
        <div class="msg-ai-block">
          ${avatarHtml}
          <div class="flex flex-col items-start min-w-0 flex-1">
             <span class="msg-author">${currentStory.ai_name}</span>
             <div class="msg-content prose-story">
               ${contentHtml}
               ${msg.is_typing ? '<span class="inline-block w-2 h-4 bg-theme-accent animate-pulse ml-1 align-middle"></span>' : ''}
             </div>
             <div class="flex items-center gap-2 mt-1.5 pl-1">
               <span class="tts-time text-[10px] text-theme-muted opacity-0 group-hover:opacity-100 transition-opacity">${timeLabel}</span>
               <div class="tts-toolbar" data-state="idle" data-msg-id="${msg.id}" data-text="${encodeURIComponent(messageContent)}">
                 <button class="tts-play-icon tts-btn" data-action="play" data-msg-id="${msg.id}" data-text="${encodeURIComponent(messageContent)}" title="Dengarkan">
                   <span class="material-icons-round text-[14px]">volume_up</span>
                 </button>
                 <button class="tts-play-icon tts-btn hidden" data-action="loading" data-msg-id="${msg.id}" title="Memuat audio…" disabled>
                   <span class="material-icons-round text-[14px] animate-spin">hourglass_top</span>
                 </button>
                 <button class="tts-pause-btn hidden" data-action="pause" data-msg-id="${msg.id}" title="Jeda">
                   <span class="material-icons-round text-[14px]">pause</span>
                 </button>
                 <button class="tts-resume-btn hidden" data-action="resume" data-msg-id="${msg.id}" title="Lanjutkan">
                   <span class="material-icons-round text-[14px]">play_arrow</span>
                 </button>
                 <button class="tts-stop-btn hidden" data-action="stop" data-msg-id="${msg.id}" title="Hentikan">
                   <span class="material-icons-round text-[14px]">stop</span>
                 </button>
               </div>
             </div>
          </div>
        </div>
      `;
      // Single delegated click handler on toolbar: route by data-action.
      const toolbar = div.querySelector('.tts-toolbar');
      if (toolbar) {
        toolbar.addEventListener('click', (ev) => {
          ev.stopPropagation();
          const btn = ev.target.closest('[data-action]');
          if (!btn) return;
          const action = btn.getAttribute('data-action');
          const id = btn.getAttribute('data-msg-id');
          if (action === 'play') {
            const segs = _readSegments(btn);
            if (segs && Array.isArray(segs) && segs.length > 0) {
              speakMessage(id, segs);
              return;
            }
            let text = decodeURIComponent(btn.getAttribute('data-text') || '');
            if (!text || !text.trim()) {
              const msgContentEl = div.querySelector('.msg-content');
              if (msgContentEl) {
                text = msgContentEl.textContent || msgContentEl.innerText || '';
              }
            }
            speakMessage(id, text);
          } else if (action === 'pause') {
            pauseSpeaking();
          } else if (action === 'resume') {
            resumeSpeaking();
          } else if (action === 'stop') {
            stopSpeaking();
          }
        });
      }
    }
    return div;
  };

  const loadStoryAndMessages = async () => {
    try {
      const res = await api.get(`/stories/${storyId}`);
      if (!res.success) throw new Error('Story not found');

      currentStory = res.data?.story ?? res.data;
      // Mirror ke module-level cache supaya speakMessage (dideklarasikan di
      // module scope, sebelum DOMContentLoaded) bisa baca via resolveStoryVoice().
      __currentStoryCache = currentStory;

      if (!currentStory?.ai_name) throw new Error('Data cerita tidak valid dari server.');

      headerAiName.textContent = currentStory.ai_name;
      renderAvatarInto(headerAvatar, currentStory);
      headerContext.textContent = `Roleplay dengan ${currentStory.ai_name} (${currentStory.language_style ?? ''})`.trim();

      // Populate avatar settings from currentStory.
      if (avatarEnabledToggle && avatarUrlInput) {
        avatarEnabledToggle.checked = isAvatarActive(currentStory);
        avatarUrlInput.value = (currentStory.avatar_url ?? '').toString();
        if (avatarUrlPreviewWrap && avatarUrlPreview) {
          if (isValidAvatarUrl(avatarUrlInput.value)) {
            avatarUrlPreview.src = avatarUrlInput.value;
            avatarUrlPreviewWrap.classList.remove('hidden');
          } else {
            avatarUrlPreviewWrap.classList.add('hidden');
          }
        }
        if (avatarUrlError) avatarUrlError.classList.add('hidden');
      }

      const dynamicMem = currentStory.dynamic_memory;
      if (dynamicMem) {
        let parsed = null;
        if (typeof dynamicMem === 'string') {
          try { parsed = JSON.parse(dynamicMem); } catch { parsed = null; }
        } else {
          parsed = dynamicMem;
        }
        let facts = [];
        if (Array.isArray(parsed)) {
          facts = parsed;
        } else if (parsed && Array.isArray(parsed.facts)) {
          facts = parsed.facts;
        }
        factCountBadge.textContent = `${facts.length} fakta`;
      }

      // Voice dropdown di-populate dari currentStory.tts_voice (sumber kebenaran
      // = SQL kolom stories.tts_voice). Default Indonesian male kalau story
      // belum pernah diset (legacy row pre-migration).
      const voiceFromStory = (currentStory.tts_voice || '').toString();
      const fallbacks = ['id-ID-ArdiNeural', 'id-ID-GadisNeural', 'en-US-GuyNeural', 'en-US-JennyNeural'];
      const settledVoice = fallbacks.includes(voiceFromStory) ? voiceFromStory : 'id-ID-ArdiNeural';
      if (currentStory.tts_voice !== settledVoice) {
        // Backfill default ke memory (juga ke SQL via patch later — avoids hitting DB on every load).
        currentStory.tts_voice = settledVoice;
      }
      if (voicePack) voicePack.value = settledVoice;

      // SYNC warmup untuk story's chosen voice: blocking sampai cache ready
      // atau 25s timeout. Tujuannya = first user click dijamin instant response.
      if (loadingChat) {
        loadingChat.innerHTML = `
          <div class="flex flex-col items-center gap-2">
            <span class="material-icons-round animate-spin text-theme-accent text-3xl">autorenew</span>
            <span class="text-xs text-theme-muted">Menyiapkan suara: ${settledVoice.replace(/^([^-]+-[^-]+).*/, '$1')}</span>
          </div>
        `;
      }
      let warmReady = false;
      try {
        const r = await apiClient.warmupTts({ voice: settledVoice, wait: true });
        warmReady = r?.data?.ready === true;
        console.log('[tts-warm] sync warmup result:', r);
      } catch (err) {
        console.warn('[tts-warm] sync warmup error:', err?.message);
      }
      if (!warmReady) {
        console.warn(`[tts-warm] sync warmup timeout/incomplete untuk ${settledVoice}. First click mungkin slow.`);
      }

      // Background warm untuk 3 other voices (tidak blok UI).
      try {
        const others = fallbacks.filter((v) => v !== settledVoice);
        others.forEach((voice, i) => {
          setTimeout(() => apiClient.warmupTts({ voice }).catch(() => {}), 500 * (i + 1));
        });
      } catch { /* ignore */ }

      const msgRes = await api.get(`/stories/${storyId}/messages`);
      const messages = msgRes.data?.messages ?? msgRes.data ?? [];
      // Fetch TTS cache untuk setiap assistant message (mixed-mode replay).
      // Backend route /tts-latest return { items: [{ message_id, segments, ... }] }
      // dengan segments SUDAH parsed array (bukan segments_json string).
      let ttsByMessageId = {};
      try {
        const ttsRes = await api.get(`/stories/${storyId}/messages/tts-latest`);
        const allTts = ttsRes.data?.items ?? ttsRes.data ?? [];
        if (Array.isArray(allTts)) {
          for (const entry of allTts) {
            let segs = null;
            if (Array.isArray(entry?.segments)) {
              segs = entry.segments;
            } else if (typeof entry?.segments_json === 'string') {
              try { segs = JSON.parse(entry.segments_json); } catch { /* ignore */ }
            }
            if (Array.isArray(segs) && segs.length > 0 && entry?.message_id != null) {
              ttsByMessageId[entry.message_id] = segs;
            }
          }
          console.log(`[load] /tts-latest populated ${Object.keys(ttsByMessageId).length} messages with TTS segments.`);
        }
      } catch (err) {
        console.warn('[load] /tts-latest fetch gagal:', err?.message);
      }

      loadingChat.classList.add('hidden');
      chatList.innerHTML = '';

      if (messages.length === 0) {
        chatList.innerHTML = `
          <div class="text-center py-12 text-theme-muted">
             <div class="w-16 h-16 mx-auto bg-theme-hover rounded-full flex items-center justify-center mb-4">
               <span class="material-icons-round text-3xl">waving_hand</span>
             </div>
             <p class="text-sm">Mulai percakapan dengan <strong>${currentStory.ai_name}</strong>.</p>
          </div>
        `;
      } else {
        messages.forEach(m => {
          const bubble = createMessageBubble(m);
          if (m.role === 'assistant' && ttsByMessageId[m.id]) {
            const segs = ttsByMessageId[m.id];
            currentAudioSegments[m.id] = segs;
            const ttsBtn = bubble.querySelector('.tts-btn');
            if (ttsBtn) {
              _stashSegments(ttsBtn, segs);
              ttsBtn.title = `Dengarkan (${segs.length} segmen)`;
            }
          }
          chatList.appendChild(bubble);
        });
        scrollToBottom(true);
      }

    } catch (err) {
      console.error(err);
    }
  };

  const scrollToBottom = (force = false) => {
    if (force || autoScroll) {
      chatContainer.scrollTo({
        top: chatContainer.scrollHeight,
        behavior: force ? 'auto' : 'smooth'
      });
    }
  };

  chatContainer.addEventListener('scroll', () => {
    const isAtBottom = chatContainer.scrollHeight - chatContainer.scrollTop <= chatContainer.clientHeight + 100;
    autoScroll = isAtBottom;
    updateProgressBar();

    if (!isAtBottom) {
      scrollToBottomBtn.classList.remove('opacity-0');
    } else {
      scrollToBottomBtn.classList.add('opacity-0');
    }
  });

  scrollToBottomBtn.addEventListener('click', () => {
    scrollToBottom(true);
  });

  messageInput.addEventListener('input', () => {
    messageInput.style.height = 'auto';
    messageInput.style.height = Math.min(messageInput.scrollHeight, 150) + 'px';
    sendBtn.disabled = messageInput.value.trim() === '';
  });

  messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!sendBtn.disabled) {
        chatForm.dispatchEvent(new Event('submit'));
      }
    }
  });

  // Streaming SSE
  chatForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (isAiResponding) return;

    const content = messageInput.value.trim();
    if (!content) return;

    if (chatList.querySelector('.text-center.py-12')) {
      chatList.innerHTML = '';
    }

    const tempUserId = `temp-${Date.now()}`;
    const userMsg = { id: tempUserId, role: 'user', content, created_at: new Date().toISOString() };
    const userBubble = createMessageBubble(userMsg);
    chatList.appendChild(userBubble);

    messageInput.value = '';
    messageInput.style.height = 'auto';
    sendBtn.disabled = true;
    scrollToBottom(true);

    isAiResponding = true;
    typingIndicator.classList.remove('hidden');
    typingIndicator.classList.add('flex');
    messageInput.disabled = true;

    const tempAiId = `ai-${Date.now()}`;
    const aiMsgObj = { id: tempAiId, role: 'assistant', content: '', is_typing: true, created_at: new Date().toISOString() };
    const aiBubble = createMessageBubble(aiMsgObj);
    chatList.appendChild(aiBubble);
    scrollToBottom();

    let displayedText = '';
    let userMessageId = null;
    let aiMessageId = null;
    let providerError = null;

    // Dialog button handlers for this request
    const onContinue = async () => {
      if (!pendingUserBubble || !pendingAiBubble) return;
      continueErrorBtn.disabled = true;
      try {
        const res = await api.post(`/stories/${storyId}/messages/fallback`, {
          user_content: content,
          error_message: providerError?.message || '',
        });
        if (res.success) {
          const fallbackContent = res.data?.content ?? res.content;
          updateBubbleContent(pendingAiBubble, fallbackContent, false);
          setBubbleRealId(pendingAiBubble, res.data?.message_id ?? res.message_id);
          const ttsBtn = pendingAiBubble.querySelector('.tts-btn');
          if (ttsBtn) ttsBtn.setAttribute('data-text', encodeURIComponent(fallbackContent));
          scrollToBottom(true);
        } else {
          updateBubbleContent(pendingAiBubble, 'Gagal membuat balasan sementara.', false);
        }
      } catch (err) {
        console.error('Fallback error:', err);
        updateBubbleContent(pendingAiBubble, 'Gagal membuat balasan sementara.', false);
      } finally {
        continueErrorBtn.disabled = false;
        closeAiErrorDialog();
        finishSend();
      }
    };

    const onCancel = () => {
      if (pendingUserBubble) pendingUserBubble.remove();
      if (pendingAiBubble) pendingAiBubble.remove();
      closeAiErrorDialog();
      finishSend();
    };

    _setAiErrorHandlers({ onContinue, onCancel });

    pendingUserBubble = userBubble;
    pendingAiBubble = aiBubble;

    const finishSend = () => {
      _clearAiErrorHandlers();
      isAiResponding = false;
      typingIndicator.classList.add('hidden');
      typingIndicator.classList.remove('flex');
      messageInput.disabled = false;
      messageInput.focus();
    };

    try {
      await api.postSSE(`/stories/${storyId}/messages`, { content }, (eventType, data) => {
        if (eventType === 'meta') {
          userMessageId = data?.user_message_id ?? null;
          if (userMessageId) setBubbleRealId(userBubble, userMessageId);
        } else if (eventType === 'token') {
          const delta = data?.delta ?? data?.text ?? '';
          if (!delta) return;

          const accumulated = displayedText + delta;
          const cleaned = finalizeResponse(accumulated);
          if (cleaned.length > displayedText.length) {
            displayedText = cleaned;
            updateBubbleContent(aiBubble, displayedText, true);
            scrollToBottom();
          }
        } else if (eventType === 'error') {
          providerError = data;
          updateBubbleContent(aiBubble, 'AI provider error: menunggu konfirmasi...', false);
          openAiErrorDialog(data?.message || 'AI provider sedang tidak tersedia.');
        } else if (eventType === 'done') {
          aiMessageId = data?.message_id ?? null;
          // Backend mengirim audio_segments[] untuk mixed-mode TTS (Azure URL + Web Speech fallback).
          // Backend kirim `full_content` = full_story (prosa), sudah bersih dari JSON wrapper.
          const finalContent = data?.full_content ?? displayedText;
          displayedText = finalContent;
          updateBubbleContent(aiBubble, finalContent, false);
          if (aiMessageId) {
            setBubbleRealId(aiBubble, aiMessageId);
            const segs = Array.isArray(data?.audio_segments) ? data.audio_segments : null;
            if (segs && segs.length > 0) {
              currentAudioSegments[aiMessageId] = segs;
              const ttsBtn = aiBubble.querySelector('.tts-btn');
              if (ttsBtn) {
                // Stash segments sebagai JSON di attribute.
                _stashSegments(ttsBtn, segs);
                ttsBtn.setAttribute('data-text', encodeURIComponent(finalContent));
                ttsBtn.title = `Dengarkan (${segs.length} segmen)`;
              }
            } else {
              const ttsBtn = aiBubble.querySelector('.tts-btn');
              if (ttsBtn) ttsBtn.setAttribute('data-text', encodeURIComponent(finalContent));
            }
          }
        }
      });

      if (!displayedText.trim() && !providerError) {
        updateBubbleContent(aiBubble, 'AI tidak mengembalikan balasan.', false);
      }

      if (!providerError) finishSend();

    } catch (err) {
      console.error(err);
      providerError = { message: err.message };
      updateBubbleContent(aiBubble, 'AI provider error: menunggu konfirmasi...', false);
      openAiErrorDialog(err.message || 'AI provider sedang tidak tersedia.');
    } finally {
      _clearAiErrorHandlers();
      if (_factPollTimerId !== null) clearTimeout(_factPollTimerId);
      _factPollTimerId = setTimeout(async () => {
        _factPollTimerId = null;
        try {
          const res = await api.get(`/stories/${storyId}`);
          const storyData = res.data?.story ?? res.data;
          const rawMem = storyData?.dynamic_memory;
          if (rawMem) {
            let parsed;
            if (typeof rawMem === 'string') {
              try { parsed = JSON.parse(rawMem); } catch { parsed = null; }
            } else {
              parsed = rawMem;
            }
            let facts = [];
            if (Array.isArray(parsed)) facts = parsed;
            else if (parsed && Array.isArray(parsed.facts)) facts = parsed.facts;
            factCountBadge.textContent = `${facts.length} fakta`;
          }
        } catch (e) { }
      }, 5000);
    }
  });

  // Init
  initTTS();
  loadStoryAndMessages();

  window.addEventListener('pagehide', () => {
    if (_factPollTimerId !== null) {
      clearTimeout(_factPollTimerId);
      _factPollTimerId = null;
    }
  }, { once: true });
});
