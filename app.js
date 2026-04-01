/**
 * app.js - Harmonia Music Player (v6)
 * Changes from v5:
 * - fileBlob/thumbnailDataUrl を別 IndexedDB ストア (blobs/thumbs) に分離 → Safari メモリ圧迫解消
 * - Drive 同期を分割: tracks_meta.json / playlists.json / logs_YYYYMM.json / thumbnails/ (個別ファイル)
 * - タグ表示：プレイヤー一覧は色の丸ドットのみ / グローバルタグ優先順位管理
 * - 遅延サムネイル読み込み（仮想スクロール連動）
 * - 自動同期トグル + 操作蓄積カウンター
 * - ログ画面：カレンダービュー + 周年バナー
 * - 編集画面：タグ管理タブ（作成・削除・優先順位並べ替え）
 */

const GOOGLE_CLIENT_ID   = '966636096862-8hrrm5heb4g5r469veoels7u6ifjguuk.apps.googleusercontent.com';
const SYNC_FOLDER_NAME   = 'WebMusicPlayer_Sync';
const DB_NAME            = 'MusicPlayerDB';
const DB_VERSION         = 5;  // v4→v5: blobs/thumbs ストア追加
let db = null;

const audioPlayer = new Audio();
let currentObjectUrl  = null;
let tokenClient       = null;
let gapiAccessToken   = null;
let playbackStartTime = 0;
let logChartInstance     = null;
let logPieChartInstance  = null;
let isHandlingTrackEnd   = false;
let bgEndChecker         = null;

// 再生速度
const SPEED_OPTIONS   = [0.5, 0.75, 1, 1.25, 1.5, 2];
let currentSpeedIndex = 2;

// 仮想スクロール定数
const TRACK_ITEM_H    = 62;
const VSCROLL_BUFFER  = 5;
const EDIT_GRID_GAP   = 12;
const EDIT_ROW_GAP    = 12;
const EDIT_SCROLL_TOP_PAD = 16;

// サムネイルインメモリキャッシュ（trackId → dataUrl）
const thumbCache = new Map();

// localStorage キー
const SYNC_STATE_KEY    = 'harmonia_sync_state';
const HARMONIA_USER_KEY = 'harmonia_user_id';
const LAST_SYNC_KEY     = 'harmonia_last_sync';
const TAG_ORDER_KEY     = 'harmonia_tag_order';
const PENDING_OPS_KEY   = 'harmonia_pending_ops';
const AUTO_SYNC_KEY     = 'harmonia_auto_sync';
const AUTH_PROFILE_KEY  = 'harmonia_auth_profile';

const appState = {
    tracks:             [],
    playlists:          [],
    currentQueue:       [],
    currentTrackIndex:  -1,
    isPlaying:          false,
    allKnownTags:       new Map(),  // text → { text, color }
    tagOrder:           [],         // 優先順位順のタグtext配列
    currentPlaylistId:  null,
    searchQueryMain:    '',
    sortModeMain:       'manual',
    selectedMainTracks: new Set(),
    isSelectMode:       false,
    editSelectedTracks: new Set(),
    editIsSelectMode:   false,
    editSortMode:       'manual',
    searchQueryEdit:    '',
    isLoggedIn:         false,
    user:               null,
    isSyncing:          false,
    isStreaming:        false,
    isAutoSync:         true,
    pendingOpsCount:    0,
    loopMode:           'none',
    isShuffled:         false,
    shuffleOrder:       [],
    shufflePos:         -1,
    isQueueOpen:        false,
    currentLogCategory: 'total',
    currentLogPeriod:   'all',
    currentLogUnit:     'auto',
    currentLogView:     'chart',    // 'chart' | 'calendar'
    calendarYear:       new Date().getFullYear(),
    calendarMonth:      new Date().getMonth(),
    currentEditTab:     'tracks',   // 'tracks' | 'tags'
};

// ─────────────────────────────────────────────
// DOMContentLoaded
// ─────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    loadTagOrderFromStorage();
    loadAutoSyncSetting();
    loadPendingOpsCount();

    initNavigation();
    initAuthUI();
    initDragAndDrop();
    initPlayerControls();
    initPlaylists();
    initSearchAndSort();
    initBulkActions();
    initSelectMode();
    initEditPage();
    initEditSelectMode();
    initEditSubTabs();
    initTagManagement();
    initPlaylistPlaybackControls();
    initSettings();
    initLogControls();
    initLogViewTabs();
    initCalendar();
    initKeyboardShortcuts();
    initQueuePanel();
    initFullscreenPlayer();
    initMiniPlayer();
    initMobileExpandBtn();
    initVirtualScrollListeners();

    try {
        await initDB();
        await migrateV4ToV5IfNeeded();
        await loadLibrary();
        await loadPlaylists();
        renderAnniversaryBanner();
    } catch (error) {
        console.error('DB初期化エラー:', error);
    }

    window.addEventListener('beforeunload', stopPlaybackTracking);

    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && appState.isPlaying) {
            if (audioPlayer.paused && audioPlayer.duration > 0 &&
                audioPlayer.currentTime >= audioPlayer.duration - 0.5) {
                handleTrackEnd();
            }
        }
    });
});

// ─────────────────────────────────────────────
// トースト通知
// ─────────────────────────────────────────────
function showToast(message, type = '', duration = 2800) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = 'toast' + (type ? ' ' + type : '');
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.animation = 'toastOut 0.25s forwards';
        setTimeout(() => toast.remove(), 260);
    }, duration);
}

// ─────────────────────────────────────────────
// タグ順序（優先順位）管理
// ─────────────────────────────────────────────
function loadTagOrderFromStorage() {
    try {
        const saved = localStorage.getItem(TAG_ORDER_KEY);
        if (saved) appState.tagOrder = JSON.parse(saved);
    } catch(e) { appState.tagOrder = []; }
}

function saveTagOrderToStorage() {
    localStorage.setItem(TAG_ORDER_KEY, JSON.stringify(appState.tagOrder));
}

/** タグ配列を優先順位順にソートして返す */
function sortTagsByOrder(tags) {
    if (!tags || tags.length === 0) return [];
    return [...tags].sort((a, b) => {
        const textA = typeof a === 'string' ? a : a.text;
        const textB = typeof b === 'string' ? b : b.text;
        const ia = appState.tagOrder.indexOf(textA);
        const ib = appState.tagOrder.indexOf(textB);
        if (ia === -1 && ib === -1) return 0;
        if (ia === -1) return 1;
        if (ib === -1) return -1;
        return ia - ib;
    });
}

/** allKnownTags を新たなタグで更新し、tagOrder に存在しなければ末尾に追加 */
function syncTagOrder() {
    appState.allKnownTags.forEach((tagObj, text) => {
        if (!appState.tagOrder.includes(text)) {
            appState.tagOrder.push(text);
        }
    });
    // tagOrder に残っているが allKnownTags にないタグは除去
    appState.tagOrder = appState.tagOrder.filter(t => appState.allKnownTags.has(t));
    saveTagOrderToStorage();
}

// ─────────────────────────────────────────────
// 自動同期 / 未同期カウンター
// ─────────────────────────────────────────────
function loadAutoSyncSetting() {
    const saved = localStorage.getItem(AUTO_SYNC_KEY);
    appState.isAutoSync = (saved === null) ? false : saved === 'true';
}

function loadPendingOpsCount() {
    const saved = localStorage.getItem(PENDING_OPS_KEY);
    appState.pendingOpsCount = saved ? parseInt(saved) || 0 : 0;
}

function incrementPendingOps() {
    appState.pendingOpsCount++;
    localStorage.setItem(PENDING_OPS_KEY, appState.pendingOpsCount.toString());
    updatePendingBadge();
}

function resetPendingOps() {
    appState.pendingOpsCount = 0;
    localStorage.removeItem(PENDING_OPS_KEY);
    updatePendingBadge();
}

function updatePendingBadge() {
    const badge = document.getElementById('pending-sync-badge');
    if (!badge) return;
    if (appState.pendingOpsCount > 0 && !appState.isAutoSync) {
        badge.textContent = appState.pendingOpsCount > 99 ? '99+' : appState.pendingOpsCount;
        badge.style.display = 'inline-flex';
    } else {
        badge.style.display = 'none';
    }
}

// ─────────────────────────────────────────────
// 同期進捗（設定ページ）
// ─────────────────────────────────────────────
function updateSyncProgress(pct, detail, label = '同期中') {
    const syncStatus = document.getElementById('sync-status');
    if (syncStatus) {
        syncStatus.textContent = (pct >= 0 && pct < 100) ? `${label} ${pct}%` : '';
    }
    const progressItem   = document.getElementById('sync-progress-item');
    const progressLabel  = document.getElementById('sync-progress-label');
    const progressDetail = document.getElementById('sync-progress-detail');
    const progressPct    = document.getElementById('sync-progress-pct');
    const barFill        = document.getElementById('sync-bar-fill');
    const retryItem      = document.getElementById('sync-retry-item');
    const manualItem     = document.getElementById('sync-manual-item');

    if (pct >= 0 && pct < 100) {
        if (progressItem)  progressItem.style.display  = '';
        if (retryItem)     retryItem.style.display     = 'none';
        if (manualItem)    manualItem.style.display    = 'none';
        if (progressLabel) progressLabel.textContent   = label;
        if (progressDetail) progressDetail.textContent = detail;
        if (progressPct)   progressPct.textContent     = `${pct}%`;
        if (barFill)       barFill.style.width         = `${pct}%`;
    } else if (pct === 100) {
        if (progressItem)  progressItem.style.display  = 'none';
        if (retryItem)     retryItem.style.display     = 'none';
        if (manualItem && appState.isLoggedIn) manualItem.style.display = '';
        const lastSyncText = document.getElementById('last-sync-text');
        if (lastSyncText) {
            lastSyncText.textContent = `最終同期: ${new Date().toLocaleString('ja-JP')}`;
        }
        localStorage.setItem(LAST_SYNC_KEY, Date.now().toString());
    }
}

function updateSyncError(errorMsg) {
    const progressItem = document.getElementById('sync-progress-item');
    const retryItem    = document.getElementById('sync-retry-item');
    const manualItem   = document.getElementById('sync-manual-item');
    const errorDetail  = document.getElementById('sync-error-detail');
    const syncStatus   = document.getElementById('sync-status');

    if (progressItem) progressItem.style.display = 'none';
    if (retryItem)    retryItem.style.display    = '';
    if (manualItem)   manualItem.style.display   = 'none';
    if (errorDetail)  errorDetail.textContent    = errorMsg || 'エラーが発生しました';
    if (syncStatus)   syncStatus.textContent     = '同期失敗';
}

// ─────────────────────────────────────────────
// 設定
// ─────────────────────────────────────────────
function initSettings() {
    // ストリーミング
    const isStreamingSaved = localStorage.getItem('isStreaming');
    if (isStreamingSaved !== null) appState.isStreaming = isStreamingSaved === 'true';
    const checkboxStreaming = document.getElementById('setting-streaming');
    if (checkboxStreaming) {
        checkboxStreaming.checked = appState.isStreaming;
        checkboxStreaming.addEventListener('change', (e) => {
            appState.isStreaming = e.target.checked;
            localStorage.setItem('isStreaming', appState.isStreaming);
            if (!appState.isStreaming && appState.isLoggedIn) autoSync();
        });
    }

    // 自動同期トグル
    const checkboxAutoSync = document.getElementById('setting-auto-sync');
    if (checkboxAutoSync) {
        checkboxAutoSync.checked = appState.isAutoSync;
        checkboxAutoSync.addEventListener('change', (e) => {
            appState.isAutoSync = e.target.checked;
            localStorage.setItem(AUTO_SYNC_KEY, appState.isAutoSync);
            updatePendingBadge();
            // ONに切り替えた場合、蓄積された操作を即時同期
            if (appState.isAutoSync && appState.isLoggedIn && !appState.isSyncing && appState.pendingOpsCount > 0) {
                performDriveSync();
            }
        });
    }

    // ログリセット
    const clearLogsBtn = document.getElementById('clear-logs-btn');
    if (clearLogsBtn) {
        clearLogsBtn.addEventListener('click', async () => {
            if (!confirm('すべての再生ログをリセットしますか？この操作は元に戻せません。')) return;
            await clearAllLogs();
            showToast('再生ログをリセットしました');
        });
    }

    // 手動同期
    const syncNowBtn = document.getElementById('sync-now-btn');
    if (syncNowBtn) {
        syncNowBtn.addEventListener('click', () => {
            if (appState.isLoggedIn && !appState.isSyncing) performDriveSync();
        });
    }

    // 再試行
    const syncRetryBtn = document.getElementById('sync-retry-btn');
    if (syncRetryBtn) {
        syncRetryBtn.addEventListener('click', () => {
            const retryItem = document.getElementById('sync-retry-item');
            if (retryItem) retryItem.style.display = 'none';
            if (appState.isLoggedIn && !appState.isSyncing) performDriveSync();
        });
    }

    // 最終同期日時復元
    const lastSync = localStorage.getItem(LAST_SYNC_KEY);
    if (lastSync) {
        const lastSyncText = document.getElementById('last-sync-text');
        if (lastSyncText) {
            lastSyncText.textContent = `最終同期: ${new Date(parseInt(lastSync)).toLocaleString('ja-JP')}`;
        }
    }

    updatePendingBadge();
}

function clearAllLogs() {
    return new Promise((resolve, reject) => {
        const tx  = db.transaction(['logs'], 'readwrite');
        const req = tx.objectStore('logs').clear();
        req.onsuccess = () => resolve();
        req.onerror   = e => reject(e.target.error);
    });
}

// ─────────────────────────────────────────────
// キーボードショートカット
// ─────────────────────────────────────────────
function initKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
        const tag = e.target.tagName.toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
        switch (e.code) {
            case 'Space':       e.preventDefault(); togglePlay();     break;
            case 'ArrowRight':  e.preventDefault(); playNext();       break;
            case 'ArrowLeft':   e.preventDefault(); playPrev();       break;
            case 'ArrowUp':     e.preventDefault(); adjustVolume(5);  break;
            case 'ArrowDown':   e.preventDefault(); adjustVolume(-5); break;
            case 'KeyL': cycleLoopMode();  break;
            case 'KeyS': toggleShuffle(); break;
        }
    });
}

function adjustVolume(delta) {
    const bar = document.getElementById('volume-bar');
    if (!bar) return;
    const val = Math.min(100, Math.max(0, parseInt(bar.value) + delta));
    bar.value = val;
    const fpBar = document.getElementById('fp-volume-bar');
    if (fpBar) fpBar.value = val;
    audioPlayer.volume = val / 100;
    updateVolumeIcon(val);
}

function updateVolumeIcon(val) {
    const btn = document.getElementById('ctrl-mute');
    if (!btn) return;
    const icon = btn.querySelector('.material-symbols-rounded');
    if (!icon) return;
    if (val === 0)      icon.textContent = 'volume_off';
    else if (val < 50)  icon.textContent = 'volume_down';
    else                icon.textContent = 'volume_up';
}

// ─────────────────────────────────────────────
// スマホ縦：プレイヤー展開ボタン
// ─────────────────────────────────────────────
function initMobileExpandBtn() {
    const btn   = document.getElementById('mobile-expand-btn');
    const panel = document.getElementById('player-left-panel');
    if (!btn || !panel) return;
    const icon = btn.querySelector('.material-symbols-rounded');
    if (icon) icon.textContent = 'expand_more';
    btn.addEventListener('click', () => {
        const isExpanded = panel.classList.contains('mobile-expanded');
        panel.classList.toggle('mobile-expanded', !isExpanded);
        if (icon) icon.textContent = isExpanded ? 'expand_more' : 'expand_less';
    });
}

// ─────────────────────────────────────────────
// ナビゲーション
// ─────────────────────────────────────────────
function initNavigation() {
    function switchPage(targetId) {
        document.querySelectorAll('.sidenav-btn').forEach(b =>
            b.classList.toggle('active', b.getAttribute('data-target') === targetId));
        document.querySelectorAll('.page-section').forEach(p =>
            p.classList.toggle('active', p.id === targetId));
        document.querySelectorAll('.bottom-nav-btn').forEach(b =>
            b.classList.toggle('active', b.getAttribute('data-target') === targetId));

        exitSelectMode();
        exitEditSelectMode();

        if (targetId === 'edit')  renderVirtualEditGrid();
        if (targetId === 'log')  {
            updateLogPage();
            renderAnniversaryBanner();
        }
    }

    document.querySelectorAll('.sidenav-btn, .bottom-nav-btn').forEach(btn => {
        btn.addEventListener('click', () => switchPage(btn.getAttribute('data-target')));
    });

    const libraryAllBtn = document.getElementById('library-all-btn');
    if (libraryAllBtn) {
        libraryAllBtn.addEventListener('click', () => {
            appState.currentPlaylistId = null;
            document.getElementById('current-playlist-name').textContent = 'すべての曲';
            appState.selectedMainTracks.clear();
            updateMainQueue();
            document.querySelectorAll('.playlist-tab').forEach(el => el.classList.remove('active'));
            libraryAllBtn.classList.add('active');
        });
    }
}

// ─────────────────────────────────────────────
// 再生キューパネル
// ─────────────────────────────────────────────
function initQueuePanel() {
    const closeBtn = document.getElementById('close-queue-btn');
    const overlay  = document.getElementById('queue-overlay');
    if (closeBtn) closeBtn.addEventListener('click', closeQueuePanel);
    if (overlay)  overlay.addEventListener('click', closeQueuePanel);
}

function toggleQueuePanel() {
    appState.isQueueOpen = !appState.isQueueOpen;
    const panel   = document.getElementById('queue-panel');
    const overlay = document.getElementById('queue-overlay');
    if (panel)   panel.classList.toggle('open', appState.isQueueOpen);
    if (overlay) overlay.classList.toggle('show', appState.isQueueOpen);
    if (appState.isQueueOpen) renderQueuePanel();
}

function closeQueuePanel() {
    appState.isQueueOpen = false;
    const panel   = document.getElementById('queue-panel');
    const overlay = document.getElementById('queue-overlay');
    if (panel)   panel.classList.remove('open');
    if (overlay) overlay.classList.remove('show');
}

