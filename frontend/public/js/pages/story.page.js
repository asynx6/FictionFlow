import { api } from '../core/api.js';
import { themeManager } from '../core/themeManager.js';
import { Events, EventBus } from '../core/eventBus.js';
import { ttsEngine } from '../core/ttsEngine.js';
import { renderMarkdown } from '../core/markdownRenderer.js';

const currentUtterance = {
  id: null,
  utterance: null,
  isPlaying: false,
  isPaused: false,
};

function stopSpeaking() {
  window.speechSynthesis.cancel();
  currentUtterance.utterance = null;
  currentUtterance.isPlaying = false;
  currentUtterance.isPaused = false;
  EventBus.emit(Events.TTS_END);
  updateGlobalTtsButtons();
}

function pauseSpeaking() {
  if (currentUtterance.isPlaying && !currentUtterance.isPaused) {
    window.speechSynthesis.pause();
    currentUtterance.isPaused = true;
    updateGlobalTtsButtons();
  }
}

function resumeSpeaking() {
  if (currentUtterance.isPaused) {
    window.speechSynthesis.resume();
    currentUtterance.isPaused = false;
    updateGlobalTtsButtons();
  }
}

function updateGlobalTtsButtons() {
  document.querySelectorAll('.tts-btn').forEach((btn) => {
    const msgId = btn.getAttribute('data-msg-id');
    const icon = btn.querySelector('span');
    if (currentUtterance.id === msgId && currentUtterance.isPlaying) {
      icon.textContent = currentUtterance.isPaused ? 'play_arrow' : 'pause';
      btn.title = currentUtterance.isPaused ? 'Lanjutkan' : 'Jeda';
    } else {
      icon.textContent = 'volume_up';
      btn.title = 'Dengarkan';
    }
  });
}

