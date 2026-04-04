/**
 * drive.js — Google Drive integration for Sonora
 *
 * Architecture:
 *   Drive folder: "Sonora" (created once, id stored in meta)
 *     ├─ sonora_index.json   (snapshot: tracks meta, playlists, tags, logs)
 *     ├─ audio/
 *     │   └─ <trackId>.mp3   (audio files)
 *     └─ thumbs/
 *         └─ <trackId>.jpg   (thumbnails)
 *
 * Sync strategy (per-operation, incremental):
 *   1. Upload index.json
 *   2. Upload new audio files (only missing ones)
 *   3. Upload new thumbnails (only missing ones)
 *   4. Pull remote index, merge deletions, merge new tracks
 *   5. Download missing audio blobs for merged tracks
 *
 * Deletion propagation:
 *   - Local delete → update index.json → add to deletedIds[]
 *   - On other device sync: see deletedIds → delete local
 *   - Drive file delete → detected via remote index diff → delete local
 */

const Drive = (() => {

  /* ─────────────────────────────────────────
     CONFIG  (set CLIENT_ID before deploying)
  ───────────────────────────────────────── */
  const CLIENT_ID  = '963318517208-gjqi9k8d5v6qr8hk1a4jm54cpdc2i03q.apps.googleusercontent.com';
  const API_KEY    = '';   // not needed for Drive with OAuth
  const SCOPES     = 'https://www.googleapis.com/auth/drive.file openid email profile';
  const FOLDER_NAME = 'Sonora';
  const INDEX_FILE  = 'sonora_index.json';

  /* ─────────────────────────────────────────
     STATE
  ───────────────────────────────────────── */
  let _tokenClient  = null;
  let _accessToken  = null;
  let _userEmail    = null;
  let _folderId     = null;
  let _audioFolderId = null;
  let _thumbFolderId = null;
  let _autoSync     = false;
  let _syncPending  = false;
  let _autoSyncTimer = null;
  let _logSyncTimer  = null;

  /* ─────────────────────────────────────────
     PROGRESS REPORTING
  ───────────────────────────────────────── */
  function _progress(pct, detail) {
    const wrap   = document.getElementById('sync-progress-wrap');
    const fill   = document.getElementById('sync-bar-fill');
    const detTxt = document.getElementById('sync-detail-txt');
    const pctTxt = document.getElementById('sync-pct-txt');
    if (wrap)   wrap.classList.add('visible');
    if (fill)   fill.style.width = Math.min(100, pct) + '%';
    if (detTxt) detTxt.textContent = detail;
    if (pctTxt) pctTxt.textContent = Math.round(pct) + '%';
  }

  function _progressDone() {
    setTimeout(() => {
      const wrap = document.getElementById('sync-progress-wrap');
      const fill = document.getElementById('sync-bar-fill');
      if (wrap) wrap.classList.remove('visible');
      if (fill) fill.style.width = '0%';
    }, 2000);
  }

  /* ─────────────────────────────────────────
     AUTH – Google Identity Services
  ───────────────────────────────────────── */
  function init() {
    // Wait for GIS to load
    const check = setInterval(() => {
      if (typeof google !== 'undefined' && google.accounts) {
        clearInterval(check);
        _initTokenClient();
      }
    }, 300);

    // Restore login state
    Storage.getMeta('driveToken').then(tok => {
      if (tok && tok.expiry > Date.now()) {
        _accessToken = tok.token;
        _userEmail   = tok.email || null;
        _updateLoginUI(true);
      }
    });

    // Restore auto-sync setting
    Storage.getMeta('autoSync', false).then(v => {
      _autoSync = v;
      const toggle = document.getElementById('auto-sync-toggle');
      if (toggle && v) toggle.classList.add('on');
    });
  }

  function _initTokenClient() {
    if (!google.accounts || !google.accounts.oauth2) return;
    _tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope:     SCOPES,
      callback:  _onTokenResponse,
    });
  }

  function _onTokenResponse(resp) {
    if (resp.error) {
      console.error('OAuth error:', resp.error);
      UI && UI.toast('Googleログインに失敗しました', 'error');
      return;
    }
    _accessToken = resp.access_token;
    const expiry = Date.now() + (resp.expires_in - 60) * 1000;

    // Get user info
    _fetchUserInfo().then(email => {
      _userEmail = email;
      Storage.setMeta('driveToken', { token: _accessToken, expiry, email });
      _updateLoginUI(true);
      UI && UI.toast('Googleアカウントでログインしました');
      // Initial sync
      syncNow();
    });
  }

  async function _fetchUserInfo() {
    try {
      const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: 'Bearer ' + _accessToken }
      });
      const data = await res.json();
      return data.email || null;
    } catch { return null; }
  }

  function toggleLogin() {
    if (_accessToken) {
      _logout();
    } else {
      _login();
    }
  }

  function _login() {
    if (!_tokenClient) {
      UI && UI.toast('Google認証の読み込み中です。しばらくお待ちください。', 'error');
      return;
    }
    _tokenClient.requestAccessToken({ prompt: 'consent' });
  }

  function _logout() {
    if (_accessToken && typeof google !== 'undefined') {
      google.accounts.oauth2.revoke(_accessToken, () => {});
    }
    _accessToken  = null;
    _userEmail    = null;
    _folderId     = null;
    _audioFolderId = null;
    _thumbFolderId = null;
    Storage.deleteMeta('driveToken');
    _updateLoginUI(false);
    UI && UI.toast('ログアウトしました');
  }

  function isLoggedIn() { return !!_accessToken; }

  function _updateLoginUI(loggedIn) {
    const txt       = document.getElementById('settings-login-txt');
    const emailRow  = document.getElementById('account-info-row');
    const emailTxt  = document.getElementById('account-email');
    const syncBtn   = document.getElementById('sync-now-btn');

    if (txt) txt.textContent = loggedIn ? 'ログアウト' : 'ログイン';
    if (emailRow) emailRow.style.display = loggedIn ? 'flex' : 'none';
    if (emailTxt && _userEmail) emailTxt.textContent = _userEmail;
    if (syncBtn)  syncBtn.disabled = !loggedIn;
  }

  /* ─────────────────────────────────────────
     AUTO SYNC
  ───────────────────────────────────────── */
  function toggleAutoSync(btn) {
    _autoSync = !_autoSync;
    btn.classList.toggle('on', _autoSync);
    Storage.setMeta('autoSync', _autoSync);
    if (_autoSync && _accessToken) {
      _scheduleAutoSync();
    } else {
      clearTimeout(_autoSyncTimer);
    }
    UI && UI.toast(_autoSync ? '自動同期をオンにしました' : '自動同期をオフにしました');
  }

  function _scheduleAutoSync() {
    clearTimeout(_autoSyncTimer);
    _autoSyncTimer = setTimeout(() => {
      if (_autoSync && _accessToken) syncNow().then(_scheduleAutoSync);
    }, 5 * 60 * 1000); // every 5 minutes
  }

  function triggerAutoSync() {
    if (_autoSync && _accessToken) {
      clearTimeout(_autoSyncTimer);
      _autoSyncTimer = setTimeout(() => syncNow().then(() => {
        if (_autoSync) _scheduleAutoSync();
      }), 3000); // debounce 3s after change
    }
  }

  function scheduleSyncLogs() {
    clearTimeout(_logSyncTimer);
    _logSyncTimer = setTimeout(() => {
      if (_accessToken) _pushIndex().catch(() => {});
    }, 10000);
  }

  /* ─────────────────────────────────────────
     DRIVE API HELPERS
  ───────────────────────────────────────── */
  async function _apiRequest(method, url, body, contentType) {
    if (!_accessToken) throw new Error('Not authenticated');
    const headers = { Authorization: 'Bearer ' + _accessToken };
    if (contentType) headers['Content-Type'] = contentType;
    const res = await fetch(url, {
      method,
      headers,
      body: body || undefined,
    });
    if (res.status === 401) {
      // Token expired
      _accessToken = null;
      Storage.deleteMeta('driveToken');
      _updateLoginUI(false);
      throw new Error('Token expired');
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Drive API ${res.status}: ${text}`);
    }
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) return res.json();
    return res.arrayBuffer();
  }

  async function _listFiles(params) {
    const qs = new URLSearchParams(params).toString();
    return _apiRequest('GET', `https://www.googleapis.com/drive/v3/files?${qs}`);
  }

  async function _createFolder(name, parentId) {
    return _apiRequest('POST',
      'https://www.googleapis.com/drive/v3/files?fields=id,name',
      JSON.stringify({
        name,
        mimeType: 'application/vnd.google-apps.folder',
        parents:  parentId ? [parentId] : [],
      }),
      'application/json'
    );
  }

  async function _uploadFile(name, mimeType, data, parentId, existingId) {
    const meta    = JSON.stringify({ name, parents: existingId ? undefined : (parentId ? [parentId] : []) });
    const metaBlob = new Blob([meta], { type: 'application/json' });
    const fileBlob = data instanceof Blob ? data : new Blob([data]);

    const form = new FormData();
    form.append('metadata', metaBlob);
    form.append('file',     fileBlob, name);

    const url = existingId
      ? `https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=multipart&fields=id,name`
      : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name`;

    return _apiRequest(existingId ? 'PATCH' : 'POST', url, form);
  }

  async function _downloadFile(fileId) {
    return _apiRequest('GET',
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`
    );
  }

  async function _deleteFile(fileId) {
    if (!_accessToken) return;
    await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
      method:  'DELETE',
      headers: { Authorization: 'Bearer ' + _accessToken },
    });
  }

  /* ─────────────────────────────────────────
     FOLDER SETUP
  ───────────────────────────────────────── */
  async function _ensureFolders() {
    // Root folder
    if (!_folderId) {
      _folderId = await Storage.getMeta('driveFolderId');
    }
    if (!_folderId) {
      const list = await _listFiles({
        q:      `name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
        fields: 'files(id,name)',
      });
      if (list.files && list.files.length > 0) {
        _folderId = list.files[0].id;
      } else {
        const folder = await _createFolder(FOLDER_NAME);
        _folderId = folder.id;
      }
      await Storage.setMeta('driveFolderId', _folderId);
    }

    // Audio sub-folder
    if (!_audioFolderId) {
      _audioFolderId = await Storage.getMeta('driveAudioFolderId');
    }
    if (!_audioFolderId) {
      const list = await _listFiles({
        q:      `name='audio' and mimeType='application/vnd.google-apps.folder' and '${_folderId}' in parents and trashed=false`,
        fields: 'files(id,name)',
      });
      if (list.files && list.files.length > 0) {
        _audioFolderId = list.files[0].id;
      } else {
        const f = await _createFolder('audio', _folderId);
        _audioFolderId = f.id;
      }
      await Storage.setMeta('driveAudioFolderId', _audioFolderId);
    }

    // Thumbs sub-folder
    if (!_thumbFolderId) {
      _thumbFolderId = await Storage.getMeta('driveThumbFolderId');
    }
    if (!_thumbFolderId) {
      const list = await _listFiles({
        q:      `name='thumbs' and mimeType='application/vnd.google-apps.folder' and '${_folderId}' in parents and trashed=false`,
        fields: 'files(id,name)',
      });
      if (list.files && list.files.length > 0) {
        _thumbFolderId = list.files[0].id;
      } else {
        const f = await _createFolder('thumbs', _folderId);
        _thumbFolderId = f.id;
      }
      await Storage.setMeta('driveThumbFolderId', _thumbFolderId);
    }
  }

  /* ─────────────────────────────────────────
     INDEX (sonora_index.json)
  ───────────────────────────────────────── */
  async function _getIndexFileId() {
    let id = await Storage.getMeta('driveIndexFileId');
    if (id) return id;
    const list = await _listFiles({
      q:      `name='${INDEX_FILE}' and '${_folderId}' in parents and trashed=false`,
      fields: 'files(id,name)',
    });
    if (list.files && list.files.length > 0) {
      id = list.files[0].id;
      await Storage.setMeta('driveIndexFileId', id);
      return id;
    }
    return null;
  }

  async function _pushIndex() {
    if (!_accessToken) return;
    await _ensureFolders();
    const snapshot   = await Storage.exportSnapshot();
    const deletedIds = await Storage.getMeta('deletedTrackIds', []);
    snapshot.deletedIds = deletedIds;

    const json     = JSON.stringify(snapshot, null, 2);
    const blob     = new Blob([json], { type: 'application/json' });
    const existing = await _getIndexFileId();
    const result   = await _uploadFile(INDEX_FILE, 'application/json', blob, _folderId, existing);
    if (result && result.id) {
      await Storage.setMeta('driveIndexFileId', result.id);
    }
  }

  async function _pullIndex() {
    const indexId = await _getIndexFileId();
    if (!indexId) return null;
    try {
      const buf  = await _downloadFile(indexId);
      const text = new TextDecoder().decode(buf);
      return JSON.parse(text);
    } catch { return null; }
  }

  /* ─────────────────────────────────────────
     AUDIO FILE SYNC
  ───────────────────────────────────────── */
  async function _pushAudioFile(track) {
    if (!track.blobKey) return;
    const blob = await Storage.getBlob(track.blobKey);
    if (!blob) return;
    const ext      = _guessExt(track.title);
    const fileName = `${track.id}${ext}`;
    const existing = track.driveFileId || null;
    const result   = await _uploadFile(fileName, 'audio/mpeg', blob, _audioFolderId, existing);
    if (result && result.id) {
      await Storage.updateTrack(track.id, { driveFileId: result.id });
    }
  }

  async function _pullAudioFile(track) {
    if (!track.driveFileId) return false;
    try {
      const buf = await _downloadFile(track.driveFileId);
      const key = await Storage.saveBlob(buf);
      await Storage.updateTrack(track.id, { blobKey: key });
      return true;
    } catch { return false; }
  }

  async function _pushThumbFile(track) {
    if (!track.thumbKey) return;
    const blob = await Storage.getBlob(track.thumbKey);
    if (!blob) return;
    const existing = track.driveThumbId || null;
    const result   = await _uploadFile(`${track.id}.jpg`, 'image/jpeg', blob, _thumbFolderId, existing);
    if (result && result.id) {
      await Storage.updateTrack(track.id, { driveThumbId: result.id });
    }
  }

  async function _pullThumbFile(track) {
    if (!track.driveThumbId) return false;
    try {
      const buf = await _downloadFile(track.driveThumbId);
      const key = await Storage.saveBlob(buf);
      await Storage.updateTrack(track.id, { thumbKey: key });
      return true;
    } catch { return false; }
  }

  function _guessExt(title) {
    // stored title may keep extension info — fallback to .mp3
    return '.mp3';
  }

  /* ─────────────────────────────────────────
     DETECT DRIVE-SIDE CHANGES
     (files added/deleted directly in Drive)
  ───────────────────────────────────────── */
  async function _detectDriveChanges(remoteIndex) {
    if (!remoteIndex) return;
    const localTracks  = await Storage.getTracks();
    const localIds     = new Set(localTracks.map(t => t.id));
    const remoteIds    = new Set((remoteIndex.tracks || []).map(t => t.id));
    const deletedIds   = new Set(remoteIndex.deletedIds || []);
    const localDeleted = new Set(await Storage.getMeta('deletedTrackIds', []));

    // Tracks deleted directly in Drive (present in local but absent in remote & not in our deletedIds)
    for (const local of localTracks) {
      if (!remoteIds.has(local.id) && !localDeleted.has(local.id)) {
        // Drive-side delete — propagate locally
        await Storage.deleteTrack(local.id);
      }
    }

    // Tracks deleted on another device (in remote deletedIds)
    for (const id of deletedIds) {
      if (localIds.has(id)) {
        await Storage.deleteTrack(id);
      }
    }

    // Check for audio files added directly to Drive (have driveFileId but no blobKey locally)
    const driveListed = await _listFiles({
      q:      `'${_audioFolderId}' in parents and trashed=false`,
      fields: 'files(id,name)',
    }).catch(() => ({ files: [] }));

    const driveAudioMap = {}; // filename → fileId
    (driveListed.files || []).forEach(f => { driveAudioMap[f.name] = f.id; });

    for (const remoteTrack of remoteIndex.tracks || []) {
      const existing = await Storage.getTrack(remoteTrack.id);
      if (!existing) continue;
      if (!existing.blobKey && !existing.driveFileId) {
        // See if a file exists in Drive for this track
        const possibleNames = [
          `${remoteTrack.id}.mp3`,
          `${remoteTrack.id}.m4a`,
          `${remoteTrack.id}.wav`,
          `${remoteTrack.id}.flac`,
          `${remoteTrack.id}.ogg`,
        ];
        for (const name of possibleNames) {
          if (driveAudioMap[name]) {
            await Storage.updateTrack(remoteTrack.id, { driveFileId: driveAudioMap[name] });
            break;
          }
        }
      }
    }
  }

  /* ─────────────────────────────────────────
     MAIN SYNC
  ───────────────────────────────────────── */
  async function syncNow() {
    if (!_accessToken) {
      UI && UI.toast('ログインしてから同期してください', 'error');
      return;
    }
    if (_syncPending) return;
    _syncPending = true;

    try {
      _progress(5, '接続確認中...');

      // 1. Ensure folder structure
      await _ensureFolders();
      _progress(10, 'フォルダを確認中...');

      // 2. Pull remote index
      const remote = await _pullIndex();
      _progress(20, 'リモートデータを取得中...');

      // 3. Detect remote-side changes (deletions, direct uploads)
      if (remote) {
        await _detectDriveChanges(remote);
      }
      _progress(30, '変更を検出中...');

      // 4. Merge remote tracks into local (new tracks from other devices)
      if (remote) {
        await Storage.importSnapshot(remote);
      }
      _progress(40, 'データをマージ中...');

      // 5. Push audio files for tracks that have blobKey but no driveFileId
      const localTracks = await Storage.getTracks();
      const toUpload    = localTracks.filter(t => t.blobKey && !t.driveFileId);
      const total       = toUpload.length;

      for (let i = 0; i < toUpload.length; i++) {
        const t   = toUpload[i];
        const pct = 40 + ((i / Math.max(total, 1)) * 30);
        _progress(pct, `音声ファイルをアップロード中 (${i + 1}/${total})...`);
        await _pushAudioFile(t).catch(e => console.warn('audio upload failed:', e));
      }
      _progress(70, 'サムネイルをアップロード中...');

      // 6. Push thumbnail files
      const withThumb = localTracks.filter(t => t.thumbKey && !t.driveThumbId);
      for (const t of withThumb) {
        await _pushThumbFile(t).catch(e => console.warn('thumb upload failed:', e));
      }
      _progress(80, 'インデックスを保存中...');

      // 7. Download audio for merged tracks that we don't have locally
      const afterMerge   = await Storage.getTracks();
      const needDownload = afterMerge.filter(t => !t.blobKey && t.driveFileId);
      const dlTotal      = needDownload.length;
      for (let i = 0; i < needDownload.length; i++) {
        const t   = needDownload[i];
        const pct = 80 + ((i / Math.max(dlTotal, 1)) * 10);
        _progress(pct, `音声ファイルをダウンロード中 (${i + 1}/${dlTotal})...`);
        await _pullAudioFile(t).catch(e => console.warn('audio download failed:', e));
      }

      // 8. Push updated index
      _progress(92, 'インデックスをアップロード中...');
      await _pushIndex();

      // 9. Clear local deletedIds after successful push
      await Storage.setMeta('deletedTrackIds', []);

      _progress(100, '同期完了');
      _progressDone();
      UI && UI.toast('同期が完了しました', 'success');

      // Refresh UI
      if (typeof App !== 'undefined') App.refreshAll();

    } catch (err) {
      console.error('Sync error:', err);
      _progressDone();
      UI && UI.toast('同期エラー: ' + (err.message || '不明なエラー'), 'error');
    } finally {
      _syncPending = false;
    }
  }

  /* ─────────────────────────────────────────
     ON TRACK DELETE (record for propagation)
  ───────────────────────────────────────── */
  async function onTrackDeleted(trackId) {
    const existing = await Storage.getMeta('deletedTrackIds', []);
    if (!existing.includes(trackId)) {
      existing.push(trackId);
      await Storage.setMeta('deletedTrackIds', existing);
    }
    // Async push index so other devices see the deletion soon
    if (_accessToken) {
      _pushIndex().catch(() => {});
    }
  }

  /* ─────────────────────────────────────────
     ON TRACK ADDED (upload immediately if auto-sync)
  ───────────────────────────────────────── */
  async function onTrackAdded(track) {
    if (!_accessToken) return;
    try {
      await _ensureFolders();
      await _pushAudioFile(track);
      if (track.thumbKey) await _pushThumbFile(track);
      await _pushIndex();
    } catch (e) {
      console.warn('onTrackAdded Drive push failed:', e);
    }
  }

  /* ─────────────────────────────────────────
     FULL DRIVE RESET
  ───────────────────────────────────────── */
  async function resetDriveData() {
    if (!_accessToken) return;
    try {
      _progress(5, 'Driveデータを削除中...');
      if (_folderId) {
        await _deleteFile(_folderId);
      }
      _folderId      = null;
      _audioFolderId = null;
      _thumbFolderId = null;
      await Storage.deleteMeta('driveFolderId');
      await Storage.deleteMeta('driveAudioFolderId');
      await Storage.deleteMeta('driveThumbFolderId');
      await Storage.deleteMeta('driveIndexFileId');
      _progress(100, '削除完了');
      _progressDone();
    } catch (e) {
      console.error('Drive reset error:', e);
      _progressDone();
    }
  }

  /* ─────────────────────────────────────────
     PUBLIC API
  ───────────────────────────────────────── */
  return {
    init,
    isLoggedIn,
    toggleLogin,
    toggleAutoSync,
    triggerAutoSync,
    scheduleSyncLogs,
    syncNow,
    onTrackDeleted,
    onTrackAdded,
    resetDriveData,
  };

})();