function renderQueuePanel() {
    const list = document.getElementById('queue-list');
    if (!list) return;
    list.innerHTML = '';
    appState.currentQueue.forEach((track, index) => {
        const li   = document.createElement('li');
        li.className = 'queue-item' + (index === appState.currentTrackIndex ? ' current' : '');
        const thumb = document.createElement('div');
        thumb.className = 'queue-thumb';
        const cachedThumb = thumbCache.get(track.id);
        if (cachedThumb) {
            thumb.style.backgroundImage = `url(${cachedThumb})`;
            thumb.style.backgroundSize  = 'cover';
        } else {
            thumb.innerHTML = '<span class="material-symbols-rounded">music_note</span>';
            loadThumbForElement(track.id, thumb);
        }
        const info = document.createElement('div');
        info.className = 'queue-item-info';
        info.innerHTML = `<div class="queue-item-title">${track.title}</div><div class="queue-item-artist">${track.artist || '-'}</div>`;
        li.innerHTML = `<span class="queue-item-num">${index + 1}</span>`;
        li.appendChild(thumb);
        li.appendChild(info);
        li.addEventListener('click', () => playTrack(index));
        list.appendChild(li);
    });
    const currentEl = list.querySelector('.current');
    if (currentEl) currentEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// ─────────────────────────────────────────────
// フルスクリーンプレイヤー（スマホ）
// ─────────────────────────────────────────────
function initFullscreenPlayer() {
    const closeBtn  = document.getElementById('fp-close-btn');
    if (closeBtn) closeBtn.addEventListener('click', closeFullscreenPlayer);

    const fpPlay    = document.getElementById('fp-play');
    const fpPrev    = document.getElementById('fp-prev');
    const fpNext    = document.getElementById('fp-next');
    const fpSeek    = document.getElementById('fp-seek-bar');
    const fpVolume  = document.getElementById('fp-volume-bar');
    const fpLoop    = document.getElementById('fp-loop');
    const fpShuffle = document.getElementById('fp-shuffle');
    const fpSpeed   = document.getElementById('fp-speed');

    if (fpPlay)    fpPlay.addEventListener('click', togglePlay);
    if (fpPrev)    fpPrev.addEventListener('click', playPrev);
    if (fpNext)    fpNext.addEventListener('click', playNext);
    if (fpLoop)    fpLoop.addEventListener('click', cycleLoopMode);
    if (fpShuffle) fpShuffle.addEventListener('click', toggleShuffle);
    if (fpSpeed)   fpSpeed.addEventListener('click', cycleSpeed);

    if (fpSeek) fpSeek.addEventListener('input', (e) => {
        if (audioPlayer.duration) audioPlayer.currentTime = (e.target.value / 100) * audioPlayer.duration;
    });
    if (fpVolume) fpVolume.addEventListener('input', (e) => {
        audioPlayer.volume = e.target.value / 100;
        const mainVol = document.getElementById('volume-bar');
        if (mainVol) mainVol.value = e.target.value;
        updateVolumeIcon(e.target.value);
    });
}

function openFullscreenPlayer() {
    const player = document.getElementById('fullscreen-player');
    if (player) player.classList.add('open');
}
function closeFullscreenPlayer() {
    const player = document.getElementById('fullscreen-player');
    if (player) player.classList.remove('open');
}

function updateFullscreenPlayer(track) {
    const artwork = document.getElementById('fp-artwork');
    const fpBg    = document.getElementById('fp-bg');
    const title   = document.getElementById('fp-title');
    const artist  = document.getElementById('fp-artist');
    if (title)  title.textContent  = track ? track.title : '未選択';
    if (artist) artist.textContent = track ? (track.artist || '-') : '-';
    if (artwork) {
        if (track) {
            const cached = thumbCache.get(track.id);
            if (cached) {
                artwork.style.backgroundImage = `url(${cached})`;
                artwork.innerHTML = '';
                if (fpBg) fpBg.style.background = `linear-gradient(180deg, var(--bg-sub) 0%, var(--bg) 100%)`;
            } else {
                artwork.style.backgroundImage = 'none';
                artwork.innerHTML = '<span class="material-symbols-rounded">music_note</span>';
                if (fpBg) fpBg.style.background = '';
                // 非同期ロード
                loadThumbFromDB(track.id).then(dataUrl => {
                    if (dataUrl && artwork) {
                        artwork.style.backgroundImage = `url(${dataUrl})`;
                        artwork.innerHTML = '';
                        if (fpBg) fpBg.style.background = `linear-gradient(180deg, var(--bg-sub) 0%, var(--bg) 100%)`;
                    }
                });
            }
        } else {
            artwork.style.backgroundImage = 'none';
            artwork.innerHTML = '<span class="material-symbols-rounded">music_note</span>';
            if (fpBg) fpBg.style.background = '';
        }
    }
}

// ─────────────────────────────────────────────
// ミニプレイヤー（スマホ）
// ─────────────────────────────────────────────
function initMiniPlayer() {
    const miniPlayer  = document.getElementById('mini-player');
    const miniPlayBtn = document.getElementById('mini-play');
    const miniPrevBtn = document.getElementById('mini-prev');
    const miniNextBtn = document.getElementById('mini-next');

    if (miniPlayBtn) miniPlayBtn.addEventListener('click', (e) => { e.stopPropagation(); togglePlay(); });
    if (miniPrevBtn) miniPrevBtn.addEventListener('click', (e) => { e.stopPropagation(); playPrev(); });
    if (miniNextBtn) miniNextBtn.addEventListener('click', (e) => { e.stopPropagation(); playNext(); });

    if (miniPlayer) {
        miniPlayer.addEventListener('click', (e) => {
            if (e.target.closest('button')) return;
            openFullscreenPlayer();
        });
    }
}

function updateMiniPlayer(track) {
    const miniThumb  = document.getElementById('mini-thumb');
    const miniTitle  = document.getElementById('mini-title');
    const miniArtist = document.getElementById('mini-artist');
    if (miniTitle)  miniTitle.textContent  = track ? track.title : '未選択';
    if (miniArtist) miniArtist.textContent = track ? (track.artist || '-') : '-';
    if (miniThumb) {
        if (track) {
            const cached = thumbCache.get(track.id);
            if (cached) {
                miniThumb.style.backgroundImage = `url(${cached})`;
                miniThumb.innerHTML = '';
            } else {
                miniThumb.style.backgroundImage = 'none';
                miniThumb.innerHTML = '<span class="material-symbols-rounded">music_note</span>';
                loadThumbForElement(track.id, miniThumb);
            }
        } else {
            miniThumb.style.backgroundImage = 'none';
            miniThumb.innerHTML = '<span class="material-symbols-rounded">music_note</span>';
        }
    }
}

function updateMiniPlayButton() {
    const btn = document.getElementById('mini-play');
    if (btn) {
        const icon = btn.querySelector('.material-symbols-rounded');
        if (icon) icon.textContent = appState.isPlaying ? 'pause' : 'play_arrow';
    }
}

// ─────────────────────────────────────────────
// ループ / シャッフル / 速度
// ─────────────────────────────────────────────
function cycleLoopMode() {
    const modes = ['none', 'all', 'one'];
    const idx = modes.indexOf(appState.loopMode);
    appState.loopMode = modes[(idx + 1) % modes.length];
    updateLoopUI();
    const labels = { none: 'ループなし', all: '全曲ループ', one: '1曲リピート' };
    showToast(labels[appState.loopMode]);
}

function updateLoopUI() {
    [document.getElementById('ctrl-loop'), document.getElementById('fp-loop')].forEach(btn => {
        if (!btn) return;
        btn.classList.toggle('active', appState.loopMode !== 'none');
        const icon = btn.querySelector('.material-symbols-rounded');
        if (icon) icon.textContent = appState.loopMode === 'one' ? 'repeat_one' : 'repeat';
    });
}

function toggleShuffle() {
    appState.isShuffled = !appState.isShuffled;
    [document.getElementById('ctrl-shuffle'), document.getElementById('fp-shuffle')].forEach(btn => {
        if (btn) btn.classList.toggle('active', appState.isShuffled);
    });
    showToast(appState.isShuffled ? 'シャッフルON' : 'シャッフルOFF');
    if (appState.isShuffled) buildShuffleOrder();
    else { appState.shuffleOrder = []; appState.shufflePos = -1; }
}

function buildShuffleOrder() {
    const len = appState.currentQueue.length;
    if (len === 0) { appState.shuffleOrder = []; appState.shufflePos = -1; return; }
    const indices = Array.from({ length: len }, (_, i) => i);
    for (let i = len - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [indices[i], indices[j]] = [indices[j], indices[i]];
    }
    const cur = appState.currentTrackIndex;
    if (cur >= 0) {
        const pos = indices.indexOf(cur);
        if (pos > 0) [indices[0], indices[pos]] = [indices[pos], indices[0]];
        appState.shufflePos = 0;
    } else {
        appState.shufflePos = -1;
    }
    appState.shuffleOrder = indices;
}

function cycleSpeed() {
    currentSpeedIndex = (currentSpeedIndex + 1) % SPEED_OPTIONS.length;
    const speed = SPEED_OPTIONS[currentSpeedIndex];
    audioPlayer.playbackRate = speed;
    const label = speed === 1 ? '1x' : speed + 'x';
    [document.getElementById('ctrl-speed'), document.getElementById('fp-speed')].forEach(btn => {
        if (btn) { btn.textContent = label; btn.classList.toggle('active', speed !== 1); }
    });
    showToast(`再生速度: ${label}`);
}

// ─────────────────────────────────────────────
// 再生ログ
// ─────────────────────────────────────────────
function startPlaybackTracking() {
    if (appState.currentTrackIndex >= 0 && appState.isPlaying) {
        playbackStartTime = Date.now();
    }
}

function stopPlaybackTracking() {
    if (playbackStartTime > 0 && appState.currentTrackIndex >= 0) {
        const elapsedSeconds = (Date.now() - playbackStartTime) / 1000;
        if (elapsedSeconds > 2) {
            const track = appState.currentQueue[appState.currentTrackIndex];
            if (track) {
                saveLogToDB({
                    trackId:   track.id,
                    title:     track.title,
                    artist:    track.artist || '不明',
                    tags:      track.tags || [],
                    date:      track.date || '',
                    duration:  elapsedSeconds,
                    timestamp: Date.now()
                });
            }
        }
        playbackStartTime = 0;
    }
}

function saveLogToDB(logEntry) {
    if (!logEntry.id) {
        logEntry.id = 'log_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    }
    return new Promise((resolve, reject) => {
        const tx  = db.transaction(['logs'], 'readwrite');
        const req = tx.objectStore('logs').put(logEntry);
        req.onsuccess = () => resolve();
        req.onerror   = e => reject(e.target.error);
    });
}

function getAllLogsFromDB() {
    return new Promise((resolve, reject) => {
        const tx  = db.transaction(['logs'], 'readonly');
        const req = tx.objectStore('logs').getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror   = e => reject(e.target.error);
    });
}

// ─────────────────────────────────────────────
// ログ画面：ビュー切り替え
// ─────────────────────────────────────────────
function initLogViewTabs() {
    document.querySelectorAll('.log-view-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            const view = tab.getAttribute('data-view');
            appState.currentLogView = view;
            document.querySelectorAll('.log-view-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');

            const chartView    = document.getElementById('log-chart-view');
            const calendarView = document.getElementById('log-calendar-view');
            if (view === 'chart') {
                if (chartView)    chartView.style.display    = '';
                if (calendarView) calendarView.style.display = 'none';
                updateLogPage();
            } else {
                if (chartView)    chartView.style.display    = 'none';
                if (calendarView) calendarView.style.display = '';
                renderCalendar();
            }
        });
    });
}

function initLogControls() {
    document.querySelectorAll('#log-category .seg-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('#log-category .seg-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            appState.currentLogCategory = btn.getAttribute('data-value');
            updateLogPage();
        });
    });
    document.querySelectorAll('#log-period .seg-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('#log-period .seg-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            appState.currentLogPeriod = btn.getAttribute('data-value');
            updateLogPage();
        });
    });
    document.querySelectorAll('#log-unit .seg-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('#log-unit .seg-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            appState.currentLogUnit = btn.getAttribute('data-value');
            updateLogPage();
        });
    });
}

async function updateLogPage() {
    const logs     = await getAllLogsFromDB();
    const period   = appState.currentLogPeriod;
    const category = appState.currentLogCategory;

    const totalSeconds = logs.reduce((sum, l) => sum + l.duration, 0);
    const statTime   = document.getElementById('stat-total-time');
    const statTracks = document.getElementById('stat-total-tracks');
    const statTop    = document.getElementById('stat-top-track');
    const statArtist = document.getElementById('stat-top-artist');
    if (statTime)   statTime.textContent   = formatLogTime(totalSeconds);
    if (statTracks) statTracks.textContent = `${appState.tracks.length} 曲`;

    const trackTimes = {};
    logs.forEach(l => { trackTimes[l.title || l.trackId] = (trackTimes[l.title || l.trackId] || 0) + l.duration; });
    const topTrack = Object.entries(trackTimes).sort((a, b) => b[1] - a[1])[0];
    if (statTop) statTop.textContent = topTrack ? topTrack[0] : '-';

    const artistTimes = {};
    logs.forEach(l => { if (l.artist) artistTimes[l.artist] = (artistTimes[l.artist] || 0) + l.duration; });
    const topArtist = Object.entries(artistTimes).sort((a, b) => b[1] - a[1])[0];
    if (statArtist) statArtist.textContent = topArtist ? topArtist[0] : '-';

    const now = Date.now();
    let filteredLogs = [...logs];
    if (period === 'day')   filteredLogs = logs.filter(l => now - l.timestamp <= 86400000);
    else if (period === 'week')  filteredLogs = logs.filter(l => now - l.timestamp <= 7 * 86400000);
    else if (period === 'month') filteredLogs = logs.filter(l => now - l.timestamp <= 30 * 86400000);
    else if (period === 'year')  filteredLogs = logs.filter(l => now - l.timestamp <= 365 * 86400000);

    renderBarChart(filteredLogs, period, category, appState.currentLogUnit);
    renderPieChart(filteredLogs, category);
    renderRanking(filteredLogs, category);
}

function getLogUnit(period, unit) {
    if (unit !== 'auto') return unit;
    if (period === 'day')   return 'hour';
    if (period === 'week')  return 'day';
    if (period === 'month') return 'day';
    if (period === 'year')  return 'month';
    return 'month';
}

function filterPeriodKey(log, unit) {
    const d = new Date(log.timestamp);
    switch (unit) {
        case 'hour':  return `${d.getHours()}時`;
        case 'day':   return `${d.getFullYear()}/${d.getMonth()+1}/${d.getDate()}`;
        case 'week': {
            const start   = new Date(d.getFullYear(), 0, 1);
            const weekNum = Math.ceil(((d - start) / 86400000 + start.getDay() + 1) / 7);
            return `${d.getFullYear()}年第${weekNum}週`;
        }
        case 'month': return `${d.getFullYear()}年${d.getMonth()+1}月`;
        case 'year':  return `${d.getFullYear()}年`;
        default:      return `${d.getFullYear()}年${d.getMonth()+1}月`;
    }
}

function groupLogsByCategory(logs, category) {
    const grouped = {};
    logs.forEach(l => {
        let key;
        if (category === 'artist') key = l.artist || '不明';
        else if (category === 'tag') {
            if (l.tags && l.tags.length > 0) {
                l.tags.forEach(t => {
                    const text = typeof t === 'string' ? t : t.text;
                    grouped[text] = (grouped[text] || 0) + l.duration;
                });
                return;
            } else key = 'タグなし';
        } else if (category === 'decade') {
            const m = (l.date || '').match(/\d{4}/);
            key = m ? `${Math.floor(parseInt(m[0]) / 10) * 10}年代` : '不明';
        }
        if (key !== undefined) grouped[key] = (grouped[key] || 0) + l.duration;
    });
    return grouped;
}

function renderBarChart(filteredLogs, period, category, unit) {
    const ctx = document.getElementById('logChart');
    if (!ctx) return;
    if (logChartInstance) { logChartInstance.destroy(); logChartInstance = null; }

    let labels = [], data = [], chartType = 'bar';
    const titleMap = { total: '再生時間の推移', artist: 'アーティスト別再生時間', tag: 'タグ別再生時間', decade: '年代別再生時間' };
    const titleEl = document.getElementById('bar-chart-title');
    if (titleEl) titleEl.textContent = titleMap[category] || '';

    const resolvedUnit = getLogUnit(period, unit);

    if (category === 'total') {
        chartType = 'line';
        const grouped = {}, orderMap = {};
        filteredLogs.forEach(l => {
            const key = filterPeriodKey(l, resolvedUnit);
            grouped[key] = (grouped[key] || 0) + l.duration;
            if (!orderMap[key] || l.timestamp < orderMap[key]) orderMap[key] = l.timestamp;
        });
        const sortedKeys = Object.keys(grouped).sort((a, b) => orderMap[a] - orderMap[b]);
        labels = sortedKeys;
        data   = sortedKeys.map(k => +(grouped[k] / 60).toFixed(1));
    } else {
        const grouped = groupLogsByCategory(filteredLogs, category);
        const sorted  = Object.entries(grouped).sort((a, b) => b[1] - a[1]).slice(0, 15);
        labels = sorted.map(x => x[0]);
        data   = sorted.map(x => +(x[1] / 60).toFixed(1));
    }

    logChartInstance = new Chart(ctx.getContext('2d'), {
        type: chartType,
        data: {
            labels: labels.length > 0 ? labels : ['データなし'],
            datasets: [{
                label: '再生時間（分）',
                data:  data.length > 0 ? data : [0],
                backgroundColor: chartType === 'bar' ? 'rgba(26,110,245,0.15)' : 'rgba(26,110,245,0.08)',
                borderColor: 'rgba(26,110,245,0.85)',
                borderWidth: 2,
                borderRadius: chartType === 'bar' ? 6 : 0,
                fill: chartType === 'line',
                tension: 0.4,
                pointRadius: chartType === 'line' ? 3 : 0,
                pointBackgroundColor: 'rgba(26,110,245,1)',
            }]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            scales: {
                y: {
                    beginAtZero: true,
                    title: { display: true, text: '再生時間（分）', font: { size: 11, family: 'Noto Sans JP' } },
                    grid: { color: 'rgba(0,0,0,0.04)' },
                    ticks: { font: { size: 11, family: 'Noto Sans JP' } }
                },
                x: {
                    grid: { display: false },
                    ticks: { font: { size: 11, family: 'Noto Sans JP' }, maxRotation: 45 }
                }
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: 'rgba(17,17,21,0.9)',
                    titleFont: { size: 12, family: 'Noto Sans JP' },
                    bodyFont:  { size: 11, family: 'Noto Sans JP' },
                    padding: 10, cornerRadius: 8,
                    callbacks: { label: (ctx) => `${ctx.raw} 分` }
                }
            }
        }
    });
}

function renderPieChart(filteredLogs, category) {
    const ctx  = document.getElementById('logPieChart');
    const card = document.getElementById('pie-chart-card');
    if (!ctx) return;
    if (logPieChartInstance) { logPieChartInstance.destroy(); logPieChartInstance = null; }

    const titleEl   = document.getElementById('pie-chart-title');
    const catLabels = { total: '時間帯別', artist: 'アーティスト別', tag: 'タグ別', decade: '年代別' };
    if (titleEl) titleEl.textContent = catLabels[category] + '構成比';

    const grouped = category === 'total'
        ? (() => {
            const g = {};
            filteredLogs.forEach(l => {
                const h   = new Date(l.timestamp).getHours();
                const key = h < 6 ? '深夜 (0-6時)' : h < 12 ? '午前 (6-12時)' : h < 18 ? '午後 (12-18時)' : '夜 (18-24時)';
                g[key] = (g[key] || 0) + l.duration;
            });
            return g;
        })()
        : groupLogsByCategory(filteredLogs, category);

    const entries = Object.entries(grouped).sort((a, b) => b[1] - a[1]).slice(0, 8);
    const labels  = entries.map(x => x[0]);
    const data    = entries.map(x => +(x[1] / 60).toFixed(1));
    const COLORS  = [
        'rgba(26,110,245,0.8)','rgba(52,199,89,0.8)','rgba(255,149,0,0.8)',
        'rgba(229,57,53,0.8)','rgba(88,86,214,0.8)','rgba(90,200,250,0.8)',
        'rgba(255,204,0,0.8)','rgba(175,82,222,0.8)'
    ];

    if (data.length === 0) { if (card) card.style.display = 'none'; return; }
    if (card) card.style.display = '';

    logPieChartInstance = new Chart(ctx.getContext('2d'), {
        type: 'doughnut',
        data: {
            labels,
            datasets: [{ data, backgroundColor: COLORS.slice(0, data.length), borderWidth: 2, borderColor: '#ffffff', hoverOffset: 6 }]
        },
        options: {
            responsive: true, maintainAspectRatio: false, cutout: '58%',
            plugins: {
                legend: {
                    display: true, position: 'bottom',
                    labels: { font: { size: 11, family: 'Noto Sans JP' }, padding: 10, usePointStyle: true, pointStyleWidth: 8 }
                },
                tooltip: {
                    backgroundColor: 'rgba(17,17,21,0.9)',
                    titleFont: { size: 12, family: 'Noto Sans JP' },
                    bodyFont:  { size: 11, family: 'Noto Sans JP' },
                    padding: 10, cornerRadius: 8,
                    callbacks: { label: (ctx) => ` ${ctx.label}: ${ctx.raw} 分` }
                }
            }
        }
    });
}

