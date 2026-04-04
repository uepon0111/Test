/**
 * app.js — Main orchestrator for Sonora
 *
 * Responsibilities:
 *   - Boot sequence (Storage → Player → Drive → UI)
 *   - Page / tab navigation
 *   - File upload orchestration
 *   - Track / playlist / tag CRUD (calls Storage + Drive + UI)
 *   - Reset flows
 */

const App = (() => {

  /* ─────────────────────────────────────────
     STATE
  ───────────────────────────────────────── */
  let _currentPage = 'player';

  /* ─────────────────────────────────────────
     BOOT
  ───────────────────────────────────────── */
  async function boot() {
    try {
      // 1. Open IndexedDB
      await Storage.open();

      // 2. Init sub-modules
      Player.init();
      Drive.init();
      UI.init();

      // 3. Load data & render initial UI
      await UI.loadData();
      UI.renderPlaylistTabs();
      UI.applySort();

      // 4. Restore player state (last track info, volume, etc.)
      await Player.restoreState();

      // 5. Render log overview (it's not the active tab yet, but pre-load stats)
      // Deferred until user navigates there

      // 6. Initial page is 'player'
      switchPage('player');

      // 7. Portrait header: show mini-player only on player page
      UI.onPageSwitch('player');

      console.log('[Sonora] Boot complete');
    } catch (err) {
      console.error('[Sonora] Boot error:', err);
      UI.toast('初期化エラー: ' + (err.message || '不明'), 'error');
    }
  }

  /* ─────────────────────────────────────────
     PAGE NAVIGATION
  ───────────────────────────────────────── */
  function switchPage(name) {
    _currentPage = name;

    // Landscape: sidebar nav highlight
    document.querySelectorAll('.nav-item').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.page === name);
    });

    // Show/hide pages
    document.querySelectorAll('.page').forEach(p => {
      p.classList.toggle('active', p.id === name + '-page');
    });

    // Portrait mini-player visibility
    UI.onPageSwitch(name);

    // Lazy-render page content
    switch (name) {
      case 'log':
        UI.renderLogOverview();
        break;
      case 'edit':
        UI.renderEditGrid();
        break;
    }
  }

  function switchBotNav(btn) {
    document.querySelectorAll('.bottom-nav-item').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  }

  /* ─────────────────────────────────────────
     FILE UPLOAD
  ───────────────────────────────────────── */
  async function uploadFiles() {
    const queue = UI.getUploadQueue();
    if (!queue.length) return;

    UI.closeModal('upload-modal');
    UI.toast(`${queue.length}曲を追加中...`);

    const addedTracks = [];

    for (const item of queue) {
      try {
        // Read file as ArrayBuffer
        const buf = await _readFileAsBuffer(item.file);

        // Save blob
        const blobKey = await Storage.saveBlob(buf);

        // Add track record
        const track = await Storage.addTrack({
          title:       item.title,
          artist:      item.artist || '',
          duration:    item.duration || 0,
          blobKey,
        });

        addedTracks.push(track);
      } catch (err) {
        console.error('Upload error for', item.file.name, err);
        UI.toast(`追加失敗: ${item.title}`, 'error');
      }
    }

    // Refresh UI
    await UI.refreshAll();
    UI.toast(`${addedTracks.length}曲を追加しました`, 'success');

    // Push to Drive asynchronously
    for (const track of addedTracks) {
      Drive.onTrackAdded(track).catch(() => {});
    }
  }

  function _readFileAsBuffer(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload  = e => resolve(e.target.result);
      reader.onerror = e => reject(e.target.error);
      reader.readAsArrayBuffer(file);
    });
  }

  /* ─────────────────────────────────────────
     TRACK CRUD
  ───────────────────────────────────────── */
  async function deleteTrack(id) {
    try {
      await Storage.deleteTrack(id);
      await Drive.onTrackDeleted(id);
      await UI.refreshAll();
      UI.toast('曲を削除しました');
    } catch (err) {
      console.error('Delete track error:', err);
      UI.toast('削除に失敗しました', 'error');
    }
  }

  async function saveTrackEdit() {
    const data = await UI.getEditFormData();
    if (!data.id) return;

    try {
      const changes = {
        title:       data.title,
        artist:      data.artist,
        releaseDate: data.releaseDate,
        tags:        data.tags,
      };

      // Handle new thumbnail
      if (data.thumbData) {
        const track = await Storage.getTrack(data.id);
        // Remove old thumb blob
        if (track.thumbKey) await Storage.deleteBlob(track.thumbKey);
        const thumbKey = await Storage.saveBlob(data.thumbData);
        changes.thumbKey      = thumbKey;
        changes.driveThumbId  = null; // reset so it re-uploads
      }

      await Storage.updateTrack(data.id, changes);
      await UI.refreshAll();
      UI.closeModal('edit-track-modal');
      UI.toast('情報を保存しました', 'success');
      Drive.triggerAutoSync();
    } catch (err) {
      console.error('Save track edit error:', err);
      UI.toast('保存に失敗しました', 'error');
    }
  }

  /* ─────────────────────────────────────────
     PLAYLIST CRUD
  ───────────────────────────────────────── */
  async function createPlaylist() {
    const data = UI.getNewPlaylistData();
    if (!data.name) {
      UI.toast('プレイリスト名を入力してください', 'error');
      return;
    }
    try {
      await Storage.createPlaylist(data.name, data.desc);
      await UI.refreshPlaylists();
      UI.closeModal('new-playlist-modal');
      UI.toast(`「${data.name}」を作成しました`, 'success');
      Drive.triggerAutoSync();
    } catch (err) {
      console.error('Create playlist error:', err);
      UI.toast('作成に失敗しました', 'error');
    }
  }

  async function deletePlaylist(id) {
    try {
      await Storage.deletePlaylist(id);
      await UI.refreshPlaylists();
      UI.switchPlaylist('__all__');
      UI.toast('プレイリストを削除しました');
      Drive.triggerAutoSync();
    } catch (err) {
      console.error('Delete playlist error:', err);
    }
  }

  /* ─────────────────────────────────────────
     TAG CRUD
  ───────────────────────────────────────── */
  async function saveTag() {
    const data = UI.getTagFormData();
    if (!data.name) {
      UI.toast('タグ名を入力してください', 'error');
      return;
    }
    try {
      if (data.id) {
        await Storage.updateTag(data.id, {
          name:      data.name,
          color:     data.color,
          textColor: data.textColor,
        });
        UI.toast('タグを更新しました', 'success');
      } else {
        await Storage.createTag(data.name, data.color, data.textColor);
        UI.toast(`タグ「${data.name}」を作成しました`, 'success');
      }
      await UI.refreshTags();
      await UI.renderTagManager();
      UI.closeModal('tag-modal');
      Drive.triggerAutoSync();
    } catch (err) {
      console.error('Save tag error:', err);
      UI.toast('タグの保存に失敗しました', 'error');
    }
  }

  async function deleteTag(id) {
    try {
      await Storage.deleteTag(id);
      await UI.refreshAll();
      UI.renderTagManager();
      UI.toast('タグを削除しました');
      Drive.triggerAutoSync();
    } catch (err) {
      console.error('Delete tag error:', err);
      UI.toast('タグの削除に失敗しました', 'error');
    }
  }

  /* ─────────────────────────────────────────
     RESET
  ───────────────────────────────────────── */
  function confirmReset(type) {
    const messages = {
      cache: 'ページのキャッシュ（音声ファイル含む）を全て削除します。\nDrive上のデータは残ります。この操作は取り消せません。',
      all:   'キャッシュとGoogle Drive上の全データを削除します。\nこの操作は完全に取り消せません。',
    };
    // Directly open the confirm modal via UI internals
    const titleEl  = document.getElementById('confirm-title');
    const msgEl    = document.getElementById('confirm-msg');
    const okBtn    = document.getElementById('confirm-ok-btn');
    if (titleEl) titleEl.textContent = type === 'all' ? '全データリセット' : 'キャッシュリセット';
    if (msgEl)   msgEl.textContent   = messages[type] || '';
    if (okBtn)   okBtn.onclick = async () => {
      UI.closeModal('confirm-modal');
      await _doReset(type);
    };
    UI.openModal('confirm-modal');
  }

  async function _doReset(type) {
    try {
      UI.toast('リセット中...', '');
      if (type === 'all') {
        await Drive.resetDriveData();
      }
      await Storage.resetAll();
      // Clear in-memory state
      await UI.refreshAll();
      Player.setQueue([], -1);
      UI.toast('リセットが完了しました', 'success');
      // Reload page for clean state
      setTimeout(() => location.reload(), 1200);
    } catch (err) {
      console.error('Reset error:', err);
      UI.toast('リセットに失敗しました', 'error');
    }
  }

  /* ─────────────────────────────────────────
     REFRESH ALL (called by Drive after sync)
  ───────────────────────────────────────── */
  async function refreshAll() {
    await UI.refreshAll();
    // Re-render current page's content
    if (_currentPage === 'log')  UI.renderLogOverview();
    if (_currentPage === 'edit') UI.renderEditGrid();
  }

  /* ─────────────────────────────────────────
     GLOBAL KEYBOARD SHORTCUTS
  ───────────────────────────────────────── */
  function _initKeyboard() {
    document.addEventListener('keydown', e => {
      // Don't trigger when typing in inputs
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      switch (e.code) {
        case 'Space':
          e.preventDefault();
          Player.togglePlay();
          break;
        case 'ArrowRight':
          if (e.altKey) Player.next();
          break;
        case 'ArrowLeft':
          if (e.altKey) Player.prev();
          break;
        case 'KeyM':
          Player.toggleMute();
          break;
        case 'Escape':
          // Close topmost open modal or full player
          const fp = document.getElementById('full-player-overlay');
          if (fp && fp.classList.contains('open')) { UI.closeFullPlayer(); return; }
          document.querySelectorAll('.overlay.open').forEach(o => o.classList.remove('open'));
          break;
      }
    });
  }

  /* ─────────────────────────────────────────
     MEDIA SESSION API (lock screen controls)
  ───────────────────────────────────────── */
  function _initMediaSession() {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.setActionHandler('play',         () => Player.play());
    navigator.mediaSession.setActionHandler('pause',        () => Player.pause());
    navigator.mediaSession.setActionHandler('nexttrack',    () => Player.next());
    navigator.mediaSession.setActionHandler('previoustrack',() => Player.prev());

    // Update metadata when track changes
    const audio = document.getElementById('audio-el');
    audio.addEventListener('play', async () => {
      const id    = Player.getCurrentTrackId();
      const track = id ? await Storage.getTrack(id) : null;
      if (!track) return;
      const artwork = [];
      if (track.thumbKey) {
        const url = await Storage.getBlobUrl(track.thumbKey);
        if (url) artwork.push({ src: url, sizes: '512x512' });
      }
      navigator.mediaSession.metadata = new MediaMetadata({
        title:  track.title  || '',
        artist: track.artist || '',
        artwork,
      });
    });
  }

  /* ─────────────────────────────────────────
     PREVENT ACCIDENTAL PAGE UNLOAD
  ───────────────────────────────────────── */
  function _initUnloadGuard() {
    window.addEventListener('beforeunload', e => {
      if (Player.isPlaying()) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
  }

  /* ─────────────────────────────────────────
     ENTRY POINT
  ───────────────────────────────────────── */
  document.addEventListener('DOMContentLoaded', async () => {
    _initKeyboard();
    _initMediaSession();
    _initUnloadGuard();
    await boot();
  });

  /* ─────────────────────────────────────────
     PUBLIC API
  ───────────────────────────────────────── */
  return {
    // Navigation
    switchPage,
    switchBotNav,

    // Upload
    uploadFiles,

    // Track
    deleteTrack,
    saveTrackEdit,

    // Playlist
    createPlaylist,
    deletePlaylist,

    // Tag
    saveTag,
    deleteTag,

    // Reset
    confirmReset,

    // Refresh
    refreshAll,
  };

})();