function speakMessage(msgId, text) {
  if (!window.speechSynthesis) return;

  // If already playing this message, toggle pause/resume
  if (currentUtterance.id === msgId && currentUtterance.isPlaying) {
    if (currentUtterance.isPaused) {
      resumeSpeaking();
    } else {
      pauseSpeaking();
    }
    return;
  }

  // Stop any current speech
  stopSpeaking();

  const cleaned = ttsEngine.parseTtsText(text);
  if (!cleaned) return;

  const utterance = new SpeechSynthesisUtterance(cleaned);
  const voices = ttsEngine.getVoices();
  const storedIndex = localStorage.getItem('fictionflow_voice');
  if (storedIndex && voices[storedIndex]) {
    utterance.voice = voices[storedIndex];
  }
  utterance.rate = 1;
  utterance.pitch = 1;

  utterance.onstart = () => {
    currentUtterance.id = msgId;
    currentUtterance.utterance = utterance;
    currentUtterance.isPlaying = true;
    currentUtterance.isPaused = false;
    EventBus.emit(Events.TTS_START);
    updateGlobalTtsButtons();
  };

  utterance.onend = () => {
    if (currentUtterance.id === msgId) {
      stopSpeaking();
    }
  };

  utterance.onerror = () => {
    if (currentUtterance.id === msgId) {
      stopSpeaking();
    }
  };

  window.speechSynthesis.speak(utterance);
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

  // DOM Elements - Header
  const headerAiName = document.getElementById('headerAiName');
  const headerAvatar = document.getElementById('headerAvatar');
  const headerContext = document.getElementById('headerContext');

  // DOM Elements - Settings
  const settingsToggleBtn = document.getElementById('settingsToggleBtn');
  const settingsPanel = document.getElementById('settingsPanel');
  const settingsDrawer = document.getElementById('settingsDrawer');
  const settingsBackdrop = document.getElementById('settingsBackdrop');
  const closeSettingsBtn = document.getElementById('closeSettingsBtn');
  const viewMemoryBtn = document.getElementById('viewMemoryBtn');
  const factCountBadge = document.getElementById('factCountBadge');

  // DOM Elements - Memory Modal
  const memoryModal = document.getElementById('memoryModal');
  const memoryDialog = document.getElementById('memoryDialog');
  const memoryBackdrop = document.getElementById('memoryBackdrop');
  const closeMemoryBtn = document.getElementById('closeMemoryBtn');
  const memoryList = document.getElementById('memoryList');

  // DOM Elements - TTS
  const ttsToggle = document.getElementById('ttsToggle');
  const voiceSelect = document.getElementById('voiceSelect');
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

  // --- Theme Logic ---
  const updateThemeIcon = () => {
    const theme = themeManager.getTheme();
    themeIcon.textContent = theme === 'dark' ? 'dark_mode' : (theme === 'light' ? 'light_mode' : 'child_care');
  };
  updateThemeIcon();
  themeToggleBtn.addEventListener('click', () => {
    themeManager.toggleTheme();
    updateThemeIcon();
  });

  // --- Drawer Logic ---
  const openSettings = () => {
    settingsPanel.classList.remove('hidden');
    setTimeout(() => {
      settingsDrawer.classList.remove('translate-x-full');
      settingsBackdrop.classList.add('opacity-100');
    }, 10);
  };

  const closeSettings = () => {
    settingsDrawer.classList.add('translate-x-full');
    settingsBackdrop.classList.remove('opacity-100');
    setTimeout(() => {
      settingsPanel.classList.add('hidden');
    }, 300);
  };

  settingsToggleBtn.addEventListener('click', openSettings);
  closeSettingsBtn.addEventListener('click', closeSettings);
  settingsBackdrop.addEventListener('click', closeSettings);
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
        if (typeof rawMem === 'string') {
          try { mems = JSON.parse(rawMem)?.facts ?? []; } catch { /* ignore */ }
        } else {
          mems = rawMem.facts ?? [];
        }
      }

      factCountBadge.textContent = `${mems.length} fakta`;

      if (mems.length === 0) {
        memoryList.innerHTML = `<p class="text-sm text-theme-muted text-center py-6">Belum ada fakta yang diingat AI.</p>`;
      } else {
        memoryList.innerHTML = mems.map(fact => `
          <div class="p-3 bg-theme-bg rounded-xl border border-theme-border/30 mb-2 shadow-sm">
            <div class="flex justify-between items-start mb-1">
              <span class="text-xs font-semibold text-theme-accent bg-theme-accent/10 px-2 py-0.5 rounded uppercase tracking-wider">${fact.category ?? 'umum'}</span>
              <span class="text-[10px] text-theme-muted">Tingkat: ${fact.importance_score ?? '?'}/10</span>
            </div>
            <p class="text-sm text-theme-text mt-2 leading-relaxed">${fact.fact ?? fact.content ?? ''}</p>
          </div>
        `).join('');
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

  viewMemoryBtn.addEventListener('click', openMemoryModal);
  closeMemoryBtn.addEventListener('click', closeMemoryWindow);
  memoryBackdrop.addEventListener('click', closeMemoryWindow);

  // --- TTS Initialization ---
  const initTTS = async () => {
    const loaded = await ttsEngine.init();
    if (!loaded) {
      voiceSelect.innerHTML = `<option value="">Browser tidak support TTS</option>`;
      ttsToggle.disabled = true;
      return;
    }

    const voices = ttsEngine.getVoices();
    if (voices.length === 0) {
      voiceSelect.innerHTML = `<option value="">Tidak ada suara tersedia</option>`;
      return;
    }

    voiceSelect.innerHTML = voices.map((v, i) =>
      `<option value="${i}">${v.name} (${v.lang})</option>`
    ).join('');
    voiceSelect.disabled = false;

    const storedVoiceIndex = localStorage.getItem('fictionflow_voice');
    if (storedVoiceIndex && voices[storedVoiceIndex]) {
      voiceSelect.value = storedVoiceIndex;
      ttsEngine.setVoice(storedVoiceIndex);
    }

    const storedTtsState = localStorage.getItem('fictionflow_tts_enabled') === 'true';
    ttsToggle.checked = storedTtsState;
  };

  voiceSelect.addEventListener('change', (e) => {
    ttsEngine.setVoice(e.target.value);
    localStorage.setItem('fictionflow_voice', e.target.value);
  });

  ttsToggle.addEventListener('change', (e) => {
    localStorage.setItem('fictionflow_tts_enabled', e.target.checked);
  });

  EventBus.on(Events.TTS_START, () => {
    ttsIndicator.classList.remove('hidden');
    ttsIndicator.classList.add('flex');
  });

  EventBus.on(Events.TTS_END, () => {
    ttsIndicator.classList.add('hidden');
    ttsIndicator.classList.remove('flex');
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
      // Strip old role tags from displayed messages (data storage remains untouched)
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

  const setBubbleRealId = (bubble, realId) => {
    bubble.id = `msg-${realId}`;
    const ttsBtn = bubble.querySelector('.tts-btn');
    if (ttsBtn) ttsBtn.setAttribute('data-msg-id', realId);
  };

  const createMessageBubble = (msg) => {
    const isUser = msg.role === 'user';
    const div = document.createElement('div');
    div.className = `flex w-full ${isUser ? 'justify-end' : 'justify-start'} mb-5 group`;
    div.id = `msg-${msg.id}`;

    const messageContent = (msg.content ?? msg.raw_content ?? '').toString();
    const contentHtml = formatTextWithMarkdown(messageContent);
    const timeLabel = new Date(msg.created_at).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });

    if (isUser) {
      div.innerHTML = `
        <div class="flex flex-col items-end max-w-[85%] sm:max-w-[75%] md:max-w-[65%]">
           <div class="msg-content inline-block px-3.5 py-2 bg-theme-accent text-white rounded-2xl rounded-tr-md shadow-sm text-[15px] leading-snug break-words whitespace-pre-wrap min-w-0" style="width: fit-content; max-width: 100%;">
             ${contentHtml}
           </div>
           <span class="text-[10px] text-theme-muted mt-1 opacity-0 group-hover:opacity-100 transition-opacity pr-1">${timeLabel}</span>
        </div>
      `;
    } else {
      div.innerHTML = `
        <div class="flex gap-3 max-w-[92%] sm:max-w-[85%] md:max-w-[75%]">
          <div class="w-8 h-8 rounded-full bg-theme-hover flex-shrink-0 flex items-center justify-center font-bold text-sm text-theme-text shadow-sm border border-theme-border/50 mt-0.5">
            ${currentStory.ai_name.charAt(0).toUpperCase()}
          </div>
          <div class="flex flex-col items-start min-w-0">
             <span class="text-xs font-semibold text-theme-muted mb-0.5 pl-1">${currentStory.ai_name}</span>
             <div class="msg-content px-3.5 py-2.5 bg-theme-bg border border-theme-border/50 text-theme-text rounded-2xl rounded-tl-md shadow-sm text-[15px] leading-snug break-words min-w-0 relative" style="width: fit-content; max-width: 100%;">
               ${contentHtml}
               ${msg.is_typing ? '<span class="inline-block w-2 h-4 bg-theme-accent animate-pulse ml-1 align-middle"></span>' : ''}
             </div>
             <div class="flex items-center gap-2 mt-1 pl-1">
               <span class="text-[10px] text-theme-muted opacity-0 group-hover:opacity-100 transition-opacity">${timeLabel}</span>
               <button class="tts-btn text-[10px] text-theme-muted hover:text-theme-accent transition-colors flex items-center gap-0.5" data-msg-id="${msg.id}" data-text="${encodeURIComponent(messageContent)}" title="Dengarkan">
                 <span class="material-icons-round text-[14px]">volume_up</span>
               </button>
             </div>
          </div>
        </div>
      `;
      const ttsBtn = div.querySelector('.tts-btn');
      if (ttsBtn) {
        ttsBtn.addEventListener('click', () => {
          const text = decodeURIComponent(ttsBtn.getAttribute('data-text'));
          const id = ttsBtn.getAttribute('data-msg-id');
          speakMessage(id, text);
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

      if (!currentStory?.ai_name) throw new Error('Data cerita tidak valid dari server.');

      headerAiName.textContent = currentStory.ai_name;
      headerAvatar.textContent = currentStory.ai_name.charAt(0).toUpperCase();
      headerContext.textContent = `Roleplay dengan ${currentStory.ai_name} (${currentStory.language_style ?? ''})`.trim();

      const dynamicMem = currentStory.dynamic_memory;
      if (dynamicMem) {
        let facts = [];
        if (typeof dynamicMem === 'string') {
          try { facts = JSON.parse(dynamicMem)?.facts ?? []; } catch { /* ignore */ }
        } else {
          facts = dynamicMem.facts ?? [];
        }
        factCountBadge.textContent = `${facts.length} fakta`;
      }

      if (!localStorage.getItem('fictionflow_voice')) {
        const isFemale = currentStory.ai_gender === 'female';
        const voices = ttsEngine.getVoices();
        const targetVoice = voices.findIndex(v => {
          const name = v.name.toLowerCase();
          if (isFemale && (name.includes('female') || name.includes('girl') || name.includes('woman') || name.includes('zira'))) return true;
          if (!isFemale && (name.includes('male') || name.includes('boy') || name.includes('man') || name.includes('david'))) return true;
          return false;
        });
        if (targetVoice !== -1) {
          voiceSelect.value = targetVoice;
          ttsEngine.setVoice(targetVoice);
          localStorage.setItem('fictionflow_voice', targetVoice);
        }
      }

      const msgRes = await api.get(`/stories/${storyId}/messages`);
      const messages = msgRes.data?.messages ?? msgRes.data ?? [];

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
          chatList.appendChild(createMessageBubble(m));
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

    continueErrorBtn.addEventListener('click', onContinue, { once: true });
    cancelErrorBtn.addEventListener('click', onCancel, { once: true });

    pendingUserBubble = userBubble;
    pendingAiBubble = aiBubble;

    const finishSend = () => {
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
          const finalContent = finalizeResponse(data?.full_content ?? displayedText);
          displayedText = finalContent;
          updateBubbleContent(aiBubble, finalContent, false);
          if (aiMessageId) setBubbleRealId(aiBubble, aiMessageId);

          // Store TTS text on the real button
          const ttsBtn = aiBubble.querySelector('.tts-btn');
          if (ttsBtn) ttsBtn.setAttribute('data-text', encodeURIComponent(finalContent));
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
      // On network/unexpected error, keep bubbles for user decision instead of auto-reload
    } finally {
      // Memory update in background
      setTimeout(async () => {
        try {
          const res = await api.get(`/stories/${storyId}`);
          const storyData = res.data?.story ?? res.data;
          const rawMem = storyData?.dynamic_memory;
          if (rawMem) {
            let facts = typeof rawMem === 'string'
              ? (JSON.parse(rawMem)?.facts ?? [])
              : (rawMem.facts ?? []);
            factCountBadge.textContent = `${facts.length} fakta`;
          }
        } catch (e) { }
      }, 5000);
    }
  });

  // Init
  initTTS();
  loadStoryAndMessages();
});