function renderRanking(filteredLogs, category) {
    const firstCard = document.getElementById('ranking-first-card');
    const list      = document.getElementById('ranking-list');
    const title     = document.getElementById('ranking-title');
    if (!list || !firstCard) return;

    const catNames = { total: '曲', artist: 'アーティスト', tag: 'タグ', decade: '年代' };
    if (title) title.textContent = `${catNames[category] || ''} 再生時間ランキング`;

    let grouped = {};
    if (category === 'total') {
        filteredLogs.forEach(l => {
            const key = l.trackId || l.title;
            if (!grouped[key]) grouped[key] = { seconds: 0, title: l.title, trackId: l.trackId, artist: l.artist, tags: l.tags, date: l.date };
            grouped[key].seconds += l.duration;
        });
    } else {
        const raw = groupLogsByCategory(filteredLogs, category);
        Object.entries(raw).forEach(([k, v]) => { grouped[k] = { seconds: v, title: k }; });
    }

    const sorted = Object.entries(grouped).sort((a, b) => b[1].seconds - a[1].seconds).slice(0, 10);
    const maxVal = sorted[0] ? sorted[0][1].seconds : 1;

    if (sorted.length > 0) {
        const [firstKey, firstData] = sorted[0];
        firstCard.style.display = 'flex';
        if (category === 'total') {
            const track    = appState.tracks.find(t => t.id === firstData.trackId) || null;
            const thumbUrl = thumbCache.get(firstData.trackId) || null;
            const thumbStyle = thumbUrl ? `background-image:url(${thumbUrl});background-size:cover;background-position:center;` : '';
            const thumbCont  = thumbUrl ? '' : '<span class="material-symbols-rounded">music_note</span>';
            const tags     = sortTagsByOrder((track?.tags || firstData.tags || [])).slice(0, 3);
            const tagsHtml = tags.map(t => {
                const tObj = typeof t === 'string' ? { text: t } : t;
                return `<span class="ranking-first-tag">${tObj.text}</span>`;
            }).join('');
            const artist = track?.artist || firstData.artist || '-';
            const date   = track?.date   || firstData.date   || '';
            firstCard.innerHTML = `
                <div class="ranking-first-thumb" style="${thumbStyle}">${thumbCont}</div>
                <div class="ranking-first-info">
                    <div class="ranking-first-rank-label">1位</div>
                    <div class="ranking-first-title">${firstData.title || firstKey}</div>
                    <div class="ranking-first-artist">${artist}</div>
                    <div class="ranking-first-meta">${tagsHtml}${date ? `<span class="ranking-first-date">${date}</span>` : ''}</div>
                </div>
                <div class="ranking-first-time">${formatLogTime(firstData.seconds)}</div>`;
            // 遅延でサムネ更新
            if (!thumbUrl && firstData.trackId) {
                loadThumbFromDB(firstData.trackId).then(dataUrl => {
                    if (dataUrl) {
                        const thumbEl = firstCard.querySelector('.ranking-first-thumb');
                        if (thumbEl) {
                            thumbEl.style.backgroundImage = `url(${dataUrl})`;
                            thumbEl.style.backgroundSize  = 'cover';
                            thumbEl.innerHTML = '';
                        }
                    }
                });
            }
        } else {
            firstCard.innerHTML = `
                <div class="ranking-first-info">
                    <div class="ranking-first-rank-label">1位</div>
                    <div class="ranking-first-title">${firstData.title || firstKey}</div>
                </div>
                <div class="ranking-first-time">${formatLogTime(firstData.seconds)}</div>`;
        }
    } else {
        firstCard.style.display = 'none';
    }

    list.innerHTML = '';
    list.setAttribute('start', '2');
    sorted.slice(1).forEach(([key, data], i) => {
        const rank = i + 2;
        const pct  = Math.round((data.seconds / maxVal) * 100);
        const li   = document.createElement('li');
        li.className = 'ranking-item';
        if (category === 'total') {
            const track    = appState.tracks.find(t => t.id === data.trackId) || null;
            const thumbUrl = thumbCache.get(data.trackId) || null;
            const thumbStyle = thumbUrl ? `background-image:url(${thumbUrl});background-size:cover;background-position:center;` : '';
            const thumbCont  = thumbUrl ? '' : '<span class="material-symbols-rounded">music_note</span>';
            const tags     = sortTagsByOrder((track?.tags || data.tags || [])).slice(0, 2);
            const tagsHtml = tags.length > 0
                ? `<div class="rank-tags">${tags.map(t => {
                    const tObj = typeof t === 'string' ? { text: t, color: '#aaa' } : t;
                    return `<span class="rank-tag" style="border:1px solid ${tObj.color};background:${tObj.color}22;">${tObj.text}</span>`;
                }).join('')}</div>` : '';
            const artist = track?.artist || data.artist || '-';
            const date   = track?.date   || data.date   || '';
            li.innerHTML = `
                <span class="rank-num">${rank}</span>
                <div class="rank-thumb" style="${thumbStyle}">${thumbCont}</div>
                <div class="rank-bar-area">
                    <div class="rank-name">${data.title || key}</div>
                    <div class="rank-sub">${artist}${date ? '　' + date : ''}</div>
                    ${tagsHtml}
                    <div class="rank-bar-track"><div class="rank-bar-fill" style="width:${pct}%"></div></div>
                </div>
                <span class="rank-time">${formatLogTime(data.seconds)}</span>`;
        } else {
            li.innerHTML = `
                <span class="rank-num">${rank}</span>
                <div class="rank-bar-area">
                    <div class="rank-name">${data.title || key}</div>
                    <div class="rank-bar-track"><div class="rank-bar-fill" style="width:${pct}%"></div></div>
                </div>
                <span class="rank-time">${formatLogTime(data.seconds)}</span>`;
        }
        list.appendChild(li);
    });

    if (sorted.length === 0) {
        firstCard.style.display = 'none';
        list.innerHTML = '<li style="padding:20px;text-align:center;color:var(--text-tertiary);font-size:13px;">データがありません</li>';
    }
}

function formatLogTime(seconds) {
    if (seconds < 60) return `${Math.floor(seconds)} 秒`;
    const m = Math.floor(seconds / 60);
    if (m < 60) return `${m} 分`;
    const h = Math.floor(m / 60);
    return `${h} 時間 ${m % 60} 分`;
}

// ─────────────────────────────────────────────
// 周年バナー
// ─────────────────────────────────────────────
function renderAnniversaryBanner() {
    const section = document.getElementById('anniversary-section');
    const listEl  = document.getElementById('anniversary-list');
    if (!section || !listEl) return;

    const today = new Date();
    const todayMD = `${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    const anniversaries = appState.tracks.filter(t => {
        if (!t.date) return false;
        const m = t.date.match(/(\d{4})-(\d{2})-(\d{2})/);
        if (!m) return false;
        const year   = parseInt(m[1]);
        const md     = `${m[2]}-${m[3]}`;
        return md === todayMD && year < today.getFullYear();
    }).map(t => {
        const year = parseInt(t.date.substring(0, 4));
        const diff = today.getFullYear() - year;
        return { track: t, years: diff };
    }).sort((a, b) => b.years - a.years);

    if (anniversaries.length === 0) {
        section.style.display = 'none';
        return;
    }

    section.style.display = '';
    listEl.innerHTML = '';
    anniversaries.forEach(({ track, years }) => {
        const item  = document.createElement('div');
        item.className = 'anniversary-item';
        const thumb = document.createElement('div');
        thumb.className = 'anniversary-thumb';
        const cached = thumbCache.get(track.id);
        if (cached) {
            thumb.style.backgroundImage = `url(${cached})`;
            thumb.style.backgroundSize  = 'cover';
        } else {
            thumb.innerHTML = '<span class="material-symbols-rounded">music_note</span>';
            loadThumbForElement(track.id, thumb);
        }
        const info  = document.createElement('div');
        info.className = 'anniversary-info';
        info.innerHTML = `<div class="anniversary-title">${track.title}</div><div class="anniversary-artist">${track.artist || '-'}</div>`;
        const badge = document.createElement('span');
        badge.className  = 'anniversary-badge';
        badge.textContent = `🎉 ${years}周年`;
        item.appendChild(thumb);
        item.appendChild(info);
        item.appendChild(badge);
        listEl.appendChild(item);
    });
}

// ─────────────────────────────────────────────
// カレンダービュー
// ─────────────────────────────────────────────
function initCalendar() {
    const prevBtn = document.getElementById('cal-prev-btn');
    const nextBtn = document.getElementById('cal-next-btn');
    const closeBtn = document.getElementById('cal-day-close');

    if (prevBtn) prevBtn.addEventListener('click', () => {
        appState.calendarMonth--;
        if (appState.calendarMonth < 0) { appState.calendarMonth = 11; appState.calendarYear--; }
        renderCalendar();
    });
    if (nextBtn) nextBtn.addEventListener('click', () => {
        appState.calendarMonth++;
        if (appState.calendarMonth > 11) { appState.calendarMonth = 0; appState.calendarYear++; }
        renderCalendar();
    });
    if (closeBtn) closeBtn.addEventListener('click', () => {
        const panel = document.getElementById('calendar-day-panel');
        if (panel) panel.style.display = 'none';
    });
}

function renderCalendar() {
    const year  = appState.calendarYear;
    const month = appState.calendarMonth;

    const labelEl = document.getElementById('cal-month-label');
    if (labelEl) labelEl.textContent = `${year}年 ${month + 1}月`;

    const grid  = document.getElementById('calendar-grid');
    if (!grid) return;
    grid.innerHTML = '';

    const today   = new Date();
    const firstDay = new Date(year, month, 1).getDay(); // 0=日
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    // 月内の各日にリリース曲を集計 (月/日が一致するもの - 年問わず)
    const dayTracks = {}; // day(1-31) → Track[]
    appState.tracks.forEach(t => {
        if (!t.date) return;
        const m = t.date.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (!m) return;
        const tMonth = parseInt(m[2]) - 1;
        const tDay   = parseInt(m[3]);
        if (tMonth === month) {
            if (!dayTracks[tDay]) dayTracks[tDay] = [];
            dayTracks[tDay].push(t);
        }
    });

    // 空セル
    for (let i = 0; i < firstDay; i++) {
        const empty = document.createElement('div');
        empty.className = 'cal-day cal-empty';
        grid.appendChild(empty);
    }

    for (let day = 1; day <= daysInMonth; day++) {
        const cell = document.createElement('div');
        const dow  = new Date(year, month, day).getDay();
        cell.className = 'cal-day' +
            (dow === 0 ? ' cal-day-sun' : dow === 6 ? ' cal-day-sat' : '') +
            (today.getFullYear() === year && today.getMonth() === month && today.getDate() === day ? ' cal-today' : '') +
            (dayTracks[day] ? ' cal-has-tracks' : '');

        const numEl = document.createElement('div');
        numEl.className = 'cal-day-num';
        numEl.textContent = day;
        cell.appendChild(numEl);

        if (dayTracks[day]) {
            const dotRow = document.createElement('div');
            dotRow.className = 'cal-dot-row';
            const tracks = dayTracks[day];
            const maxDots = 5;
            tracks.slice(0, maxDots).forEach(t => {
                const sorted = sortTagsByOrder(t.tags || []);
                const color  = sorted.length > 0
                    ? (typeof sorted[0] === 'string' ? getTagColorHex(sorted[0]) : sorted[0].color)
                    : '#1a6ef5';
                const dot = document.createElement('div');
                dot.className = 'cal-dot';
                dot.style.background = color;
                dotRow.appendChild(dot);
            });
            if (tracks.length > maxDots) {
                const more = document.createElement('div');
                more.className = 'cal-dot-more';
                more.textContent = `+${tracks.length - maxDots}`;
                dotRow.appendChild(more);
            }
            cell.appendChild(dotRow);

            cell.addEventListener('click', () => showCalendarDayPanel(year, month, day, tracks));
        }
        grid.appendChild(cell);
    }

    // 開いていた詳細パネルは閉じる
    const panel = document.getElementById('calendar-day-panel');
    if (panel) panel.style.display = 'none';
}

function showCalendarDayPanel(year, month, day, tracks) {
    const panel   = document.getElementById('calendar-day-panel');
    const titleEl = document.getElementById('cal-day-title');
    const listEl  = document.getElementById('cal-track-list');
    if (!panel || !titleEl || !listEl) return;

    titleEl.textContent = `${year}年 ${month + 1}月 ${day}日 のリリース (${tracks.length}曲)`;
    listEl.innerHTML = '';

    const today = new Date();
    tracks.forEach(track => {
        const releaseYear = parseInt((track.date || '').substring(0, 4)) || 0;
        const isAnniv  = releaseYear > 0 && (today.getMonth() === month) && (today.getDate() === day) && releaseYear < today.getFullYear();
        const yearsAgo = today.getFullYear() - releaseYear;

        const li = document.createElement('li');
        li.className = 'cal-track-item';

        const thumb = document.createElement('div');
        thumb.className = 'cal-track-thumb';
        const cached = thumbCache.get(track.id);
        if (cached) {
            thumb.style.backgroundImage = `url(${cached})`;
            thumb.style.backgroundSize  = 'cover';
        } else {
            thumb.innerHTML = '<span class="material-symbols-rounded">music_note</span>';
            loadThumbForElement(track.id, thumb);
        }

        const info = document.createElement('div');
        info.className = 'cal-track-info';
        info.innerHTML = `<div class="cal-track-title">${track.title}</div><div class="cal-track-meta">${track.artist || '-'}　${track.date || ''}</div>`;

        li.appendChild(thumb);
        li.appendChild(info);

        if (isAnniv) {
            const badge = document.createElement('span');
            badge.className = 'cal-track-badge anniversary';
            badge.textContent = `🎉 ${yearsAgo}周年`;
            li.appendChild(badge);
        } else if (releaseYear > 0) {
            const badge = document.createElement('span');
            badge.className = 'cal-track-badge';
            badge.textContent = `${releaseYear}年`;
            li.appendChild(badge);
        }

        // クリックで再生
        li.addEventListener('click', () => {
            const idx = appState.currentQueue.findIndex(t => t.id === track.id);
            if (idx >= 0) playTrack(idx);
            else {
                // キューになければ検索なしで再生
                const allIdx = appState.tracks.findIndex(t => t.id === track.id);
                if (allIdx >= 0) {
                    appState.currentPlaylistId = null;
                    updateMainQueue();
                    const newIdx = appState.currentQueue.findIndex(t => t.id === track.id);
                    if (newIdx >= 0) playTrack(newIdx);
                }
            }
        });

        listEl.appendChild(li);
    });

    panel.style.display = '';
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ─────────────────────────────────────────────
// Google ログイン & Drive連携
// ─────────────────────────────────────────────
function initAuthUI() {
    const ensureTokenClient = () => {
        if (!GOOGLE_CLIENT_ID || typeof google === 'undefined' || !google.accounts?.oauth2) return null;
        if (!tokenClient) {
            tokenClient = google.accounts.oauth2.initTokenClient({
                client_id: GOOGLE_CLIENT_ID,
                scope: 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.profile',
                callback: (tokenResponse) => {
                    if (tokenResponse && tokenResponse.access_token) {
                        gapiAccessToken = tokenResponse.access_token;
                        appState.isLoggedIn = true;
                        fetchUserInfo(gapiAccessToken);
                    }
                },
            });
        }
        return tokenClient;
    };

    const doLogin = () => {
        if (!GOOGLE_CLIENT_ID) { showToast('GOOGLE_CLIENT_ID を設定してください', 'error'); return; }
        if (typeof google === 'undefined' || !google.accounts?.oauth2) {
            showToast('Google認証システムを読み込み中です。数秒後に再試行してください', 'warning'); return;
        }
        const client = ensureTokenClient();
        if (!client) return;
        client.requestAccessToken();
    };

    const doLogout = async () => {
        if (gapiAccessToken && typeof google !== 'undefined' && google.accounts?.oauth2) {
            try { google.accounts.oauth2.revoke(gapiAccessToken, () => {}); } catch {}
        }
        gapiAccessToken = null;
        appState.isLoggedIn = false;
        appState.user       = null;
        localStorage.removeItem(HARMONIA_USER_KEY);
        clearAuthProfile();
        updateAuthUIDisplay();
        showToast('ログアウトしました');
    };

    const settingsBtnLogin  = document.getElementById('settings-btn-login');
    const settingsBtnLogout = document.getElementById('settings-btn-logout');
    if (settingsBtnLogin)  settingsBtnLogin.addEventListener('click', doLogin);
    if (settingsBtnLogout) settingsBtnLogout.addEventListener('click', doLogout);

    // ブラウザ再起動後の復帰を試行（Google側のセッションが残っている場合のみ成功）
    const savedProfile = loadSavedAuthProfile();
    if (savedProfile) {
        const tryRestore = () => {
            const client = ensureTokenClient();
            if (!client || appState.isLoggedIn) return;
            try { client.requestAccessToken({ prompt: '' }); } catch {}
        };
        if (typeof google === 'undefined' || !google.accounts?.oauth2) {
            window.addEventListener('load', () => setTimeout(tryRestore, 600), { once: true });
        } else {
            setTimeout(tryRestore, 600);
        }
    }
}

function fetchUserInfo(token) {
    fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${token}` }
    })
    .then(res => res.json())
    .then(async data => {
        const prevUserId = localStorage.getItem(HARMONIA_USER_KEY);
        if (prevUserId && prevUserId !== String(data.sub)) {
            const merge = confirm(
                `前回と異なるGoogleアカウント（${data.name}）でログインしました。

` +
                `[OK] ローカルデータを保持したままこのアカウントの同期データとマージする
` +
                `[キャンセル] ローカルデータをリセットしてこのアカウントで開始する`
            );
            if (!merge) await clearLocalDataForAccountSwitch();
        }
        localStorage.setItem(HARMONIA_USER_KEY, String(data.sub));
        saveAuthProfile(data);
        appState.user = data;
        updateAuthUIDisplay();
        showToast(`${data.name} でログインしました`, 'success');
        autoSync();
    })
    .catch(err => console.error('ユーザー情報取得エラー:', err));
}

async function clearLocalDataForAccountSwitch() {
    await new Promise((resolve, reject) => {
        const tx = db.transaction(['tracks', 'playlists', 'logs', 'blobs', 'thumbs'], 'readwrite');
        tx.objectStore('tracks').clear();
        tx.objectStore('playlists').clear();
        tx.objectStore('logs').clear();
        tx.objectStore('blobs').clear();
        tx.objectStore('thumbs').clear();
        tx.oncomplete = resolve;
        tx.onerror    = e => reject(e.target.error);
    });
    thumbCache.clear();
    appState.tracks            = [];
    appState.playlists         = [];
    appState.currentQueue      = [];
    appState.currentTrackIndex = -1;
    appState.isPlaying         = false;
    localStorage.removeItem(SYNC_STATE_KEY);
    updateMainQueue();
    showToast('ローカルデータをリセットしました', 'warning');
}

