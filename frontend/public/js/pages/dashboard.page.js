import { api } from '../core/api.js';
import { themeManager } from '../core/themeManager.js';

document.addEventListener('DOMContentLoaded', async () => {
  themeManager.init();

  const themeToggleBtn = document.getElementById('themeToggleBtn');
  const themeIcon = document.getElementById('themeIcon');

  const updateThemeIcon = () => {
    const theme = themeManager.getTheme();
    if (theme === 'dark') themeIcon.textContent = 'dark_mode';
    else if (theme === 'light') themeIcon.textContent = 'light_mode';
    else themeIcon.textContent = 'child_care';
  };

  updateThemeIcon();

  themeToggleBtn.addEventListener('click', () => {
    themeManager.toggleTheme();
    updateThemeIcon();
  });

  const storiesList = document.getElementById('storiesList');
  const emptyState = document.getElementById('emptyState');
  const storiesSkeleton = document.getElementById('storiesSkeleton');
  const sessionCount = document.getElementById('sessionCount');
  const createStoryForm = document.getElementById('createStoryForm');
  const errorBanner = document.getElementById('errorBanner');
  const createBtn = document.getElementById('createBtn');
  const languageStyleSelect = document.getElementById('languageStyle');
  const customLanguageStyleWrapper = document.getElementById('customLanguageStyleWrapper');
  const customLanguageStyleInput = document.getElementById('customLanguageStyle');
  const userPersonaInput = document.getElementById('userPersona');
  const generateBtn = document.getElementById('generateBtn');
  const aiPromptGenerator = document.getElementById('aiPromptGenerator');

  // Delete modal elements
  const deleteModal = document.getElementById('deleteModal');
  const deleteDialog = document.getElementById('deleteDialog');
  const deleteBackdrop = document.getElementById('deleteBackdrop');
  const deleteTargetName = document.getElementById('deleteTargetName');
  const cancelDeleteBtn = document.getElementById('cancelDeleteBtn');
  const confirmDeleteBtn = document.getElementById('confirmDeleteBtn');
  let deleteTargetId = null;

  languageStyleSelect.addEventListener('change', (e) => {
    if (e.target.value === 'custom') {
      customLanguageStyleWrapper.classList.remove('hidden');
      customLanguageStyleInput.required = true;
    } else {
      customLanguageStyleWrapper.classList.add('hidden');
      customLanguageStyleInput.required = false;
    }
  });

  const showError = (msg) => {
    errorBanner.textContent = msg;
    errorBanner.classList.remove('hidden');
    setTimeout(() => {
      errorBanner.classList.add('hidden');
    }, 5000);
  };

  const showLoading = (isLoading) => {
    if (isLoading) {
      generateBtn.disabled = true;
      generateBtn.innerHTML = `<span class="material-icons-round animate-spin text-[18px]">autorenew</span><span>Mengisi...</span>`;
    } else {
      generateBtn.disabled = false;
      generateBtn.innerHTML = `<span class="material-icons-round text-[18px]">auto_fix_high</span><span>Generate</span>`;
    }
  };

  generateBtn.addEventListener('click', async () => {
    const prompt = aiPromptGenerator.value.trim();
    if (!prompt) {
      showError('Tulis prompt dulu untuk generate karakter.');
      return;
    }
    errorBanner.classList.add('hidden');
    showLoading(true);

    try {
      const res = await api.post('/generate/character', { prompt });
      if (!res.success || !res.data) {
        showError(res.message || 'Gagal generate karakter.');
        showLoading(false);
        return;
      }
      const d = res.data;
      if (d.user_name) document.getElementById('userName').value = d.user_name;
      if (d.user_gender) document.getElementById('userGender').value = d.user_gender;
      if (d.user_persona) userPersonaInput.value = d.user_persona;
      if (d.ai_name) document.getElementById('aiName').value = d.ai_name;
      if (d.ai_gender) document.getElementById('aiGender').value = d.ai_gender;
      if (d.ai_personality) document.getElementById('aiPersonality').value = d.ai_personality;
      if (d.target_ending) document.getElementById('targetEnding').value = d.target_ending;
      if (d.language_style) {
        const known = Array.from(languageStyleSelect.options).some((o) => o.value === d.language_style);
        if (known) {
          languageStyleSelect.value = d.language_style;
          customLanguageStyleWrapper.classList.add('hidden');
          customLanguageStyleInput.required = false;
        } else {
          languageStyleSelect.value = 'custom';
          customLanguageStyleWrapper.classList.remove('hidden');
          customLanguageStyleInput.required = true;
          customLanguageStyleInput.value = d.language_style;
        }
      }
    } catch (err) {
      showError(err.message || 'Terjadi kesalahan saat generate karakter.');
    } finally {
      showLoading(false);
    }
  });

  const formatRelativeDate = (dateString) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);
    if (diffSeconds < 60) return 'Baru saja';
    if (diffSeconds < 3600) return `${Math.floor(diffSeconds / 60)}m yang lalu`;
    if (diffSeconds < 86400) return `${Math.floor(diffSeconds / 3600)}j yang lalu`;
    if (diffSeconds < 604800) return `${Math.floor(diffSeconds / 86400)}h yang lalu`;
    return date.toLocaleDateString('id-ID', { month: 'short', day: 'numeric' });
  };

  const renderAvatar = (name, gender) => {
    const initial = (name ?? '?').charAt(0).toUpperCase();
    const genderIcon = gender === 'female' ? 'female' : gender === 'male' ? 'male' : 'person';
    return `
      <div class="relative flex-shrink-0">
        <div class="w-14 h-14 sm:w-16 sm:h-16 rounded-full bg-gradient-to-br from-theme-accent/20 to-theme-accent/5 border border-theme-accent/20 flex items-center justify-center text-theme-accent font-bold text-xl sm:text-2xl shadow-sm">
          ${initial}
        </div>
        <div class="absolute -bottom-1 -right-1 w-6 h-6 rounded-full bg-theme-bg border border-theme-border flex items-center justify-center">
          <span class="material-icons-round text-[12px] text-theme-muted">${genderIcon}</span>
        </div>
      </div>
    `;
  };

  const openDeleteModal = (id, name) => {
    deleteTargetId = id;
    deleteTargetName.textContent = name;
    deleteModal.classList.remove('hidden');
    setTimeout(() => {
      deleteDialog.classList.remove('scale-95', 'opacity-0');
      deleteDialog.classList.add('scale-100', 'opacity-100');
    }, 10);
  };

  const closeDeleteModal = () => {
    deleteDialog.classList.remove('scale-100', 'opacity-100');
    deleteDialog.classList.add('scale-95', 'opacity-0');
    setTimeout(() => {
      deleteModal.classList.add('hidden');
      deleteTargetId = null;
    }, 200);
  };

  cancelDeleteBtn.addEventListener('click', closeDeleteModal);
  deleteBackdrop.addEventListener('click', closeDeleteModal);

  confirmDeleteBtn.addEventListener('click', async () => {
    if (!deleteTargetId) return;
    confirmDeleteBtn.disabled = true;
    confirmDeleteBtn.textContent = 'Menghapus...';
    try {
      await api.delete(`/stories/${deleteTargetId}/permanent`);
      closeDeleteModal();
      await loadStories();
    } catch (err) {
      showError(err.message || 'Gagal menghapus sesi.');
    } finally {
      confirmDeleteBtn.disabled = false;
      confirmDeleteBtn.textContent = 'Hapus Permanen';
    }
  });

  const loadStories = async () => {
    storiesSkeleton.classList.remove('hidden');
    storiesList.classList.add('hidden');
    emptyState.classList.add('hidden');

    try {
      const data = await api.get('/stories');
      const stories = data.data?.stories || [];

      storiesSkeleton.classList.add('hidden');
      sessionCount.textContent = `${stories.length} Sesi`;

      if (stories.length === 0) {
        emptyState.classList.remove('hidden');
        return;
      }

      storiesList.classList.remove('hidden');
      storiesList.innerHTML = stories.map((story) => {
        const timeLabel = formatRelativeDate(story.updated_at);
        const aiGender = story.ai_gender ?? 'neutral';
        const userGender = story.user_gender ?? 'neutral';
        const aiPersonality = (story.ai_personality ?? '').trim() || 'Tidak ada deskripsi';
        const languageStyle = (story.language_style ?? 'custom').trim();
        const userName = (story.user_name ?? 'Kamu').trim();

        return `
          <article class="session-card group relative" data-id="${story.id}" aria-label="Sesi roleplay dengan ${story.ai_name}">
            <div class="flex items-center gap-4 cursor-pointer" data-open="${story.id}">
              ${renderAvatar(story.ai_name, aiGender)}
              <div class="flex-1 min-w-0">
                <div class="flex items-start justify-between gap-3 mb-1">
                  <h3 class="text-base sm:text-lg font-bold text-theme-text truncate group-hover:text-theme-accent transition-colors">${story.ai_name}</h3>
                  <time class="text-[11px] sm:text-xs font-medium text-theme-muted whitespace-nowrap bg-theme-hover px-2 py-0.5 rounded-full border border-theme-border/50" datetime="${story.updated_at}">${timeLabel}</time>
                </div>
                <p class="text-sm text-theme-muted truncate mb-2">${userName} &bull; ${aiPersonality}</p>
                <div class="flex flex-wrap items-center gap-2">
                  <span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-theme-accent/10 text-theme-accent border border-theme-accent/10">
                    <span class="material-icons-round text-[12px]">style</span>
                    <span class="capitalize">${languageStyle}</span>
                  </span>
                  <span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-theme-hover text-theme-muted border border-theme-border/50">
                    <span class="material-icons-round text-[12px]">${aiGender === 'female' ? 'female' : 'male'}</span>
                    <span>AI ${aiGender}</span>
                  </span>
                  <span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-theme-hover text-theme-muted border border-theme-border/50">
                    <span class="material-icons-round text-[12px]">${userGender === 'female' ? 'female' : 'male'}</span>
                    <span>User ${userGender}</span>
                  </span>
                </div>
              </div>
            </div>
            <div class="mt-4 flex items-center justify-between border-t border-theme-border/30 pt-3">
              <button class="delete-session-btn text-xs font-semibold text-red-500 hover:text-red-600 flex items-center gap-1 px-2 py-1 rounded-lg hover:bg-red-500/10 transition-colors" data-id="${story.id}" data-name="${story.ai_name}" aria-label="Hapus sesi ${story.ai_name}">
                <span class="material-icons-round text-[16px]">delete</span>
                Hapus
              </button>
              <span class="text-xs font-semibold text-theme-accent flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer" data-open="${story.id}">
                Lanjutkan Chat
                <span class="material-icons-round text-[16px]">arrow_forward</span>
              </span>
            </div>
          </article>
        `;
      }).join('');
    } catch (err) {
      console.error('Failed to load stories', err);
      storiesSkeleton.classList.add('hidden');
      showError('Gagal memuat daftar sesi. Silakan refresh halaman.');
    }
  };

  createStoryForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorBanner.classList.add('hidden');

    const originalBtnText = createBtn.innerHTML;
    createBtn.disabled = true;
    createBtn.innerHTML = `<span class="material-icons-round animate-spin">autorenew</span><span>Membuat Sesi...</span>`;

    let finalLanguageStyle = document.getElementById('languageStyle').value;
    if (finalLanguageStyle === 'custom') {
      finalLanguageStyle = document.getElementById('customLanguageStyle').value.trim();
    }

    const formData = {
      user_name: document.getElementById('userName').value.trim(),
      user_gender: document.getElementById('userGender').value,
      user_persona: userPersonaInput?.value.trim() || undefined,
      ai_name: document.getElementById('aiName').value.trim(),
      ai_gender: document.getElementById('aiGender').value,
      ai_personality: document.getElementById('aiPersonality').value.trim(),
      language_style: finalLanguageStyle,
      target_ending: document.getElementById('targetEnding').value.trim() || undefined,
    };

    try {
      const res = await api.post('/stories', formData);
      if (res.success && res.data) {
        const id = res.data.story_id ?? res.data.id ?? res.data.story?.id;
        if (id) {
          window.location.href = `/story.html?id=${id}`;
        } else {
          showError('ID cerita tidak ditemukan dari server.');
        }
      } else {
        showError(res.message || 'Gagal membuat story.');
      }
    } catch (err) {
      showError(err.message || 'Terjadi kesalahan saat menghubungi server.');
    } finally {
      createBtn.disabled = false;
      createBtn.innerHTML = originalBtnText;
    }
  });

  loadStories();

  // Delegated click handler: avoids per-render listener accumulation when
  // storiesList.innerHTML is reassigned in loadStories().
  if (storiesList) {
    storiesList.addEventListener('click', (e) => {
      const opener = e.target.closest('[data-open]');
      if (opener) {
        const id = opener.getAttribute('data-open');
        window.location.href = `/story.html?id=${id}`;
        return;
      }
      const btn = e.target.closest('.delete-session-btn');
      if (btn) {
        const id = btn.getAttribute('data-id');
        const name = btn.getAttribute('data-name');
        openDeleteModal(id, name);
      }
    });
  }
});