function updateAuthUIDisplay() {
    const userInfo         = document.getElementById('user-info');
    const userName         = document.getElementById('user-name');
    const settingsBtnLogin = document.getElementById('settings-btn-login');
    const settingsUserInfo = document.getElementById('settings-user-info');
    const settingsUserName = document.getElementById('settings-user-name');
    const manualItem       = document.getElementById('sync-manual-item');
    const retryItem        = document.getElementById('sync-retry-item');
    const progressItem     = document.getElementById('sync-progress-item');
    const syncStatus       = document.getElementById('sync-status');

    if (appState.isLoggedIn && appState.user) {
        if (userInfo)  userInfo.style.display  = 'flex';
        if (userName)  userName.textContent    = appState.user.name || 'ユーザー';
        if (settingsBtnLogin)  settingsBtnLogin.style.display  = 'none';
        if (settingsUserInfo)  settingsUserInfo.style.display  = 'flex';
        if (settingsUserName)  settingsUserName.textContent    = appState.user.name || 'ユーザー';
        if (!appState.isSyncing) {
            if (progressItem && progressItem.style.display !== '') {
                if (manualItem) manualItem.style.display = '';
            }
        }
    } else {
        if (userInfo)          userInfo.style.display          = 'none';
        if (settingsBtnLogin)  settingsBtnLogin.style.display  = 'flex';
        if (settingsUserInfo)  settingsUserInfo.style.display  = 'none';
        if (syncStatus)        syncStatus.textContent          = '';
        if (manualItem)        manualItem.style.display        = 'none';
        if (retryItem)         retryItem.style.display         = 'none';
        if (progressItem)      progressItem.style.display      = 'none';
    }
}

// ─────────────────────────────────────────────
// 自動同期
// ─────────────────────────────────────────────
function autoSync() {
    if (!appState.isLoggedIn || appState.isSyncing) return;
    if (!appState.isAutoSync) {
        incrementPendingOps();
        return;
    }
    performDriveSync();
}

// ─────────────────────────────────────────────
// 同期 state helpers（中断耐性）
// ─────────────────────────────────────────────
function getSyncState() {
    try { return JSON.parse(localStorage.getItem(SYNC_STATE_KEY) || 'null'); } catch { return null; }
}
function setSyncState(state) {
    localStorage.setItem(SYNC_STATE_KEY, JSON.stringify({ ...state, ts: Date.now() }));
}
function clearSyncState() {
    localStorage.removeItem(SYNC_STATE_KEY);
}

// ─────────────────────────────────────────────
// Google Drive 同期（分割JSON対応）
// ─────────────────────────────────────────────
async function performDriveSync() {
    if (!gapiAccessToken) return;
    if (appState.isSyncing) return;
    appState.isSyncing = true;

    const prevState    = getSyncState();
    const uploadedIds  = prevState?.uploadedIds || [];
    setSyncState({ phase: 'start', uploadedIds });
    updateSyncProgress(0, '同期を開始しています...');

    try {
        updateSyncProgress(5, 'フォルダを確認中...');
        const folderId      = await getOrCreateSyncFolder();
        const thumbFolderId = await getOrCreateSubFolder('thumbnails', folderId);

        updateSyncProgress(10, 'リモートデータを取得中...');
        const [metaFileId, plFileId, settingsFileId] = await Promise.all([
            findDriveFile('tracks_meta.json', 'application/json', folderId),
            findDriveFile('playlists.json', 'application/json', folderId),
            findDriveFile('settings.json', 'application/json', folderId)
        ]);

        let remoteTracks    = [];
        let remotePlaylists = [];
        let remoteTagOrder   = [];

        if (metaFileId) {
            const res = await driveGet(`https://www.googleapis.com/drive/v3/files/${metaFileId}?alt=media`);
            if (res.ok) {
                const j = await res.json();
                remoteTracks = Array.isArray(j.tracks) ? j.tracks : [];
            }
        }
        if (plFileId) {
            const res = await driveGet(`https://www.googleapis.com/drive/v3/files/${plFileId}?alt=media`);
            if (res.ok) {
                const j = await res.json();
                remotePlaylists = Array.isArray(j.playlists) ? j.playlists : [];
            }
        }
        if (settingsFileId) {
            const res = await driveGet(`https://www.googleapis.com/drive/v3/files/${settingsFileId}?alt=media`);
            if (res.ok) {
                const j = await res.json();
                remoteTagOrder = Array.isArray(j.tagOrder) ? j.tagOrder : [];
            }
        }

        updateSyncProgress(15, 'ローカルデータを読み込み中...');
        const localTracks    = await getAllTracksFromDBRaw();
        const localPlaylists = await getAllPlaylistsFromDBRaw();
        const localTrackMap  = new Map(localTracks.map(t => [t.id, t]));
        const localPlaylistMap = new Map(localPlaylists.map(p => [p.id, p]));

        updateSyncProgress(16, 'ログデータを同期中...');
        await syncLogsWithDrive(folderId);

        if (remoteTagOrder.length > 0) {
            remoteTagOrder.forEach(t => {
                if (!appState.tagOrder.includes(t)) appState.tagOrder.push(t);
            });
            syncTagOrder();
        }

        updateSyncProgress(18, 'メタデータを比較中...');
        const remoteTrackIdSet = new Set(remoteTracks.map(t => t.id));
        const remoteDriveIdSet = new Set(remoteTracks.map(t => t.driveFileId).filter(Boolean));

        // 1) リモートJSONの曲をローカルへ反映
        for (const rTrack of remoteTracks) {
            const lTrack = localTrackMap.get(rTrack.id);
            if (!lTrack) {
                await saveTrackToDB(rTrack);
                localTrackMap.set(rTrack.id, rTrack);
            } else {
                const rTime = rTrack.updatedAt || 0;
                const lTime = lTrack.updatedAt || 0;
                if (rTime > lTime) {
                    const merged = { ...lTrack, ...rTrack };
                    await saveTrackToDB(merged);
                    localTrackMap.set(rTrack.id, merged);
                }
            }
        }

        // 2) Drive直追加の音声ファイルを検出してローカルへ追加
        const driveAudioFiles = await listDriveFilesInFolder(folderId, "mimeType contains 'audio/'");
        for (const fileInfo of driveAudioFiles) {
            if (remoteDriveIdSet.has(fileInfo.id)) continue;
            const imported = await importDriveAudioFile(fileInfo, thumbFolderId);
            if (imported) {
                remoteTracks.push(imported);
                remoteTrackIdSet.add(imported.id);
                remoteDriveIdSet.add(imported.driveFileId);
                localTrackMap.set(imported.id, imported);
            }
        }

        // 3) サムネイルDL（JSON側の既存分）
        const thumbsToDownload = [];
        for (const rTrack of remoteTracks) {
            if (rTrack.deleted || !rTrack.thumbDriveId) continue;
            if (!thumbCache.has(rTrack.id)) {
                const existing = await getThumbFromDB(rTrack.id);
                if (!existing) thumbsToDownload.push(rTrack);
            }
        }
        for (let i = 0; i < thumbsToDownload.length; i++) {
            const rTrack = thumbsToDownload[i];
            const pct = 20 + Math.round(((i + 1) / Math.max(thumbsToDownload.length, 1)) * 25);
            updateSyncProgress(pct, `サムネイルDL中 (${i + 1}/${thumbsToDownload.length}): ${rTrack.title}`);
            const res = await driveGet(`https://www.googleapis.com/drive/v3/files/${rTrack.thumbDriveId}?alt=media`);
            if (res.ok) {
                const blob = await res.blob();
                const reader = new FileReader();
                const dataUrl = await new Promise(r => { reader.onload = e => r(e.target.result); reader.readAsDataURL(blob); });
                await saveThumbToDB(rTrack.id, dataUrl);
                thumbCache.set(rTrack.id, dataUrl);
            }
        }

        // 4) 音声DL（Drive直追加のうち、ローカルに無いものなど）
        const tracksToDownload = [];
        for (const rTrack of remoteTracks) {
            if (rTrack.deleted || appState.isStreaming || !rTrack.driveFileId) continue;
            const existingBlob = await getBlobFromDB(rTrack.id);
            if (!existingBlob) tracksToDownload.push(rTrack);
        }
        for (let i = 0; i < tracksToDownload.length; i++) {
            const rTrack = tracksToDownload[i];
            const pct = 45 + Math.round(((i + 1) / Math.max(tracksToDownload.length, 1)) * 20);
            updateSyncProgress(pct, `音声DL中 (${i + 1}/${tracksToDownload.length}): ${rTrack.title}`);
            setSyncState({ phase: 'downloading', uploadedIds, dlIndex: i });
            const blob = await downloadFileFromDrive(rTrack.driveFileId);
            if (blob) {
                await saveBlobToDB(rTrack.id, blob, rTrack.fileName || rTrack.title, blob.type || 'audio/mpeg');
            }
        }

        // 5) ローカル新規曲をDriveへアップロード
        const tracksToUpload = [];
        for (const lTrack of localTrackMap.values()) {
            if (!lTrack.deleted && !lTrack.driveFileId) {
                const blobEntry = await getBlobFromDB(lTrack.id);
                if (blobEntry && !uploadedIds.includes(lTrack.id)) {
                    tracksToUpload.push({ track: lTrack, blob: blobEntry });
                }
            }
        }
        for (let i = 0; i < tracksToUpload.length; i++) {
            const { track: lTrack, blob: blobEntry } = tracksToUpload[i];
            const pct = 65 + Math.round(((i + 1) / Math.max(tracksToUpload.length, 1)) * 20);
            updateSyncProgress(pct, `音声UP中 (${i + 1}/${tracksToUpload.length}): ${lTrack.title}`);
            setSyncState({ phase: 'uploading', uploadedIds, ulIndex: i });
            const fileId = await uploadFileToDrive(blobEntry, lTrack.fileName || lTrack.title, blobEntry.type || 'audio/mpeg', folderId);
            lTrack.driveFileId = fileId;
            lTrack.updatedAt = Date.now();
            await saveTrackToDB(lTrack);
            uploadedIds.push(lTrack.id);
            localTrackMap.set(lTrack.id, lTrack);
        }

        // 6) サムネイルUP
        updateSyncProgress(85, 'サムネイルをアップロード中...');
        for (const lTrack of localTrackMap.values()) {
            if (lTrack.deleted || lTrack.thumbDriveId) continue;
            const dataUrl = thumbCache.get(lTrack.id) || await getThumbFromDB(lTrack.id);
            if (!dataUrl) continue;
            const thumbBlob = dataUrlToBlob(dataUrl);
            if (!thumbBlob) continue;
            const thumbFileId = await uploadFileToDrive(thumbBlob, `thumb_${lTrack.id}.jpg`, 'image/jpeg', thumbFolderId);
            lTrack.thumbDriveId = thumbFileId;
            lTrack.updatedAt = Date.now();
            await saveTrackToDB(lTrack);
            localTrackMap.set(lTrack.id, lTrack);
        }

        // 7) 削除済み曲のDrive削除
        const deletedTracks = localTracks.filter(t => t.deleted);
        for (const track of deletedTracks) {
            if (track.driveFileId) await deleteDriveFile(track.driveFileId);
            if (track.thumbDriveId) await deleteDriveFile(track.thumbDriveId);
        }

        // 8) JSON再構築（削除済みは含めない）
        const finalTracks = Array.from(localTrackMap.values()).filter(t => !t.deleted).map(t => ({ ...t }));
        const finalPlaylists = Array.from(localPlaylistMap.values()).filter(p => !p.deleted).map(p => ({ ...p }));

        updateSyncProgress(90, 'メタデータを保存中...');
        setSyncState({ phase: 'json', uploadedIds });
        await uploadJsonToDrive({ tracks: finalTracks, version: 7, lastSyncedAt: Date.now() }, 'tracks_meta.json', folderId, metaFileId);
        await uploadJsonToDrive({ playlists: finalPlaylists, lastSyncedAt: Date.now() }, 'playlists.json', folderId, plFileId);
        await uploadJsonToDrive({ tagOrder: appState.tagOrder, lastSyncedAt: Date.now() }, 'settings.json', folderId, settingsFileId);

        // 9) Drive上で消えているものをローカルからも削除
        const finalRemoteIds = new Set(finalTracks.map(t => t.id));
        const staleLocalIds = localTracks
            .filter(t => t.driveFileId && !t.deleted && !finalRemoteIds.has(t.id))
            .map(t => t.id);
        for (const id of [...deletedTracks.map(t => t.id), ...staleLocalIds]) {
            await purgeTrackFromLocalDB(id);
        }

        updateSyncProgress(100, '同期が完了しました');
        clearSyncState();
        resetPendingOps();
        await loadLibrary();
        await loadPlaylists();
        renderAnniversaryBanner();
        showToast('同期が完了しました', 'success');
    } catch (error) {
        console.error('同期エラー:', error);
        updateSyncError('同期中にエラーが発生しました');
    } finally {
        appState.isSyncing = false;
        updateAuthUIDisplay();
    }
}

// ─────────────────────────────────────────────
// Google Drive / Auth / Sync 補助
// ─────────────────────────────────────────────
function escapeDriveQueryValue(value) {
    return String(value ?? '').replace(/'/g, "\\'");
}

function getScopedSyncFolderName() {
    const userId = appState.user?.sub || localStorage.getItem(HARMONIA_USER_KEY);
    return userId ? `${SYNC_FOLDER_NAME}_${userId}` : SYNC_FOLDER_NAME;
}

function loadSavedAuthProfile() {
    try {
        const raw = localStorage.getItem(AUTH_PROFILE_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

function saveAuthProfile(profile) {
    if (!profile || !profile.sub) return;
    localStorage.setItem(AUTH_PROFILE_KEY, JSON.stringify({
        sub: String(profile.sub),
        name: profile.name || '',
        email: profile.email || '',
        picture: profile.picture || '',
        updatedAt: Date.now()
    }));
}

function clearAuthProfile() {
    localStorage.removeItem(AUTH_PROFILE_KEY);
}

async function driveRequest(url, options = {}) {
    const headers = Object.assign({}, options.headers || {}, {
        Authorization: `Bearer ${gapiAccessToken}`
    });
    return fetch(url, { ...options, headers });
}

async function driveGet(url) {
    return driveRequest(url);
}

async function uploadJsonToDrive(obj, filename, folderId, existingId = null) {
    const blob = new Blob([JSON.stringify(obj)], { type: 'application/json' });
    await uploadFileToDrive(blob, filename, 'application/json', folderId, existingId);
}

function dataUrlToBlob(dataUrl) {
    try {
        const [header, data] = dataUrl.split(',');
        const mime = header.match(/:(.*?);/)[1];
        const binary = atob(data);
        const arr = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
        return new Blob([arr], { type: mime });
    } catch (e) {
        return null;
    }
}

async function listDriveFilesInFolder(parentId, extraQuery = '') {
    if (!parentId) return [];
    let q = `'${escapeDriveQueryValue(parentId)}' in parents and trashed=false`;
    if (extraQuery) q += ` and ${extraQuery}`;
    const res = await driveGet(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,modifiedTime,parents)`);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.files) ? data.files : [];
}

async function getOrCreateSyncFolder() {
    const folderName = getScopedSyncFolderName();
    const existingId = await findDriveFile(folderName, 'application/vnd.google-apps.folder');
    if (existingId) return existingId;
    const res = await fetch('https://www.googleapis.com/drive/v3/files', {
        method: 'POST',
        headers: { Authorization: `Bearer ${gapiAccessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: folderName, mimeType: 'application/vnd.google-apps.folder' })
    });
    return (await res.json()).id;
}

async function getOrCreateSubFolder(name, parentId) {
    const existingId = await findDriveFile(name, 'application/vnd.google-apps.folder', parentId);
    if (existingId) return existingId;
    const res = await fetch('https://www.googleapis.com/drive/v3/files', {
        method: 'POST',
        headers: { Authorization: `Bearer ${gapiAccessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] })
    });
    return (await res.json()).id;
}

async function findDriveFile(name, mimeType, parentId = null) {
    let q = `name='${escapeDriveQueryValue(name)}' and trashed=false`;
    if (mimeType) q += ` and mimeType='${escapeDriveQueryValue(mimeType)}'`;
    if (parentId) q += ` and '${escapeDriveQueryValue(parentId)}' in parents`;
    const res  = await driveGet(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)`);
    if (!res.ok) return null;
    const data = await res.json();
    return (data.files && data.files.length > 0) ? data.files[0].id : null;
}

async function uploadFileToDrive(blob, filename, mimeType, folderId, existingId = null) {
    let fileId = existingId;
    if (!fileId) {
        const metaRes = await fetch('https://www.googleapis.com/drive/v3/files', {
            method: 'POST',
            headers: { Authorization: `Bearer ${gapiAccessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: filename, parents: [folderId], mimeType })
        });
        fileId = (await metaRes.json()).id;
    }
    await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${gapiAccessToken}`, 'Content-Type': mimeType },
        body: blob
    });
    return fileId;
}

async function deleteDriveFile(fileId) {
    if (!fileId) return true;
    try {
        const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${gapiAccessToken}` }
        });
        return res.ok || res.status === 404;
    } catch (err) {
        console.warn('Drive delete failed:', fileId, err);
        return false;
    }
}

async function downloadFileFromDrive(fileId) {
    try {
        const res = await driveGet(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
        if (res.ok) return await res.blob();
    } catch (e) { console.error('ファイルダウンロード失敗:', e); }
    return null;
}

async function purgeTrackFromLocalDB(trackId) {
    if (!trackId) return;
    await deleteBlobFromDB(trackId);
    await deleteThumbFromDB(trackId);
    thumbCache.delete(trackId);
    await deleteTrackFromDB(trackId);
}

async function importDriveAudioFile(fileInfo, thumbFolderId) {
    const blob = await downloadFileFromDrive(fileInfo.id);
    if (!blob) return null;
    const meta = await readAudioTags(blob);
    const trackId = `drive_${fileInfo.id}`;
    const newTrack = {
        id: trackId,
        fileName: fileInfo.name,
        title: meta.title || fileInfo.name.replace(/\.[^/.]+$/, ''),
        artist: meta.artist || '不明なアーティスト',
        date: '',
        tags: [],
        addedAt: Date.now(),
        sortOrder: Date.now(),
        updatedAt: Date.now(),
        deleted: false,
        driveFileId: fileInfo.id,
        thumbDriveId: null
    };
    await saveTrackToDB(newTrack);
    if (!appState.isStreaming) {
        await saveBlobToDB(newTrack.id, blob, fileInfo.name, blob.type || 'audio/mpeg');
    }
    if (meta.picture) {
        await saveThumbToDB(newTrack.id, meta.picture);
        thumbCache.set(newTrack.id, meta.picture);
    }
    return newTrack;
}

async function syncLogsWithDrive(folderId) {
    const logFolderId = await getOrCreateSubFolder('logs', folderId);
    const localLogs = await getAllLogsFromDB();
    const merged = new Map(localLogs.map(log => [log.id, log]));

    // 既存のDriveログを取り込み（同一IDなら更新日時が新しいものを採用）
    const remoteFiles = await listDriveFilesInFolder(logFolderId, "mimeType = 'application/json'");
    for (const file of remoteFiles) {
        if (!/^logs_\d{4}-\d{2}\.json$/.test(file.name)) continue;
        const res = await driveGet(`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`);
        if (!res.ok) continue;
        try {
            const json = await res.json();
            for (const log of (json.logs || [])) {
                const existing = merged.get(log.id);
                if (!existing || (log.timestamp || 0) > (existing.timestamp || 0)) {
                    merged.set(log.id, log);
                }
            }
        } catch {}
    }

    const groups = new Map();
    for (const log of merged.values()) {
        const d = new Date(log.timestamp || Date.now());
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(log);
    }

    for (const [key, logsForMonth] of groups.entries()) {
        const fileName = `logs_${key}.json`;
        const fileId = await findDriveFile(fileName, 'application/json', logFolderId);
        await uploadJsonToDrive({ logs: logsForMonth, lastSyncedAt: Date.now() }, fileName, logFolderId, fileId);
    }
}

// ─────────────────────────────────────────────
// DB 初期化（v5: blobs / thumbs ストア追加）
// ─────────────────────────────────────────────
function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onerror   = (e) => reject(e.target.error);
        request.onsuccess = (e) => { db = e.target.result; resolve(db); };
        request.onupgradeneeded = (e) => {
            const database    = e.target.result;
            const oldVersion  = e.oldVersion;

            if (!database.objectStoreNames.contains('tracks'))
                database.createObjectStore('tracks',    { keyPath: 'id' });
            if (!database.objectStoreNames.contains('playlists'))
                database.createObjectStore('playlists', { keyPath: 'id' });
            if (!database.objectStoreNames.contains('logs'))
                database.createObjectStore('logs',      { keyPath: 'id', autoIncrement: true });

            // v5 新規ストア
            if (!database.objectStoreNames.contains('blobs'))
                database.createObjectStore('blobs', { keyPath: 'id' });
            if (!database.objectStoreNames.contains('thumbs'))
                database.createObjectStore('thumbs', { keyPath: 'id' });
        };
    });
}

/** v4→v5 マイグレーション: fileBlob → blobs, thumbnailDataUrl → thumbs */
async function migrateV4ToV5IfNeeded() {
    const MIGRATED_KEY = 'harmonia_migrated_v5';
    if (localStorage.getItem(MIGRATED_KEY)) return;

    // tracksストアからfileBlob/thumbnailDataUrlを分離
    const allTracks = await getAllTracksFromDBRaw();
    let migrated = 0;
    for (const track of allTracks) {
        let changed = false;
        if (track.fileBlob) {
            await saveBlobToDB(track.id, track.fileBlob, track.fileName || track.title, track.fileBlob.type);
            delete track.fileBlob;
            changed = true;
        }
        if (track.thumbnailDataUrl) {
            await saveThumbToDB(track.id, track.thumbnailDataUrl);
            thumbCache.set(track.id, track.thumbnailDataUrl);
            delete track.thumbnailDataUrl;
            changed = true;
        }
        if (changed) {
            await saveTrackToDB(track);
            migrated++;
        }
    }
    if (migrated > 0) console.log(`[Migration] v4→v5: ${migrated}曲 移行完了`);
    localStorage.setItem(MIGRATED_KEY, '1');
}

// ─────────────────────────────────────────────
// DB CRUD ヘルパー
// ─────────────────────────────────────────────
function saveTrackToDB(track) {
    return new Promise((resolve, reject) => {
        const tx  = db.transaction(['tracks'], 'readwrite');
        const req = tx.objectStore('tracks').put(track);
        req.onsuccess = () => resolve();
        req.onerror   = (e) => reject(e.target.error);
    });
}

function savePlaylistToDB(pl) {
    return new Promise((resolve, reject) => {
        const tx  = db.transaction(['playlists'], 'readwrite');
        const req = tx.objectStore('playlists').put(pl);
        req.onsuccess = () => resolve();
        req.onerror   = e => reject(e.target.error);
    });
}

function getAllTracksFromDBRaw() {
    return new Promise((resolve, reject) => {
        const tx  = db.transaction(['tracks'], 'readonly');
        const req = tx.objectStore('tracks').getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror   = (e) => reject(e.target.error);
    });
}

function getAllPlaylistsFromDBRaw() {
    return new Promise((resolve, reject) => {
        const tx  = db.transaction(['playlists'], 'readonly');
        const req = tx.objectStore('playlists').getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror   = (e) => reject(e.target.error);
    });
}

function deleteTrackFromDB(id) {
    return new Promise((resolve, reject) => {
        const tx  = db.transaction(['tracks'], 'readwrite');
        const req = tx.objectStore('tracks').delete(id);
        req.onsuccess = () => resolve();
        req.onerror   = e => reject(e.target.error);
    });
}

// ── blobs store ──
function saveBlobToDB(id, blob, fileName, mimeType) {
    return new Promise((resolve, reject) => {
        const tx  = db.transaction(['blobs'], 'readwrite');
        const req = tx.objectStore('blobs').put({ id, blob, fileName, mimeType });
        req.onsuccess = () => resolve();
        req.onerror   = e => reject(e.target.error);
    });
}

function getBlobFromDB(id) {
    return new Promise((resolve, reject) => {
        const tx  = db.transaction(['blobs'], 'readonly');
        const req = tx.objectStore('blobs').get(id);
        req.onsuccess = () => resolve(req.result ? req.result.blob : null);
        req.onerror   = e => reject(e.target.error);
    });
}

function deleteBlobFromDB(id) {
    return new Promise((resolve, reject) => {
        const tx  = db.transaction(['blobs'], 'readwrite');
        const req = tx.objectStore('blobs').delete(id);
        req.onsuccess = () => resolve();
        req.onerror   = e => reject(e.target.error);
    });
}

// ── thumbs store ──
function saveThumbToDB(id, dataUrl) {
    return new Promise((resolve, reject) => {
        const tx  = db.transaction(['thumbs'], 'readwrite');
        const req = tx.objectStore('thumbs').put({ id, dataUrl });
        req.onsuccess = () => resolve();
        req.onerror   = e => reject(e.target.error);
    });
}

function getThumbFromDB(id) {
    return new Promise((resolve, reject) => {
        const tx  = db.transaction(['thumbs'], 'readonly');
        const req = tx.objectStore('thumbs').get(id);
        req.onsuccess = () => resolve(req.result ? req.result.dataUrl : null);
        req.onerror   = e => reject(e.target.error);
    });
}

function deleteThumbFromDB(id) {
    return new Promise((resolve, reject) => {
        const tx  = db.transaction(['thumbs'], 'readwrite');
        const req = tx.objectStore('thumbs').delete(id);
        req.onsuccess = () => resolve();
        req.onerror   = e => reject(e.target.error);
    });
}

/** DB からサムネイルを取得してキャッシュに格納（Promise<string|null>） */
async function loadThumbFromDB(id) {
    if (thumbCache.has(id)) return thumbCache.get(id);
    const dataUrl = await getThumbFromDB(id);
    if (dataUrl) thumbCache.set(id, dataUrl);
    return dataUrl || null;
}

/** DOM 要素にサムネイルを遅延セット */
function loadThumbForElement(trackId, element) {
    loadThumbFromDB(trackId).then(dataUrl => {
        if (dataUrl && element.isConnected) {
            element.style.backgroundImage = `url(${dataUrl})`;
            element.style.backgroundSize  = 'cover';
            element.innerHTML = '';
        }
    });
}

// ─────────────────────────────────────────────
// ライブラリ読み込み（メタのみ / blob なし）
// ─────────────────────────────────────────────
async function loadLibrary() {
    const allTracks = await getAllTracksFromDBRaw();
    appState.tracks = allTracks.filter(t => !t.deleted);
    appState.tracks.sort((a, b) => {
        const oA = a.sortOrder !== undefined ? a.sortOrder : a.addedAt;
        const oB = b.sortOrder !== undefined ? b.sortOrder : b.addedAt;
        return oA - oB;
    });

    appState.allKnownTags.clear();
    appState.tracks.forEach(t => {
        if (t.tags) t.tags.forEach(tag => {
            const tagObj = typeof tag === 'string' ? { text: tag, color: getTagColorHex(tag) } : tag;
            if (!appState.allKnownTags.has(tagObj.text)) appState.allKnownTags.set(tagObj.text, tagObj);
        });
    });
    syncTagOrder();
    updateTagsDatalist();
    updateArtistsDatalist();
    updateMainQueue();
}

function updateTagsDatalist() {
    const dl = document.getElementById('existing-tags-list');
    if (!dl) return;
    dl.innerHTML = '';
    appState.tagOrder.forEach(text => {
        const tagObj = appState.allKnownTags.get(text);
        if (!tagObj) return;
        const opt = document.createElement('option');
        opt.value = text;
        dl.appendChild(opt);
    });
}

function updateArtistsDatalist() {
    const dl = document.getElementById('existing-artists-list');
    if (!dl) return;
    dl.innerHTML = '';
    const artists = [...new Set(appState.tracks.map(t => t.artist).filter(Boolean))];
    artists.forEach(a => {
        const opt = document.createElement('option');
        opt.value = a;
        dl.appendChild(opt);
    });
}

async function saveManualOrder() {
    if (appState.currentPlaylistId) {
        const pl = appState.playlists.find(p => p.id === appState.currentPlaylistId);
        if (pl) {
            pl.trackIds  = appState.currentQueue.map(t => t.id);
            pl.updatedAt = Date.now();
            await savePlaylistToDB(pl);
            autoSync();
        }
    } else {
        if (!appState.searchQueryMain) {
            appState.tracks = [...appState.currentQueue];
            const tx    = db.transaction(['tracks'], 'readwrite');
            const store = tx.objectStore('tracks');
            appState.tracks.forEach((t, i) => {
                t.sortOrder  = i;
                t.updatedAt  = Date.now();
                store.put(t);
            });
            tx.oncomplete = () => autoSync();
        }
    }
}

// ─────────────────────────────────────────────
// 曲削除
// ─────────────────────────────────────────────
async function deleteTracksCompletely(trackIds) {
    if (!confirm(`${trackIds.length}曲をライブラリから完全に削除しますか？\nこの操作は元に戻せません。`)) return;
    const playlists = await getAllPlaylistsFromDBRaw();
    for (const pl of playlists) {
        let changed = false;
        trackIds.forEach(id => {
            const i = pl.trackIds.indexOf(id);
            if (i !== -1) { pl.trackIds.splice(i, 1); changed = true; }
        });
        if (changed) { pl.updatedAt = Date.now(); await savePlaylistToDB(pl); }
    }
    const tracks = await getAllTracksFromDBRaw();
    for (const id of trackIds) {
        const track = tracks.find(t => t.id === id);
        if (track) {
            track.deleted   = true;
            track.updatedAt = Date.now();
            await saveTrackToDB(track);
        }
        // blob/thumb も削除
        await deleteBlobFromDB(id);
        await deleteThumbFromDB(id);
        thumbCache.delete(id);
    }
    appState.selectedMainTracks.clear();
    appState.editSelectedTracks.clear();
    showToast(`${trackIds.length}曲 を削除しました`);
    await loadPlaylists();
    await loadLibrary();
    autoSync();
}

// ─────────────────────────────────────────────
// ドラッグ&ドロップ / ファイル読み込み
// ─────────────────────────────────────────────
function initDragAndDrop() {
    const dropZone      = document.getElementById('drop-zone');
    const dropZoneSmall = document.getElementById('drop-zone-small');
    const fileInput     = document.getElementById('file-upload');

    if (fileInput) fileInput.addEventListener('change', (e) => handleFiles(e.target.files));

    if (dropZone) {
        dropZone.addEventListener('dragover',  (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
        dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
        dropZone.addEventListener('drop', (e) => {
            e.preventDefault(); dropZone.classList.remove('dragover');
            if (e.dataTransfer.files) handleFiles(e.dataTransfer.files);
        });
        dropZone.addEventListener('click', () => fileInput && fileInput.click());
    }

    if (dropZoneSmall) {
        dropZoneSmall.addEventListener('click', () => fileInput && fileInput.click());
        dropZoneSmall.addEventListener('dragover',  (e) => { e.preventDefault(); dropZoneSmall.classList.add('dragover'); });
        dropZoneSmall.addEventListener('dragleave', () => dropZoneSmall.classList.remove('dragover'));
        dropZoneSmall.addEventListener('drop', (e) => {
            e.preventDefault(); dropZoneSmall.classList.remove('dragover');
            if (e.dataTransfer.files) handleFiles(e.dataTransfer.files);
        });
    }

    document.addEventListener('dragover', (e) => e.preventDefault());
    document.addEventListener('drop', (e) => {
        e.preventDefault();
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            const hasAudio = Array.from(e.dataTransfer.files).some(f => f.type.startsWith('audio/'));
            if (hasAudio) handleFiles(e.dataTransfer.files);
        }
    });
}

function readAudioTags(file) {
    return new Promise((resolve) => {
        if (typeof window.jsmediatags === 'undefined') {
            resolve({ title: null, artist: null, picture: null }); return;
        }
        window.jsmediatags.read(file, {
            onSuccess: (tag) => {
                const tags = tag.tags;
                let pictureUrl = null;
                if (tags.picture) {
                    try {
                        let base64String = '';
                        tags.picture.data.forEach(byte => base64String += String.fromCharCode(byte));
                        pictureUrl = `data:${tags.picture.format};base64,${window.btoa(base64String)}`;
                    } catch (e) {}
                }
                resolve({ title: tags.title || null, artist: tags.artist || null, picture: pictureUrl });
            },
            onError: () => resolve({ title: null, artist: null, picture: null })
        });
    });
}

async function handleFiles(files) {
    if (!files || files.length === 0) return;
    let added = 0;
    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (!file.type.startsWith('audio/')) continue;
        const meta = await readAudioTags(file);
        const newTrack = {
            id:         'track_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
            fileName:   file.name,
            title:      meta.title || file.name.replace(/\.[^/.]+$/, ''),
            artist:     meta.artist || '不明なアーティスト',
            date:       '', tags: [],
            addedAt:    Date.now(), sortOrder: Date.now(),
            updatedAt:  Date.now(), deleted: false,
            driveFileId: null, thumbDriveId: null
        };
        await saveTrackToDB(newTrack);
        // blob / thumb を別ストアに保存
        await saveBlobToDB(newTrack.id, file, file.name, file.type);
        if (meta.picture) {
            await saveThumbToDB(newTrack.id, meta.picture);
            thumbCache.set(newTrack.id, meta.picture);
        }
        added++;
    }
    if (added > 0) {
        showToast(`${added}曲 を追加しました`, 'success');
        await loadLibrary();
        autoSync();
    }
}

// ─────────────────────────────────────────────
// プレイリスト
// ─────────────────────────────────────────────
function initPlaylists() {
    const createBtn = document.getElementById('create-playlist-btn');
    if (createBtn) {
        createBtn.addEventListener('click', async () => {
            const name = prompt('新しいプレイリストの名前を入力してください');
            if (!name || !name.trim()) return;
            const newList = {
                id: 'pl_' + Date.now(), name: name.trim(),
                trackIds: [], updatedAt: Date.now(), deleted: false
            };
            await savePlaylistToDB(newList);
            await loadPlaylists();
            showToast(`「${newList.name}」を作成しました`, 'success');
            autoSync();
        });
    }
}

async function loadPlaylists() {
    const allPl = await getAllPlaylistsFromDBRaw();
    appState.playlists = allPl.filter(p => !p.deleted);

    const tabsContainer = document.getElementById('playlist-tabs');
    if (!tabsContainer) return;
    tabsContainer.querySelectorAll('.playlist-tab:not(#library-all-btn)').forEach(t => t.remove());

    appState.playlists.forEach(pl => {
        const tab = document.createElement('button');
        tab.className  = 'playlist-tab' + (appState.currentPlaylistId === pl.id ? ' active' : '');
        tab.dataset.id = pl.id;
        tab.innerHTML  = `
            <span class="material-symbols-rounded">queue_music</span>
            <span>${pl.name}</span>
            <button class="tab-del" title="削除">
                <span class="material-symbols-rounded" style="font-size:10px;">close</span>
            </button>
        `;
        tab.addEventListener('click', (e) => {
            if (e.target.closest('.tab-del')) return;
            appState.currentPlaylistId = pl.id;
            document.getElementById('current-playlist-name').textContent = pl.name;
            appState.selectedMainTracks.clear();
            updateMainQueue();
            document.querySelectorAll('.playlist-tab').forEach(el => el.classList.remove('active'));
            tab.classList.add('active');
        });
        tab.querySelector('.tab-del').addEventListener('click', (e) => {
            e.stopPropagation();
            deletePlaylist(pl.id, pl.name);
        });
        tabsContainer.appendChild(tab);
    });
}

function openAddToPlaylistModal(trackIdsArray) {
    if (appState.playlists.length === 0) {
        showToast('プレイリストがありません。先に作成してください', 'warning'); return;
    }
    const modal   = document.createElement('div');
    modal.className = 'modal-overlay';
    const listHtml = appState.playlists.map(pl =>
        `<div class="modal-playlist-item" data-id="${pl.id}">
            <span class="material-symbols-rounded">queue_music</span>${pl.name}
         </div>`
    ).join('');
    modal.innerHTML = `
        <div class="edit-modal-content" style="max-width:360px;">
            <div class="edit-modal-header">
                <h2 class="edit-modal-title">プレイリストに追加 <span style="font-size:12px;font-weight:400;color:var(--text-secondary);">${trackIdsArray.length}曲</span></h2>
                <button class="icon-btn" id="close-pl-modal"><span class="material-symbols-rounded">close</span></button>
            </div>
            <div style="padding:8px 16px 16px;max-height:280px;overflow-y:auto;">${listHtml}</div>
        </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
    modal.querySelector('#close-pl-modal').addEventListener('click', () => modal.remove());
    modal.querySelectorAll('.modal-playlist-item').forEach(item => {
        item.style.cssText = 'padding:10px 12px;border-radius:8px;cursor:pointer;display:flex;align-items:center;gap:8px;font-size:13px;transition:background 0.15s;';
        item.addEventListener('mouseenter', () => item.style.background = 'var(--bg-hover)');
        item.addEventListener('mouseleave', () => item.style.background = '');
        item.addEventListener('click', async () => {
            await addTracksToPlaylist(item.getAttribute('data-id'), trackIdsArray);
            modal.remove();
        });
    });
}

async function addTracksToPlaylist(playlistId, trackIdsArray) {
    const pl = appState.playlists.find(p => p.id === playlistId);
    if (!pl) return;
    let addedCount = 0;
    trackIdsArray.forEach(id => {
        if (!pl.trackIds.includes(id)) { pl.trackIds.push(id); addedCount++; }
    });
    if (addedCount === 0) { showToast('すでにすべての曲がリストに追加されています', 'warning'); return; }
    pl.updatedAt = Date.now();
    await savePlaylistToDB(pl);
    appState.selectedMainTracks.clear();
    await loadPlaylists();
    if (appState.currentPlaylistId === playlistId) updateMainQueue();
    showToast(`「${pl.name}」に ${addedCount}曲 追加しました`, 'success');
    autoSync();
}

async function removeTracksFromPlaylist(playlistId, trackIdsArray) {
    if (!confirm(`${trackIdsArray.length}曲をプレイリストから外しますか？`)) return;
    const pl = appState.playlists.find(p => p.id === playlistId);
    if (!pl) return;
    pl.trackIds  = pl.trackIds.filter(id => !trackIdsArray.includes(id));
    pl.updatedAt = Date.now();
    await savePlaylistToDB(pl);
    appState.selectedMainTracks.clear();
    await loadPlaylists();
    updateMainQueue();
    showToast('プレイリストから外しました');
    autoSync();
}

async function deletePlaylist(playlistId, playlistName) {
    if (!confirm(`プレイリスト「${playlistName}」を削除しますか？\n（曲データは残ります）`)) return;
    const pl = appState.playlists.find(p => p.id === playlistId);
    if (pl) { pl.deleted = true; pl.updatedAt = Date.now(); await savePlaylistToDB(pl); }
    await loadPlaylists();
    if (appState.currentPlaylistId === playlistId) {
        appState.currentPlaylistId = null;
        document.getElementById('current-playlist-name').textContent = 'すべての曲';
        const libraryAllBtn = document.getElementById('library-all-btn');
        if (libraryAllBtn) libraryAllBtn.classList.add('active');
        updateMainQueue();
    }
    showToast(`「${playlistName}」を削除しました`);
    autoSync();
}

// ─────────────────────────────────────────────
// 編集ページ：サブタブ（曲一覧 / タグ管理）
// ─────────────────────────────────────────────
function initEditSubTabs() {
    document.querySelectorAll('.edit-sub-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            const tabName = tab.getAttribute('data-tab');
            appState.currentEditTab = tabName;
            document.querySelectorAll('.edit-sub-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');

            const tracksHeader = document.getElementById('edit-tracks-header');
            const tagsHeader   = document.getElementById('edit-tags-header');
            const tracksView   = document.getElementById('edit-tracks-view');
            const tagsView     = document.getElementById('tag-management-view');

            if (tabName === 'tracks') {
                if (tracksHeader) tracksHeader.style.display = '';
                if (tagsHeader)   tagsHeader.style.display   = 'none';
                if (tracksView)   tracksView.style.display   = '';
                if (tagsView)     tagsView.style.display     = 'none';
                renderVirtualEditGrid();
            } else {
                if (tracksHeader) tracksHeader.style.display = 'none';
                if (tagsHeader)   tagsHeader.style.display   = '';
                if (tracksView)   tracksView.style.display   = 'none';
                if (tagsView)     tagsView.style.display     = 'flex';
                renderTagManagement();
            }
        });
    });
}

// ─────────────────────────────────────────────
// タグ管理ビュー
// ─────────────────────────────────────────────
function initTagManagement() {
    const addBtn = document.getElementById('add-global-tag-btn');
    if (addBtn) {
        addBtn.addEventListener('click', () => openTagCreateModal());
    }
}

function renderTagManagement() {
    const listEl  = document.getElementById('tag-mgmt-list');
    const emptyEl = document.getElementById('tag-mgmt-empty');
    if (!listEl) return;

    listEl.innerHTML = '';
    const ordered = appState.tagOrder.filter(t => appState.allKnownTags.has(t));
    const unknown = [...appState.allKnownTags.keys()].filter(t => !appState.tagOrder.includes(t));
    const allTags = [...ordered, ...unknown];

    if (allTags.length === 0) {
        if (emptyEl) emptyEl.style.display = '';
        return;
    }
    if (emptyEl) emptyEl.style.display = 'none';

    allTags.forEach((text, idx) => {
        const tagObj = appState.allKnownTags.get(text);
        if (!tagObj) return;
        const count = appState.tracks.filter(t => (t.tags || []).some(tag => (typeof tag === 'string' ? tag : tag.text) === text)).length;

        const li = document.createElement('li');
        li.className = 'tag-mgmt-item';

        const colorDot = document.createElement('div');
        colorDot.className = 'tag-mgmt-color-dot';
        colorDot.style.background = tagObj.color;

        const nameEl = document.createElement('div');
        nameEl.className = 'tag-mgmt-name';
        nameEl.textContent = text;

        const countEl = document.createElement('div');
        countEl.className = 'tag-mgmt-count';
        countEl.textContent = `${count}曲`;

        const actions = document.createElement('div');
        actions.className = 'tag-mgmt-actions';

        // 上へ
        const upBtn = document.createElement('button');
        upBtn.className = 'tag-mgmt-move-btn';
        upBtn.title = '優先度を上げる';
        upBtn.disabled = idx === 0;
        upBtn.innerHTML = '<span class="material-symbols-rounded">arrow_upward</span>';
        upBtn.addEventListener('click', () => {
            const pos = appState.tagOrder.indexOf(text);
            if (pos > 0) {
                [appState.tagOrder[pos - 1], appState.tagOrder[pos]] = [appState.tagOrder[pos], appState.tagOrder[pos - 1]];
                saveTagOrderToStorage();
                renderTagManagement();
                autoSync();
            }
        });

        // 下へ
        const downBtn = document.createElement('button');
        downBtn.className = 'tag-mgmt-move-btn';
        downBtn.title = '優先度を下げる';
        downBtn.disabled = idx === allTags.length - 1;
        downBtn.innerHTML = '<span class="material-symbols-rounded">arrow_downward</span>';
        downBtn.addEventListener('click', () => {
            const pos = appState.tagOrder.indexOf(text);
            if (pos < appState.tagOrder.length - 1) {
                [appState.tagOrder[pos], appState.tagOrder[pos + 1]] = [appState.tagOrder[pos + 1], appState.tagOrder[pos]];
                saveTagOrderToStorage();
                renderTagManagement();
                autoSync();
            }
        });

        // 編集
        const editBtn = document.createElement('button');
        editBtn.className = 'tag-mgmt-edit-btn';
        editBtn.title = 'タグを編集';
        editBtn.innerHTML = '<span class="material-symbols-rounded">edit</span>';
        editBtn.addEventListener('click', () => openTagEditGlobalModal(text, tagObj.color));

        // 削除
        const delBtn = document.createElement('button');
        delBtn.className = 'tag-mgmt-delete-btn';
        delBtn.title = 'タグを削除（全楽曲から除去）';
        delBtn.innerHTML = '<span class="material-symbols-rounded">delete</span>';
        delBtn.addEventListener('click', () => deleteGlobalTag(text));

        actions.appendChild(upBtn);
        actions.appendChild(downBtn);
        actions.appendChild(editBtn);
        actions.appendChild(delBtn);

        li.appendChild(colorDot);
        li.appendChild(nameEl);
        li.appendChild(countEl);
        li.appendChild(actions);
        listEl.appendChild(li);
    });
}

function openTagCreateModal() {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
        <div class="edit-modal-content" style="max-width:320px;">
            <div class="edit-modal-header">
                <h2 class="edit-modal-title">タグを追加</h2>
                <button class="icon-btn" id="tag-create-close"><span class="material-symbols-rounded">close</span></button>
            </div>
            <div style="padding:16px 24px;display:flex;flex-direction:column;gap:14px;">
                <div class="form-field">
                    <label class="form-label">タグ名</label>
                    <input type="text" id="new-tag-name" class="form-input" placeholder="タグ名を入力">
                </div>
                <div class="form-field">
                    <label class="form-label">色</label>
                    <input type="color" id="new-tag-color" value="#1a6ef5" style="width:100%;height:36px;border:1px solid var(--border);border-radius:8px;padding:2px 4px;cursor:pointer;">
                </div>
            </div>
            <div class="edit-modal-footer">
                <span></span>
                <div class="edit-modal-btns">
                    <button class="action-btn" id="tag-create-cancel">キャンセル</button>
                    <button class="action-btn primary" id="tag-create-save">追加</button>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
    modal.querySelector('#tag-create-close').addEventListener('click', () => modal.remove());
    modal.querySelector('#tag-create-cancel').addEventListener('click', () => modal.remove());
    modal.querySelector('#tag-create-save').addEventListener('click', () => {
        const text  = modal.querySelector('#new-tag-name').value.trim();
        const color = modal.querySelector('#new-tag-color').value;
        if (!text) { showToast('タグ名を入力してください', 'error'); return; }
        if (appState.allKnownTags.has(text)) { showToast('同名のタグが既に存在します', 'warning'); return; }
        appState.allKnownTags.set(text, { text, color });
        appState.tagOrder.push(text);
        saveTagOrderToStorage();
        updateTagsDatalist();
        renderTagManagement();
        modal.remove();
        showToast(`タグ「${text}」を追加しました`, 'success');
        autoSync();
    });
}

function openTagEditGlobalModal(text, currentColor) {
    const modal = document.createElement('div');
    modal.className    = 'modal-overlay';
    modal.style.zIndex = '600';
    modal.innerHTML = `
        <div class="edit-modal-content" style="max-width:320px;">
            <div class="edit-modal-header">
                <h2 class="edit-modal-title">タグを編集</h2>
                <button class="icon-btn" id="tag-edit-g-close"><span class="material-symbols-rounded">close</span></button>
            </div>
            <div style="padding:16px 24px;display:flex;flex-direction:column;gap:14px;">
                <div class="form-field">
                    <label class="form-label">タグ名</label>
                    <input type="text" id="tag-edit-g-name" class="form-input" value="${text}">
                </div>
                <div class="form-field">
                    <label class="form-label">色</label>
                    <input type="color" id="tag-edit-g-color" value="${currentColor}" style="width:100%;height:36px;border:1px solid var(--border);border-radius:8px;padding:2px 4px;cursor:pointer;">
                </div>
            </div>
            <div class="edit-modal-footer">
                <span></span>
                <div class="edit-modal-btns">
                    <button class="action-btn" id="tag-edit-g-cancel">キャンセル</button>
                    <button class="action-btn primary" id="tag-edit-g-save">保存</button>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
    modal.querySelector('#tag-edit-g-close').addEventListener('click', () => modal.remove());
    modal.querySelector('#tag-edit-g-cancel').addEventListener('click', () => modal.remove());
    modal.querySelector('#tag-edit-g-save').addEventListener('click', async () => {
        const newText  = modal.querySelector('#tag-edit-g-name').value.trim();
        const newColor = modal.querySelector('#tag-edit-g-color').value;
        if (!newText) { showToast('タグ名を入力してください', 'error'); return; }
        modal.remove();
        await renameGlobalTag(text, newText, newColor);
    });
}

async function renameGlobalTag(oldText, newText, newColor) {
    // allKnownTags 更新
    appState.allKnownTags.delete(oldText);
    appState.allKnownTags.set(newText, { text: newText, color: newColor });

    // tagOrder 更新
    const pos = appState.tagOrder.indexOf(oldText);
    if (pos >= 0) appState.tagOrder[pos] = newText;
    else appState.tagOrder.push(newText);
    saveTagOrderToStorage();

    // 全楽曲のタグを更新
    const allTracks = await getAllTracksFromDBRaw();
    for (const track of allTracks) {
        if (!track.tags) continue;
        let changed = false;
        track.tags = track.tags.map(t => {
            const tText = typeof t === 'string' ? t : t.text;
            if (tText === oldText) { changed = true; return { text: newText, color: newColor }; }
            return t;
        });
        if (changed) {
            track.updatedAt = Date.now();
            await saveTrackToDB(track);
        }
    }
    await loadLibrary();
    renderTagManagement();
    renderVirtualEditGrid();
    showToast(`タグ「${oldText}」→「${newText}」に更新しました`, 'success');
    autoSync();
}

async function deleteGlobalTag(text) {
    if (!confirm(`タグ「${text}」をすべての楽曲から削除しますか？`)) return;

    appState.allKnownTags.delete(text);
    appState.tagOrder = appState.tagOrder.filter(t => t !== text);
    saveTagOrderToStorage();

    const allTracks = await getAllTracksFromDBRaw();
    for (const track of allTracks) {
        if (!track.tags) continue;
        const before = track.tags.length;
        track.tags = track.tags.filter(t => (typeof t === 'string' ? t : t.text) !== text);
        if (track.tags.length !== before) {
            track.updatedAt = Date.now();
            await saveTrackToDB(track);
        }
    }
    await loadLibrary();
    renderTagManagement();
    renderVirtualEditGrid();
    showToast(`タグ「${text}」を削除しました`, 'success');
    autoSync();
}

// ─────────────────────────────────────────────
// 編集ページ（仮想スクロールグリッド）
// ─────────────────────────────────────────────
function getEditGridCols() {
    return window.matchMedia('(max-width: 768px)').matches ? 2 : 4;
}

function calcEditGridRowH(containerW, cols) {
    const padH  = window.matchMedia('(max-width: 768px)').matches ? 28 : 48;
    const gapH  = EDIT_GRID_GAP * (cols - 1);
    const cardW = Math.max(80, (containerW - padH - gapH) / cols);
    return Math.ceil(cardW + 78);
}

function renderVirtualEditGrid() {
    if (appState.currentEditTab !== 'tracks') return;
    const outer    = document.getElementById('edit-list-outer');
    const inner    = document.getElementById('edit-list-inner');
    const rendered = document.getElementById('edit-library-list');
    if (!outer || !inner || !rendered) return;

    const displayTracks = getEditDisplayTracks();
    const emptyEl = document.getElementById('edit-empty');
    if (emptyEl) emptyEl.classList.toggle('show', displayTracks.length === 0);

    if (displayTracks.length === 0) {
        inner.style.height = '0px';
        rendered.innerHTML = '';
        if (appState.editIsSelectMode) rendered.classList.add('edit-select-mode');
        else rendered.classList.remove('edit-select-mode');
        return;
    }

    const cols      = getEditGridCols();
    const rowH      = calcEditGridRowH(outer.clientWidth || 400, cols);
    const rowCount  = Math.ceil(displayTracks.length / cols);
    const totalH    = EDIT_SCROLL_TOP_PAD + rowCount * rowH + Math.max(0, rowCount - 1) * EDIT_ROW_GAP + 16;

    inner.style.height = totalH + 'px';

    const scrollTop  = outer.scrollTop;
    const containerH = outer.clientHeight || 400;

    const rowUnit  = rowH + EDIT_ROW_GAP;
    const startRow = Math.max(0, Math.floor((scrollTop - EDIT_SCROLL_TOP_PAD) / rowUnit) - 2);
    const endRow   = Math.min(rowCount - 1, Math.ceil((scrollTop + containerH - EDIT_SCROLL_TOP_PAD) / rowUnit) + 2);

    const topOffset = EDIT_SCROLL_TOP_PAD + startRow * rowUnit;
    rendered.style.top = topOffset + 'px';
    rendered.innerHTML = '';

    if (appState.editIsSelectMode) rendered.classList.add('edit-select-mode');
    else rendered.classList.remove('edit-select-mode');

    for (let row = startRow; row <= endRow; row++) {
        const rowDiv = document.createElement('div');
        rowDiv.className    = 'edit-grid-row';
        rowDiv.style.height = rowH + 'px';
        for (let col = 0; col < cols; col++) {
            const idx = row * cols + col;
            if (idx >= displayTracks.length) break;
            rowDiv.appendChild(buildEditCard(displayTracks[idx]));
        }
        rendered.appendChild(rowDiv);
    }
}

function buildEditCard(track) {
    const card = document.createElement('div');
    card.className = 'edit-track-card' + (appState.editSelectedTracks.has(track.id) ? ' selected' : '');

    const checkMark = document.createElement('div');
    checkMark.className = 'edit-card-check';
    checkMark.innerHTML = '<span class="material-symbols-rounded">check</span>';

    const art = document.createElement('div');
    art.className = 'edit-card-art';
    const cachedThumb = thumbCache.get(track.id);
    if (cachedThumb) {
        art.style.backgroundImage = `url(${cachedThumb})`;
        art.style.backgroundSize  = 'cover';
    } else {
        art.innerHTML = '<span class="material-symbols-rounded">music_note</span>';
        loadThumbForElement(track.id, art);
    }

    // タグ表示（編集カードはテキストタグ）
    let tagsHtml = '';
    if (track.tags && track.tags.length > 0) {
        const sortedTags = sortTagsByOrder(track.tags);
        tagsHtml = '<div class="edit-card-tags">' +
            sortedTags.slice(0, 3).map(t => {
                const tObj = typeof t === 'string' ? { text: t, color: '#ccc' } : t;
                return `<span class="track-list-tag" style="border:1px solid ${tObj.color};background:${tObj.color}22;">${tObj.text}</span>`;
            }).join('') + '</div>';
    }

    card.innerHTML = `
        <div class="edit-card-title">${track.title}</div>
        <div class="edit-card-artist">${track.artist || '-'}</div>
        ${tagsHtml}
    `;
    card.insertBefore(art, card.firstChild);
    card.insertBefore(checkMark, card.firstChild);

    card.addEventListener('click', () => {
        if (appState.editIsSelectMode) {
            if (appState.editSelectedTracks.has(track.id)) {
                appState.editSelectedTracks.delete(track.id);
                card.classList.remove('selected');
            } else {
                appState.editSelectedTracks.add(track.id);
                card.classList.add('selected');
            }
            updateEditBulkBar();
        } else {
            openEditModal([track.id]);
        }
    });
    return card;
}

function getEditDisplayTracks() {
    let displayTracks = [...appState.tracks];
    if (appState.searchQueryEdit) {
        displayTracks = displayTracks.filter(t =>
            t.title.toLowerCase().includes(appState.searchQueryEdit) ||
            (t.artist || '').toLowerCase().includes(appState.searchQueryEdit)
        );
    }
    if (appState.editSortMode !== 'manual') {
        displayTracks.sort((a, b) => {
            switch (appState.editSortMode) {
                case 'date_desc':    return b.addedAt - a.addedAt;
                case 'date_asc':     return a.addedAt - b.addedAt;
                case 'name_asc':     return a.title.localeCompare(b.title, 'ja');
                case 'name_desc':    return b.title.localeCompare(a.title, 'ja');
                case 'artist_asc':   return (a.artist||'').localeCompare(b.artist||'', 'ja');
                case 'artist_desc':  return (b.artist||'').localeCompare(a.artist||'', 'ja');
                case 'release_desc': return (b.date||'').localeCompare(a.date||'');
                case 'release_asc':  return (a.date||'').localeCompare(b.date||'');
                default: return 0;
            }
        });
    }
    return displayTracks;
}

// ─────────────────────────────────────────────
// プレイヤーコントロール
// ─────────────────────────────────────────────
function initPlayerControls() {
    const playBtn    = document.getElementById('ctrl-play');
    const prevBtn    = document.getElementById('ctrl-prev');
    const nextBtn    = document.getElementById('ctrl-next');
    const seekBar    = document.getElementById('seek-bar');
    const volumeBar  = document.getElementById('volume-bar');
    const loopBtn    = document.getElementById('ctrl-loop');
    const speedBtn   = document.getElementById('ctrl-speed');
    const shuffleBtn = document.getElementById('ctrl-shuffle');
    const muteBtn    = document.getElementById('ctrl-mute');

    if (playBtn)    playBtn.addEventListener('click', togglePlay);
    if (nextBtn)    nextBtn.addEventListener('click', playNext);
    if (prevBtn)    prevBtn.addEventListener('click', playPrev);
    if (loopBtn)    loopBtn.addEventListener('click', cycleLoopMode);
    if (speedBtn)   speedBtn.addEventListener('click', cycleSpeed);
    if (shuffleBtn) shuffleBtn.addEventListener('click', toggleShuffle);
    if (muteBtn)    muteBtn.addEventListener('click', () => {
        audioPlayer.muted = !audioPlayer.muted;
        const icon = muteBtn.querySelector('.material-symbols-rounded');
        if (icon) icon.textContent = audioPlayer.muted ? 'volume_off' : 'volume_up';
    });

    if (seekBar) seekBar.addEventListener('input', (e) => {
        if (audioPlayer.duration) audioPlayer.currentTime = (e.target.value / 100) * audioPlayer.duration;
    });

    if (volumeBar) {
        volumeBar.addEventListener('input', (e) => {
            audioPlayer.volume = e.target.value / 100;
            const fpVol = document.getElementById('fp-volume-bar');
            if (fpVol) fpVol.value = e.target.value;
            updateVolumeIcon(e.target.value);
        });
        audioPlayer.volume = volumeBar.value / 100;
    }

    audioPlayer.addEventListener('timeupdate', () => {
        if (!audioPlayer.duration) return;
        const pct = (audioPlayer.currentTime / audioPlayer.duration) * 100;

        if (seekBar) {
            seekBar.value = pct;
            seekBar.style.background = `linear-gradient(to right, var(--accent) ${pct}%, var(--border) ${pct}%)`;
        }
        const fpSeek = document.getElementById('fp-seek-bar');
        if (fpSeek) {
            fpSeek.value = pct;
            fpSeek.style.background = `linear-gradient(to right, var(--accent) ${pct}%, var(--border) ${pct}%)`;
        }

        const cur = formatTime(audioPlayer.currentTime);
        const tot = formatTime(audioPlayer.duration);
        const tcEl = document.getElementById('time-current');
        const ttEl = document.getElementById('time-total');
        if (tcEl) tcEl.textContent = cur;
        if (ttEl) ttEl.textContent = tot;
        const fpCur = document.getElementById('fp-time-current');
        const fpTot = document.getElementById('fp-time-total');
        if (fpCur) fpCur.textContent = cur;
        if (fpTot) fpTot.textContent = tot;

        const miniBar = document.getElementById('mini-progress-bar');
        if (miniBar) miniBar.style.width = `${pct}%`;
    });

    audioPlayer.addEventListener('ended', () => { handleTrackEnd(); });
}

// ─────────────────────────────────────────────
// iOS バックグラウンド再生チェッカー
// ─────────────────────────────────────────────
function startBgEndChecker() {
    stopBgEndChecker();
    bgEndChecker = setInterval(() => {
        if (!appState.isPlaying || !audioPlayer.duration) return;
        if (audioPlayer.paused &&
            audioPlayer.currentTime > 0 &&
            audioPlayer.currentTime >= audioPlayer.duration - 0.3) {
            handleTrackEnd();
        }
    }, 1000);
}

function stopBgEndChecker() {
    if (bgEndChecker) { clearInterval(bgEndChecker); bgEndChecker = null; }
}

function handleTrackEnd() {
    if (isHandlingTrackEnd) return;
    isHandlingTrackEnd = true;
    stopBgEndChecker();
    stopPlaybackTracking();

    setTimeout(() => {
        try {
            if (appState.loopMode === 'one') {
                audioPlayer.currentTime = 0;
                audioPlayer.play().then(() => {
                    appState.isPlaying = true;
                    updatePlayButtonUI();
                    startPlaybackTracking();
                    startBgEndChecker();
                }).catch(console.error)
                .finally(() => { isHandlingTrackEnd = false; });
                return;
            }
            if (appState.loopMode === 'all') {
                isHandlingTrackEnd = false; playNext(); return;
            }
            const hasNext = appState.isShuffled
                ? (appState.shufflePos < appState.shuffleOrder.length - 1)
                : (appState.currentTrackIndex < appState.currentQueue.length - 1);
            if (hasNext) { isHandlingTrackEnd = false; playNext(); }
            else { appState.isPlaying = false; updatePlayButtonUI(); isHandlingTrackEnd = false; }
        } catch (e) { console.error('handleTrackEnd エラー:', e); isHandlingTrackEnd = false; }
    }, 50);
}

// ─────────────────────────────────────────────
// 再生 / 停止 / 曲切り替え
// ─────────────────────────────────────────────
async function playTrack(index) {
    if (index < 0 || index >= appState.currentQueue.length) return;
    isHandlingTrackEnd = false;
    stopBgEndChecker();
    stopPlaybackTracking();
    const track = appState.currentQueue[index];
    appState.currentTrackIndex = index;

    if (currentObjectUrl) { URL.revokeObjectURL(currentObjectUrl); currentObjectUrl = null; }

    if (appState.isStreaming && track.driveFileId && gapiAccessToken) {
        audioPlayer.src = `https://www.googleapis.com/drive/v3/files/${track.driveFileId}?alt=media&access_token=${gapiAccessToken}`;
    } else {
        // blobsストアから取得
        const blob = await getBlobFromDB(track.id);
        if (blob) {
            currentObjectUrl = URL.createObjectURL(blob);
            audioPlayer.src  = currentObjectUrl;
        } else {
            showToast('音声ファイルが見つかりません', 'error');
            return;
        }
    }

    audioPlayer.playbackRate = SPEED_OPTIONS[currentSpeedIndex];
    audioPlayer.play().then(() => {
        appState.isPlaying = true;
        if (appState.isShuffled && appState.shuffleOrder.length > 0) {
            const pos = appState.shuffleOrder.indexOf(index);
            if (pos >= 0) appState.shufflePos = pos;
        }
        updatePlayerUI(track);
        renderVirtualTrackList();
        if (appState.isQueueOpen) renderQueuePanel();
        startPlaybackTracking();
        startBgEndChecker();
    }).catch(e => console.error('再生エラー:', e));
}

function togglePlay() {
    if (appState.currentQueue.length === 0) return;
    if (appState.isPlaying) {
        audioPlayer.pause();
        appState.isPlaying = false;
        stopPlaybackTracking();
        stopBgEndChecker();
    } else {
        if (audioPlayer.src) {
            audioPlayer.play().then(() => {
                appState.isPlaying = true;
                startPlaybackTracking();
                startBgEndChecker();
            });
        } else {
            playTrack(0);
        }
    }
    updatePlayButtonUI();
    renderVirtualTrackList();
}

function playNext() {
    if (appState.currentQueue.length === 0) return;
    let nextIndex;
    if (appState.isShuffled && appState.shuffleOrder.length > 0) {
        appState.shufflePos = (appState.shufflePos + 1) % appState.shuffleOrder.length;
        nextIndex = appState.shuffleOrder[appState.shufflePos];
    } else {
        nextIndex = appState.currentTrackIndex + 1;
        if (nextIndex >= appState.currentQueue.length) nextIndex = 0;
    }
    playTrack(nextIndex);
}

function playPrev() {
    if (appState.currentQueue.length === 0) return;
    if (audioPlayer.currentTime > 3) { audioPlayer.currentTime = 0; return; }
    let prevIndex;
    if (appState.isShuffled && appState.shuffleOrder.length > 0) {
        appState.shufflePos = (appState.shufflePos - 1 + appState.shuffleOrder.length) % appState.shuffleOrder.length;
        prevIndex = appState.shuffleOrder[appState.shufflePos];
    } else {
        prevIndex = appState.currentTrackIndex - 1;
        if (prevIndex < 0) prevIndex = appState.currentQueue.length - 1;
    }
    playTrack(prevIndex);
}

function updatePlayerUI(track) {
    const npTitle  = document.getElementById('np-title');
    const npArtist = document.getElementById('np-artist');
    if (npTitle)  npTitle.textContent  = track.title;
    if (npArtist) npArtist.textContent = track.artist || '-';

    const artworkImage = document.getElementById('artwork-image');
    const artworkBg    = document.getElementById('artwork-bg');
    if (artworkImage) {
        const cached = thumbCache.get(track.id);
        if (cached) {
            artworkImage.style.backgroundImage = `url(${cached})`;
            artworkImage.innerHTML = '';
            artworkImage.classList.add('has-art');
            if (artworkBg) artworkBg.classList.add('visible');
        } else {
            artworkImage.style.backgroundImage = 'none';
            artworkImage.innerHTML = '<span class="material-symbols-rounded">music_note</span>';
            artworkImage.classList.remove('has-art');
            if (artworkBg) artworkBg.classList.remove('visible');
            // 非同期更新
            loadThumbFromDB(track.id).then(dataUrl => {
                if (dataUrl && artworkImage.isConnected) {
                    artworkImage.style.backgroundImage = `url(${dataUrl})`;
                    artworkImage.innerHTML = '';
                    artworkImage.classList.add('has-art');
                    if (artworkBg) artworkBg.classList.add('visible');
                }
            });
        }
    }

    updateMiniPlayer(track);
    updateFullscreenPlayer(track);
    updatePlayButtonUI();

    if ('mediaSession' in navigator) {
        const cached = thumbCache.get(track.id);
        navigator.mediaSession.metadata = new MediaMetadata({
            title:   track.title,
            artist:  track.artist || '',
            artwork: cached ? [{ src: cached }] : []
        });
        navigator.mediaSession.playbackState = 'playing';
        navigator.mediaSession.setActionHandler('play',          togglePlay);
        navigator.mediaSession.setActionHandler('pause',         togglePlay);
        navigator.mediaSession.setActionHandler('previoustrack', playPrev);
        navigator.mediaSession.setActionHandler('nexttrack',     playNext);
        navigator.mediaSession.setActionHandler('seekto', (details) => {
            if (details.seekTime !== undefined && audioPlayer.duration) {
                audioPlayer.currentTime = details.seekTime;
            }
        });
    }
}

function updatePlayButtonUI() {
    const icon = appState.isPlaying ? 'pause' : 'play_arrow';
    [document.getElementById('ctrl-play'), document.getElementById('fp-play')].forEach(btn => {
        if (btn) btn.querySelector('.material-symbols-rounded').textContent = icon;
    });
    updateMiniPlayButton();
    if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = appState.isPlaying ? 'playing' : 'paused';
    }
}

// ─────────────────────────────────────────────
// 検索・ソート初期化
// ─────────────────────────────────────────────
function initSearchAndSort() {
    const mainSearch = document.getElementById('main-search-input');
    if (mainSearch) mainSearch.addEventListener('input', (e) => {
        appState.searchQueryMain = e.target.value.toLowerCase();
        updateMainQueue();
    });

    const sortSelect = document.getElementById('main-sort-select');
    if (sortSelect) sortSelect.addEventListener('change', (e) => {
        appState.sortModeMain = e.target.value;
        if (appState.isShuffled) {
            appState.isShuffled = false;
            [document.getElementById('ctrl-shuffle'), document.getElementById('fp-shuffle')].forEach(b => {
                if (b) b.classList.remove('active');
            });
        }
        updateMainQueue();
    });

    const editSearch = document.getElementById('edit-search-input');
    if (editSearch) editSearch.addEventListener('input', (e) => {
        appState.searchQueryEdit = e.target.value.toLowerCase();
        renderVirtualEditGrid();
    });

    const editSortSelect = document.getElementById('edit-sort-select');
    if (editSortSelect) editSortSelect.addEventListener('change', (e) => {
        appState.editSortMode = e.target.value;
        renderVirtualEditGrid();
    });
}

// ─────────────────────────────────────────────
// 選択モード（プレイヤーページ）
// ─────────────────────────────────────────────
function initSelectMode() {
    const toggleBtn    = document.getElementById('btn-select-mode');
    const selectAllBtn = document.getElementById('btn-select-all');

    if (toggleBtn) {
        toggleBtn.addEventListener('click', () => {
            appState.isSelectMode = !appState.isSelectMode;
            toggleBtn.classList.toggle('active', appState.isSelectMode);
            if (selectAllBtn) selectAllBtn.style.display = appState.isSelectMode ? 'inline-flex' : 'none';
            if (!appState.isSelectMode) { appState.selectedMainTracks.clear(); updateBulkActionBar(); }
            renderVirtualTrackList();
        });
    }
    if (selectAllBtn) {
        selectAllBtn.addEventListener('click', () => {
            if (appState.selectedMainTracks.size === appState.currentQueue.length && appState.currentQueue.length > 0) {
                appState.selectedMainTracks.clear();
            } else {
                appState.currentQueue.forEach(t => appState.selectedMainTracks.add(t.id));
            }
            updateBulkActionBar();
            renderVirtualTrackList();
        });
    }
}

function exitSelectMode() {
    appState.isSelectMode = false;
    appState.selectedMainTracks.clear();
    const toggleBtn    = document.getElementById('btn-select-mode');
    const selectAllBtn = document.getElementById('btn-select-all');
    if (toggleBtn)    toggleBtn.classList.remove('active');
    if (selectAllBtn) selectAllBtn.style.display = 'none';
    updateBulkActionBar();
}

// ─────────────────────────────────────────────
// 選択モード（編集ページ）
// ─────────────────────────────────────────────
function initEditSelectMode() {
    const toggleBtn    = document.getElementById('edit-select-mode-btn');
    const selectAllBtn = document.getElementById('edit-select-all-btn');
    const bulkEditBtn  = document.getElementById('edit-bulk-edit-btn');
    const bulkDelBtn   = document.getElementById('edit-bulk-delete-btn');

    if (toggleBtn) {
        toggleBtn.addEventListener('click', () => {
            appState.editIsSelectMode = !appState.editIsSelectMode;
            toggleBtn.classList.toggle('active', appState.editIsSelectMode);
            if (selectAllBtn) selectAllBtn.style.display = appState.editIsSelectMode ? 'inline-flex' : 'none';
            if (!appState.editIsSelectMode) { appState.editSelectedTracks.clear(); updateEditBulkBar(); }
            renderVirtualEditGrid();
        });
    }
    if (selectAllBtn) {
        selectAllBtn.addEventListener('click', () => {
            const displayTracks = getEditDisplayTracks();
            if (appState.editSelectedTracks.size === displayTracks.length && displayTracks.length > 0) {
                appState.editSelectedTracks.clear();
            } else {
                displayTracks.forEach(t => appState.editSelectedTracks.add(t.id));
            }
            updateEditBulkBar();
            renderVirtualEditGrid();
        });
    }
    if (bulkEditBtn) bulkEditBtn.addEventListener('click', () => {
        if (appState.editSelectedTracks.size === 0) return;
        openEditModal(Array.from(appState.editSelectedTracks));
    });
    if (bulkDelBtn) bulkDelBtn.addEventListener('click', () => {
        if (appState.editSelectedTracks.size === 0) return;
        deleteTracksCompletely(Array.from(appState.editSelectedTracks)).then(() => {
            appState.editSelectedTracks.clear(); updateEditBulkBar();
        });
    });
}

function exitEditSelectMode() {
    appState.editIsSelectMode = false;
    appState.editSelectedTracks.clear();
    const toggleBtn    = document.getElementById('edit-select-mode-btn');
    const selectAllBtn = document.getElementById('edit-select-all-btn');
    if (toggleBtn)    toggleBtn.classList.remove('active');
    if (selectAllBtn) selectAllBtn.style.display = 'none';
    const grid = document.getElementById('edit-library-list');
    if (grid) grid.classList.remove('edit-select-mode');
    updateEditBulkBar();
}

function updateEditBulkBar() {
    const bar       = document.getElementById('edit-bulk-actions-bar');
    const countSpan = document.getElementById('edit-bulk-count');
    const count     = appState.editSelectedTracks.size;
    if (bar)       bar.classList.toggle('visible', count > 0 && appState.editIsSelectMode);
    if (countSpan) countSpan.textContent = `${count}曲を選択中`;
}

// ─────────────────────────────────────────────
// キュー更新
// ─────────────────────────────────────────────
function updateMainQueue() {
    let baseList = [];
    if (!appState.currentPlaylistId) {
        baseList = [...appState.tracks];
    } else {
        const pl = appState.playlists.find(p => p.id === appState.currentPlaylistId);
        if (pl) baseList = pl.trackIds.map(id => appState.tracks.find(t => t.id === id)).filter(Boolean);
    }

    if (appState.searchQueryMain) {
        baseList = baseList.filter(t => {
            const q = appState.searchQueryMain;
            return t.title.toLowerCase().includes(q) ||
                (t.artist || '').toLowerCase().includes(q) ||
                (t.tags || []).some(tag => (typeof tag === 'string' ? tag : tag.text).toLowerCase().includes(q));
        });
    }

    if (appState.sortModeMain !== 'manual') {
        baseList.sort((a, b) => {
            switch (appState.sortModeMain) {
                case 'date_desc':    return b.addedAt - a.addedAt;
                case 'date_asc':     return a.addedAt - b.addedAt;
                case 'name_asc':     return a.title.localeCompare(b.title, 'ja');
                case 'name_desc':    return b.title.localeCompare(a.title, 'ja');
                case 'artist_asc':   return (a.artist||'').localeCompare(b.artist||'', 'ja');
                case 'artist_desc':  return (b.artist||'').localeCompare(a.artist||'', 'ja');
                case 'release_desc': return (b.date||'').localeCompare(a.date||'');
                case 'release_asc':  return (a.date||'').localeCompare(b.date||'');
                default: return 0;
            }
        });
    }

    appState.currentQueue = baseList;
    if (appState.isShuffled) buildShuffleOrder();

    const dropZone = document.getElementById('drop-zone');
    if (dropZone) {
        if (appState.tracks.length === 0 && !appState.searchQueryMain) dropZone.classList.add('show');
        else dropZone.classList.remove('show');
    }

    renderVirtualTrackList();
    if (appState.isQueueOpen) renderQueuePanel();
}

// ─────────────────────────────────────────────
// 仮想スクロール：スクロールイベント登録
// ─────────────────────────────────────────────
function initVirtualScrollListeners() {
    const trackOuter = document.getElementById('track-list-outer');
    if (trackOuter) {
        trackOuter.addEventListener('scroll', () => renderVirtualTrackList(), { passive: true });
    }
    const editOuter = document.getElementById('edit-list-outer');
    if (editOuter) {
        editOuter.addEventListener('scroll', () => renderVirtualEditGrid(), { passive: true });
    }
    const ro = new ResizeObserver(() => {
        renderVirtualTrackList();
        renderVirtualEditGrid();
    });
    if (trackOuter) ro.observe(trackOuter);
    if (editOuter)  ro.observe(editOuter);
}

// ─────────────────────────────────────────────
// 仮想スクロール：曲リスト（1列）
// ─────────────────────────────────────────────
function renderVirtualTrackList() {
    const outer    = document.getElementById('track-list-outer');
    const inner    = document.getElementById('track-list-inner');
    const rendered = document.getElementById('track-list-rendered');
    if (!outer || !inner || !rendered) return;

    const items  = appState.currentQueue;
    const totalH = items.length * TRACK_ITEM_H;
    inner.style.height = totalH + 'px';

    if (items.length === 0) { rendered.innerHTML = ''; return; }

    const scrollTop  = outer.scrollTop;
    const containerH = outer.clientHeight || 400;

    const startIdx = Math.max(0, Math.floor(scrollTop / TRACK_ITEM_H) - VSCROLL_BUFFER);
    const endIdx   = Math.min(items.length - 1, Math.ceil((scrollTop + containerH) / TRACK_ITEM_H) + VSCROLL_BUFFER);

    rendered.style.top = (startIdx * TRACK_ITEM_H) + 'px';
    rendered.innerHTML = '';

    for (let i = startIdx; i <= endIdx; i++) {
        rendered.appendChild(buildTrackListItem(items[i], i));
    }
}

/**
 * トラックリストアイテムを構築
 * ─ タグ表示：色ドットのみ（テキスト非表示）
 */
function buildTrackListItem(track, index) {
    const li = document.createElement('li');
    li.className = 'track-list-item';
    li.style.height = TRACK_ITEM_H + 'px';

    if (appState.currentTrackIndex === index) li.classList.add(appState.isPlaying ? 'playing' : 'paused');
    if (appState.selectedMainTracks.has(track.id)) li.classList.add('selected');

    // 選択インジケーター
    const selectIndicator = document.createElement('div');
    selectIndicator.className = 'track-select-indicator';
    selectIndicator.innerHTML = '<span class="material-symbols-rounded">check</span>';
    if (!appState.isSelectMode) selectIndicator.style.display = 'none';

    // サムネイル（遅延ロード）
    const thumb = document.createElement('div');
    thumb.className = 'track-thumb';
    const cachedThumb = thumbCache.get(track.id);
    if (cachedThumb) {
        thumb.style.backgroundImage = `url(${cachedThumb})`;
        thumb.style.backgroundSize  = 'cover';
    } else {
        thumb.innerHTML = '<span class="material-symbols-rounded">music_note</span>';
        loadThumbForElement(track.id, thumb);
    }
    const playingInd = document.createElement('div');
    playingInd.className = 'playing-indicator';
    playingInd.innerHTML = '<div class="playing-bars"><span></span><span></span><span></span></div>';
    thumb.appendChild(playingInd);

    // 曲情報
    const info = document.createElement('div');
    info.className = 'track-list-info';

    const titleEl = document.createElement('div');
    titleEl.className   = 'track-list-title';
    titleEl.textContent = track.title;
    const subEl = document.createElement('div');
    subEl.className   = 'track-list-sub';
    subEl.textContent = track.artist || '-';

    info.appendChild(titleEl);
    info.appendChild(subEl);

    // タグは色ドットのみ表示
    if (track.tags && track.tags.length > 0) {
        const sortedTags = sortTagsByOrder(track.tags);
        const dotRow = document.createElement('div');
        dotRow.className = 'track-tag-dots';
        sortedTags.forEach(t => {
            const tObj  = typeof t === 'string' ? { text: t, color: getTagColorHex(t) } : t;
            const dot   = document.createElement('span');
            dot.className = 'track-tag-dot';
            dot.style.background = tObj.color;
            dot.title = tObj.text;
            dotRow.appendChild(dot);
        });
        info.appendChild(dotRow);
    }

    // アクションボタン
    const actions = document.createElement('div');
    actions.className = 'track-actions';

    // 上下移動ボタン（手動順かつ選択モードOFF時のみ）
    if (appState.sortModeMain === 'manual' && !appState.isSelectMode) {
        const upBtn = document.createElement('button');
        upBtn.className = 'track-move-btn'; upBtn.title = '上に移動';
        upBtn.disabled  = (index === 0);
        upBtn.innerHTML = '<span class="material-symbols-rounded">arrow_upward</span>';
        upBtn.addEventListener('click', (e) => { e.stopPropagation(); moveTrackInQueue(index, index - 1); });

        const downBtn = document.createElement('button');
        downBtn.className = 'track-move-btn'; downBtn.title = '下に移動';
        downBtn.disabled  = (index === appState.currentQueue.length - 1);
        downBtn.innerHTML = '<span class="material-symbols-rounded">arrow_downward</span>';
        downBtn.addEventListener('click', (e) => { e.stopPropagation(); moveTrackInQueue(index, index + 1); });

        actions.appendChild(upBtn);
        actions.appendChild(downBtn);
    }

    const addBtn = document.createElement('button');
    addBtn.className = 'icon-btn sm'; addBtn.title = 'プレイリストに追加';
    addBtn.innerHTML = '<span class="material-symbols-rounded">playlist_add</span>';
    addBtn.addEventListener('click', (e) => { e.stopPropagation(); openAddToPlaylistModal([track.id]); });

    const editBtn = document.createElement('button');
    editBtn.className = 'icon-btn sm'; editBtn.title = '情報を編集';
    editBtn.innerHTML = '<span class="material-symbols-rounded">edit</span>';
    editBtn.addEventListener('click', (e) => { e.stopPropagation(); openEditModal([track.id]); });

    actions.appendChild(addBtn);
    actions.appendChild(editBtn);

    if (appState.currentPlaylistId) {
        const removeBtn = document.createElement('button');
        removeBtn.className = 'icon-btn sm'; removeBtn.title = 'このリストから外す';
        removeBtn.innerHTML = '<span class="material-symbols-rounded">playlist_remove</span>';
        removeBtn.addEventListener('click', (e) => { e.stopPropagation(); removeTracksFromPlaylist(appState.currentPlaylistId, [track.id]); });
        actions.appendChild(removeBtn);
    }

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'icon-btn sm'; deleteBtn.title = '完全削除';
    deleteBtn.innerHTML = '<span class="material-symbols-rounded" style="color:var(--danger)">delete_forever</span>';
    deleteBtn.addEventListener('click', (e) => { e.stopPropagation(); deleteTracksCompletely([track.id]); });
    actions.appendChild(deleteBtn);

    li.addEventListener('click', (e) => {
        if (e.target.closest('.track-actions')) return;
        if (appState.isSelectMode) {
            if (appState.selectedMainTracks.has(track.id)) {
                appState.selectedMainTracks.delete(track.id); li.classList.remove('selected');
            } else {
                appState.selectedMainTracks.add(track.id); li.classList.add('selected');
            }
            updateBulkActionBar();
        } else {
            playTrack(index);
        }
    });

    li.appendChild(selectIndicator);
    li.appendChild(thumb);
    li.appendChild(info);
    li.appendChild(actions);
    return li;
}

function moveTrackInQueue(fromIdx, toIdx) {
    if (toIdx < 0 || toIdx >= appState.currentQueue.length) return;
    if (appState.sortModeMain !== 'manual') return;
    const item = appState.currentQueue.splice(fromIdx, 1)[0];
    appState.currentQueue.splice(toIdx, 0, item);
    if (appState.currentTrackIndex === fromIdx) {
        appState.currentTrackIndex = toIdx;
    } else if (fromIdx < toIdx && appState.currentTrackIndex > fromIdx && appState.currentTrackIndex <= toIdx) {
        appState.currentTrackIndex--;
    } else if (fromIdx > toIdx && appState.currentTrackIndex >= toIdx && appState.currentTrackIndex < fromIdx) {
        appState.currentTrackIndex++;
    }
    if (appState.isShuffled) buildShuffleOrder();
    saveManualOrder();
    renderVirtualTrackList();
}

function updateBulkActionBar() {
    const bar       = document.getElementById('bulk-actions-bar');
    const countSpan = document.getElementById('bulk-count');
    const count     = appState.selectedMainTracks.size;
    if (bar)       bar.classList.toggle('visible', count > 0);
    if (countSpan) countSpan.textContent = `${count}曲を選択中`;
    const btnRemove = document.getElementById('bulk-remove-playlist-btn');
    if (btnRemove) btnRemove.style.display = appState.currentPlaylistId ? 'inline-flex' : 'none';
}

function initBulkActions() {
    const bulkAddBtn    = document.getElementById('bulk-add-playlist-btn');
    const bulkEditBtn   = document.getElementById('bulk-edit-btn');
    const bulkRemoveBtn = document.getElementById('bulk-remove-playlist-btn');
    const bulkDeleteBtn = document.getElementById('bulk-delete-btn');

    if (bulkAddBtn)    bulkAddBtn.addEventListener('click', () => openAddToPlaylistModal(Array.from(appState.selectedMainTracks)));
    if (bulkEditBtn)   bulkEditBtn.addEventListener('click', () => openEditModal(Array.from(appState.selectedMainTracks)));
    if (bulkRemoveBtn) bulkRemoveBtn.addEventListener('click', () => {
        if (appState.currentPlaylistId) removeTracksFromPlaylist(appState.currentPlaylistId, Array.from(appState.selectedMainTracks));
    });
    if (bulkDeleteBtn) bulkDeleteBtn.addEventListener('click', () => deleteTracksCompletely(Array.from(appState.selectedMainTracks)));
}

// ─────────────────────────────────────────────
// 編集モーダル
// ─────────────────────────────────────────────
let editingTags         = [];
let currentEditTrackIds = [];

function initEditPage() {
    const modal              = document.getElementById('edit-modal');
    const closeBtn           = document.getElementById('close-edit-modal');
    const cancelBtn          = document.getElementById('close-edit-modal-cancel');
    const saveBtn            = document.getElementById('save-metadata-btn');
    const thumbnailBtn       = document.getElementById('edit-thumbnail-btn');
    const thumbnailInput     = document.getElementById('edit-thumbnail-input');
    const thumbnailRemoveBtn = document.getElementById('edit-thumbnail-remove-btn');
    const thumbnailPreview   = document.getElementById('edit-thumbnail-preview');
    const tagInput           = document.getElementById('edit-tags-input');

    if (closeBtn)  closeBtn.addEventListener('click',  closeEditModal);
    if (cancelBtn) cancelBtn.addEventListener('click', closeEditModal);
    if (modal)     modal.addEventListener('click', (e) => { if (e.target === modal) closeEditModal(); });

    if (thumbnailBtn)     thumbnailBtn.addEventListener('click', () => thumbnailInput && thumbnailInput.click());
    if (thumbnailPreview) thumbnailPreview.addEventListener('click', () => thumbnailInput && thumbnailInput.click());

    if (thumbnailPreview) {
        thumbnailPreview.addEventListener('dragover',  (e) => { e.preventDefault(); thumbnailPreview.style.borderColor = 'var(--accent)'; });
        thumbnailPreview.addEventListener('dragleave', () => thumbnailPreview.style.borderColor = '');
        thumbnailPreview.addEventListener('drop', (e) => {
            e.preventDefault(); thumbnailPreview.style.borderColor = '';
            const file = e.dataTransfer.files[0];
            if (file && file.type.startsWith('image/')) loadThumbnailFromFile(file);
        });
    }

    if (thumbnailInput) thumbnailInput.addEventListener('change', (e) => {
        if (e.target.files[0]) loadThumbnailFromFile(e.target.files[0]);
    });

    if (thumbnailRemoveBtn) thumbnailRemoveBtn.addEventListener('click', () => {
        const preview = document.getElementById('edit-thumbnail-preview');
        if (preview) {
            preview.style.backgroundImage = 'none';
            preview.innerHTML = '<span class="material-symbols-rounded">image</span>';
            preview.dataset.url = '';
        }
    });

    if (tagInput) {
        tagInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                const tagText = tagInput.value.trim();
                if (tagText && !editingTags.find(t => t.text === tagText)) {
                    const existing = appState.allKnownTags.get(tagText);
                    const color    = existing ? existing.color : getTagColorHex(tagText);
                    editingTags.push({ text: tagText, color });
                    renderModalTags();
                    tagInput.value = '';
                }
            }
        });
    }

    if (saveBtn) saveBtn.addEventListener('click', saveMetadata);
}

function loadThumbnailFromFile(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
        const preview = document.getElementById('edit-thumbnail-preview');
        if (preview) {
            preview.style.backgroundImage = `url(${e.target.result})`;
            preview.innerHTML   = '';
            preview.dataset.url = e.target.result;
        }
    };
    reader.readAsDataURL(file);
}

async function openEditModal(trackIds) {
    currentEditTrackIds = trackIds;
    const modal = document.getElementById('edit-modal');
    if (!modal) return;

    const isBulk      = trackIds.length > 1;
    const infoEl      = document.getElementById('edit-modal-info');
    const titleEl     = document.getElementById('edit-modal-title');
    const titleInput  = document.getElementById('edit-title');
    const artistInput = document.getElementById('edit-artist');
    const dateInput   = document.getElementById('edit-date');
    const preview     = document.getElementById('edit-thumbnail-preview');

    if (infoEl)  infoEl.textContent  = isBulk ? `${trackIds.length}曲を一括編集` : '';
    if (titleEl) titleEl.textContent = isBulk ? `${trackIds.length}曲を一括編集` : '情報を編集';

    if (isBulk) {
        if (titleInput)  { titleInput.value = '（複数選択中 - 変更不可）'; titleInput.disabled = true; }
        if (artistInput) artistInput.value = '';
        if (dateInput)   dateInput.value   = '';
        editingTags = [];
        if (preview) { preview.style.backgroundImage = 'none'; preview.innerHTML = '<span class="material-symbols-rounded">library_music</span>'; preview.dataset.url = ''; }
    } else {
        const track = appState.tracks.find(t => t.id === trackIds[0]);
        if (!track) return;
        if (titleInput)  { titleInput.value = track.title || ''; titleInput.disabled = false; }
        if (artistInput) artistInput.value = track.artist || '';
        if (dateInput)   dateInput.value   = track.date   || '';
        editingTags = sortTagsByOrder(track.tags || []).map(t => typeof t === 'string' ? { text: t, color: getTagColorHex(t) } : t);

        if (preview) {
            // thumbsストアから取得
            const dataUrl = thumbCache.get(track.id) || await getThumbFromDB(track.id);
            if (dataUrl) {
                preview.style.backgroundImage = `url(${dataUrl})`;
                preview.innerHTML   = '';
                preview.dataset.url = dataUrl;
            } else {
                preview.style.backgroundImage = 'none';
                preview.innerHTML   = '<span class="material-symbols-rounded">image</span>';
                preview.dataset.url = '';
            }
        }
    }

    populateArtistChips();
    renderModalTags();
    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';
}

function populateArtistChips() {
    const artistsRow = document.getElementById('existing-artists-row');
    if (!artistsRow) return;
    artistsRow.innerHTML = '';
    const artists = [...new Set(appState.tracks.map(t => t.artist).filter(Boolean))];
    artists.slice(0, 20).forEach(artist => {
        const chip = document.createElement('button');
        chip.className   = 'existing-chip';
        chip.textContent = artist;
        chip.type        = 'button';
        chip.addEventListener('click', () => {
            const artistInput = document.getElementById('edit-artist');
            if (artistInput) artistInput.value = artist;
        });
        artistsRow.appendChild(chip);
    });
}

function refreshExistingTagsChips() {
    const tagsRow = document.getElementById('existing-tags-row');
    if (!tagsRow) return;
    tagsRow.innerHTML = '';
    // tagOrderに沿って表示
    appState.tagOrder.forEach(text => {
        const tagObj = appState.allKnownTags.get(text);
        if (!tagObj) return;
        if (editingTags.find(t => t.text === text)) return;
        const chip = document.createElement('button');
        chip.className   = 'existing-chip';
        chip.textContent = text;
        chip.style.borderColor = tagObj.color;
        chip.type        = 'button';
        chip.addEventListener('click', () => {
            if (!editingTags.find(t => t.text === text)) {
                editingTags.push({ text, color: tagObj.color });
                renderModalTags();
            }
        });
        tagsRow.appendChild(chip);
    });
}

function closeEditModal() {
    const modal = document.getElementById('edit-modal');
    if (modal) modal.style.display = 'none';
    document.body.style.overflow = '';
    currentEditTrackIds = [];
    editingTags         = [];
}

function renderModalTags() {
    const list = document.getElementById('edit-tags-list');
    if (!list) return;
    list.innerHTML = '';
    editingTags.forEach((tagObj, index) => {
        const span = document.createElement('span');
        span.className = 'tag-item';
        span.style.border          = `1px solid ${tagObj.color}`;
        span.style.backgroundColor = `${tagObj.color}33`;
        span.innerHTML = `
            <span class="tag-text-content" style="cursor:pointer;">${tagObj.text}</span>
            <span class="material-symbols-rounded remove-tag" data-index="${index}" style="font-size:14px;cursor:pointer;opacity:0.7;">close</span>
        `;
        span.querySelector('.tag-text-content').addEventListener('click', () => openTagEditModal(index));
        list.appendChild(span);
    });
    list.querySelectorAll('.remove-tag').forEach(btn => {
        btn.addEventListener('click', (e) => {
            editingTags.splice(parseInt(e.target.getAttribute('data-index')), 1);
            renderModalTags();
        });
    });
    refreshExistingTagsChips();
}

function openTagEditModal(index) {
    const tagObj = editingTags[index];
    const modal  = document.createElement('div');
    modal.className    = 'modal-overlay';
    modal.style.zIndex = '600';
    modal.innerHTML    = `
        <div class="edit-modal-content" style="max-width:320px;">
            <div class="edit-modal-header">
                <h2 class="edit-modal-title">タグを編集</h2>
                <button class="icon-btn" id="tag-modal-cancel-x"><span class="material-symbols-rounded">close</span></button>
            </div>
            <div style="padding:16px 24px;display:flex;flex-direction:column;gap:14px;">
                <div class="form-field">
                    <label class="form-label">タグ名</label>
                    <input type="text" id="modal-tag-name" class="form-input" value="${tagObj.text}">
                </div>
                <div class="form-field">
                    <label class="form-label">色</label>
                    <input type="color" id="modal-tag-color" value="${tagObj.color}" style="width:100%;height:36px;border:1px solid var(--border);border-radius:8px;padding:2px 4px;cursor:pointer;">
                </div>
            </div>
            <div class="edit-modal-footer">
                <span></span>
                <div class="edit-modal-btns">
                    <button class="action-btn" id="tag-modal-cancel">キャンセル</button>
                    <button class="action-btn primary" id="tag-modal-save">確定</button>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
    modal.querySelector('#tag-modal-cancel-x').addEventListener('click', () => modal.remove());
    modal.querySelector('#tag-modal-cancel').addEventListener('click',   () => modal.remove());
    modal.querySelector('#tag-modal-save').addEventListener('click', () => {
        const newText  = modal.querySelector('#modal-tag-name').value.trim();
        const newColor = modal.querySelector('#modal-tag-color').value;
        if (newText) { editingTags[index] = { text: newText, color: newColor }; renderModalTags(); }
        modal.remove();
    });
}

async function saveMetadata() {
    if (currentEditTrackIds.length === 0) return;
    const isBulk       = currentEditTrackIds.length > 1;
    const newArtist    = document.getElementById('edit-artist').value.trim();
    const newDate      = document.getElementById('edit-date').value;
    const preview      = document.getElementById('edit-thumbnail-preview');
    const newThumbnail = preview ? preview.dataset.url : null;

    const tracksToUpdate = [];
    currentEditTrackIds.forEach(id => {
        const track = appState.tracks.find(t => t.id === id);
        if (track) {
            if (!isBulk) {
                track.title  = document.getElementById('edit-title').value;
                track.artist = newArtist;
                track.date   = newDate;
                track.tags   = [...editingTags];
            } else {
                if (newArtist) track.artist = newArtist;
                if (newDate)   track.date   = newDate;
                let combinedTags = [...(track.tags || [])];
                editingTags.forEach(newTag => {
                    const exists = combinedTags.find(t => (typeof t === 'string' ? t : t.text) === newTag.text);
                    if (!exists) combinedTags.push(newTag);
                });
                track.tags = combinedTags;
            }
            track.updatedAt = Date.now();
            tracksToUpdate.push(track);
        }
    });

    for (const track of tracksToUpdate) {
        await saveTrackToDB(track);
        // サムネイル更新
        if (!isBulk && newThumbnail !== undefined) {
            if (newThumbnail) {
                await saveThumbToDB(track.id, newThumbnail);
                thumbCache.set(track.id, newThumbnail);
                track.thumbDriveId = null; // 再アップロードが必要
            } else {
                await deleteThumbFromDB(track.id);
                thumbCache.delete(track.id);
                track.thumbDriveId = null;
            }
            await saveTrackToDB(track);
        }
    }

    // タグ情報を allKnownTags / tagOrder に反映
    editingTags.forEach(tag => {
        if (!appState.allKnownTags.has(tag.text)) {
            appState.allKnownTags.set(tag.text, tag);
            appState.tagOrder.push(tag.text);
        } else {
            appState.allKnownTags.set(tag.text, tag);
        }
    });
    saveTagOrderToStorage();

    showToast(`${tracksToUpdate.length}曲 の情報を保存しました`, 'success');
    await loadLibrary();
    renderVirtualEditGrid();
    closeEditModal();
    autoSync();
}

function initPlaylistPlaybackControls() {
    // btn-play-all / btn-shuffle-all はHTML削除済み
}

// ─────────────────────────────────────────────
// ユーティリティ
// ─────────────────────────────────────────────
function formatTime(seconds) {
    if (isNaN(seconds)) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}

function getTagColorHex(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
    const c = (hash & 0x00FFFFFF).toString(16).toUpperCase();
    return '#' + '000000'.substring(0, 6 - c.length) + c;
}
