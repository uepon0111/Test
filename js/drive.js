/**
 * drive.js — Google Drive integration for Sonora (v2)
 *
 * 改善点:
 *   - 独立タスクをPromise.allSettledで並列実行（最大4並列）
 *   - トラック追加時に即座にDriveへアップロード
 *   - トラック削除時にDrive・index・他端末へ即時伝播
 *   - Drive直接追加ファイルを次回同期時に自動検出・取り込み
 *   - Drive直接削除を検出し、ページ・ログからも削除
 *   - ID3v2タグ（mp3）・ファイル名からメタ情報を自動抽出
 *   - 差分のみを処理する増分同期
 */

const Drive = (() => {

  /* ─────────────────────────────────────────
     CONFIG
  ───────────────────────────────────────── */
  const CLIENT_ID   = '216604412012-80eanap7n3ldoa1npd73v22t9gl552nq.apps.googleusercontent.com';
  const SCOPES      = 'https://www.googleapis.com/auth/drive.file openid email profile';
  const FOLDER_NAME = 'Sonora';
  const INDEX_FILE  = 'sonora_index.json';

  /* ─────────────────────────────────────────
     STATE
  ───────────────────────────────────────── */
  let _token         = null;
  let _tokenExpiry   = 0;
  let _userEmail     = null;
  let _folderId      = null;
  let _audioFolderId = null;
  let _thumbFolderId = null;
  let _autoSync      = false;
  let _syncing       = false;
  let _autoSyncTimer = null;
  let _logSyncTimer  = null;
  let _tokenClient   = null;

  const _uploadingAudio = new Set();
  const _uploadingThumb = new Set();

  /* ─────────────────────────────────────────
     PROGRESS UI
  ───────────────────────────────────────── */
  function _prog(pct, detail) {
    const wrap = document.getElementById('sync-progress-wrap');
    const fill = document.getElementById('sync-bar-fill');
    const det  = document.getElementById('sync-detail-txt');
    const pEl  = document.getElementById('sync-pct-txt');
    if (wrap) wrap.classList.add('visible');
    if (fill) fill.style.width = Math.min(100, Math.round(pct)) + '%';
    if (det)  det.textContent  = detail;
    if (pEl)  pEl.textContent  = Math.round(pct) + '%';
  }

  function _progDone() {
    setTimeout(() => {
      const wrap = document.getElementById('sync-progress-wrap');
      const fill = document.getElementById('sync-bar-fill');
      if (wrap) wrap.classList.remove('visible');
      if (fill) fill.style.width = '0%';
    }, 1800);
  }

  /* ─────────────────────────────────────────
     AUTH
  ───────────────────────────────────────── */
  function init() {
    const t = setInterval(() => {
      if (typeof google !== 'undefined' && google.accounts?.oauth2) {
        clearInterval(t);
        _tokenClient = google.accounts.oauth2.initTokenClient({
          client_id: CLIENT_ID,
          scope:     SCOPES,
          callback:  _onToken,
        });
      }
    }, 300);

    Storage.getMeta('driveAuth').then(auth => {
      if (!auth) return;
      if (auth.expiry > Date.now() + 60000) {
        _token         = auth.token;
        _tokenExpiry   = auth.expiry;
        _userEmail     = auth.email;
        _folderId      = auth.folderId      || null;
        _audioFolderId = auth.audioFolderId || null;
        _thumbFolderId = auth.thumbFolderId || null;
        _updateLoginUI(true);
      }
    });

    Storage.getMeta('autoSync', false).then(v => {
      _autoSync = v;
      const tog = document.getElementById('auto-sync-toggle');
      if (tog && v) tog.classList.add('on');
    });
  }

  async function _onToken(resp) {
    if (resp.error) {
      UI.toast('Googleログインに失敗しました: ' + resp.error, 'error');
      return;
    }
    _token       = resp.access_token;
    _tokenExpiry = Date.now() + (resp.expires_in - 120) * 1000;

    try {
      const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: 'Bearer ' + _token },
      });
      const u = await r.json();
      _userEmail = u.email || null;
    } catch { _userEmail = null; }

    await _ensureFolders();

    await Storage.setMeta('driveAuth', {
      token: _token, expiry: _tokenExpiry, email: _userEmail,
      folderId: _folderId, audioFolderId: _audioFolderId, thumbFolderId: _thumbFolderId,
    });

    _updateLoginUI(true);
    UI.toast('Googleアカウントでログインしました');
    await syncNow();
  }

  function toggleLogin() {
    if (_token) _logout(); else _login();
  }

  function _login() {
    if (!_tokenClient) { UI.toast('Google認証を読み込み中です', 'error'); return; }
    _tokenClient.requestAccessToken({ prompt: 'consent' });
  }

  function _logout() {
    if (_token && typeof google !== 'undefined')
      google.accounts.oauth2.revoke(_token, () => {});
    _token = null; _tokenExpiry = 0;
    _userEmail = _folderId = _audioFolderId = _thumbFolderId = null;
    Storage.deleteMeta('driveAuth');
    _updateLoginUI(false);
    UI.toast('ログアウトしました');
  }

  function isLoggedIn() { return !!_token && Date.now() < _tokenExpiry; }

  function _updateLoginUI(on) {
    const txt     = document.getElementById('settings-login-txt');
    const infoRow = document.getElementById('account-info-row');
    const emailEl = document.getElementById('account-email');
    const syncBtn = document.getElementById('sync-now-btn');
    if (txt)     txt.textContent        = on ? 'ログアウト' : 'ログイン';
    if (infoRow) infoRow.style.display  = on ? 'flex' : 'none';
    if (emailEl && _userEmail) emailEl.textContent = _userEmail;
    if (syncBtn) syncBtn.disabled       = !on;
  }

  /* ─────────────────────────────────────────
     AUTO SYNC
  ───────────────────────────────────────── */
  function toggleAutoSync(btn) {
    _autoSync = !_autoSync;
    btn.classList.toggle('on', _autoSync);
    Storage.setMeta('autoSync', _autoSync);
    UI.toast(_autoSync ? '自動同期をオンにしました' : '自動同期をオフにしました');
    if (_autoSync && isLoggedIn()) _scheduleAutoSync();
    else clearTimeout(_autoSyncTimer);
  }

  function _scheduleAutoSync(delay = 5 * 60 * 1000) {
    clearTimeout(_autoSyncTimer);
    _autoSyncTimer = setTimeout(async () => {
      if (_autoSync && isLoggedIn()) { await syncNow(); _scheduleAutoSync(); }
    }, delay);
  }

  function triggerAutoSync() {
    if (!_autoSync || !isLoggedIn()) return;
    clearTimeout(_autoSyncTimer);
    _autoSyncTimer = setTimeout(() => syncNow().then(() => _scheduleAutoSync()), 3000);
  }

  function scheduleSyncLogs() {
    clearTimeout(_logSyncTimer);
    _logSyncTimer = setTimeout(() => {
      if (isLoggedIn()) _pushIndex().catch(() => {});
    }, 10000);
  }

  /* ─────────────────────────────────────────
     DRIVE API ヘルパー
  ───────────────────────────────────────── */
  async function _api(method, url, body, contentType) {
    if (!isLoggedIn()) throw new Error('Not authenticated');
    const headers = { Authorization: 'Bearer ' + _token };
    if (contentType) headers['Content-Type'] = contentType;
    const res = await fetch(url, { method, headers, body });
    if (res.status === 401) {
      _token = null;
      Storage.deleteMeta('driveAuth');
      _updateLoginUI(false);
      throw new Error('Token expired');
    }
    if (res.status === 204) return null;
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Drive ${res.status}: ${txt.slice(0, 120)}`);
    }
    const ct = res.headers.get('content-type') || '';
    return ct.includes('application/json') ? res.json() : res.arrayBuffer();
  }

  async function _upload(name, mime, data, parentId, existingId) {
    const metaObj  = existingId ? { name } : { name, parents: parentId ? [parentId] : [] };
    const metaBlob = new Blob([JSON.stringify(metaObj)], { type: 'application/json' });
    const fileBlob = data instanceof Blob ? data : new Blob([data], { type: mime });
    const form = new FormData();
    form.append('metadata', metaBlob);
    form.append('file', fileBlob, name);
    const url = existingId
      ? `https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=multipart&fields=id,name`
      : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name`;
    return _api(existingId ? 'PATCH' : 'POST', url, form);
  }

  async function _list(q, fields = 'files(id,name,modifiedTime)') {
    const qs = new URLSearchParams({ q, fields, pageSize: '1000' }).toString();
    const r  = await _api('GET', `https://www.googleapis.com/drive/v3/files?${qs}`);
    return r?.files || [];
  }

  async function _download(fileId) {
    return _api('GET', `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
  }

  async function _deleteFile(fileId) {
    if (!fileId) return;
    await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer ' + _token },
    }).catch(() => {});
  }

  async function _createFolder(name, parentId) {
    return _api('POST',
      'https://www.googleapis.com/drive/v3/files?fields=id,name',
      JSON.stringify({
        name,
        mimeType: 'application/vnd.google-apps.folder',
        parents:  parentId ? [parentId] : [],
      }),
      'application/json'
    );
  }

  /* ─────────────────────────────────────────
     フォルダ確保（サブフォルダ並列）
  ───────────────────────────────────────── */
  async function _ensureFolders() {
    if (!_folderId) {
      const saved = await Storage.getMeta('driveFolderId');
      if (saved) {
        _folderId = saved;
      } else {
        const list = await _list(
          `name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`
        );
        _folderId = list[0]?.id ?? (await _createFolder(FOLDER_NAME)).id;
        await Storage.setMeta('driveFolderId', _folderId);
      }
    }
    const [aId, tId] = await Promise.all([
      _ensureSubFolder('audio', 'driveAudioFolderId'),
      _ensureSubFolder('thumbs', 'driveThumbFolderId'),
    ]);
    _audioFolderId = aId;
    _thumbFolderId = tId;
  }

  async function _ensureSubFolder(name, metaKey) {
    let id = await Storage.getMeta(metaKey);
    if (id) return id;
    const list = await _list(
      `name='${name}' and mimeType='application/vnd.google-apps.folder' and '${_folderId}' in parents and trashed=false`
    );
    id = list[0]?.id ?? (await _createFolder(name, _folderId)).id;
    await Storage.setMeta(metaKey, id);
    return id;
  }

  /* ─────────────────────────────────────────
     INDEX
  ───────────────────────────────────────── */
  async function _getIndexId() {
    let id = await Storage.getMeta('driveIndexFileId');
    if (id) return id;
    const list = await _list(`name='${INDEX_FILE}' and '${_folderId}' in parents and trashed=false`);
    id = list[0]?.id || null;
    if (id) await Storage.setMeta('driveIndexFileId', id);
    return id;
  }

  async function _pushIndex() {
    if (!isLoggedIn()) return;
    await _ensureFolders();
    const snap = await Storage.exportSnapshot();
    const deletedIds = await Storage.getMeta('deletedTrackIds', []);
    snap.deletedIds = deletedIds;
    const blob    = new Blob([JSON.stringify(snap)], { type: 'application/json' });
    const existId = await _getIndexId();
    const result  = await _upload(INDEX_FILE, 'application/json', blob, _folderId, existId);
    if (result?.id) await Storage.setMeta('driveIndexFileId', result.id);
  }

  async function _pullIndex() {
    const id = await _getIndexId();
    if (!id) return null;
    try {
      const buf  = await _download(id);
      const text = new TextDecoder().decode(buf);
      return JSON.parse(text);
    } catch { return null; }
  }

  /* ─────────────────────────────────────────
     ID3v2 タグパーサ（インライン）
  ───────────────────────────────────────── */
  function _parseID3(buffer) {
    const bytes = new Uint8Array(buffer);
    if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return {};
    const ver     = bytes[3];
    const tagSize = ((bytes[6]&0x7f)<<21)|((bytes[7]&0x7f)<<14)|((bytes[8]&0x7f)<<7)|(bytes[9]&0x7f);
    const result  = {};
    let off = 10;
    const end = Math.min(off + tagSize, buffer.byteLength);
    while (off < end - 10) {
      const fid = String.fromCharCode(bytes[off],bytes[off+1],bytes[off+2],bytes[off+3]);
      if (fid[0] === '\0') break;
      let fSize = ver === 4
        ? ((bytes[off+4]&0x7f)<<21)|((bytes[off+5]&0x7f)<<14)|((bytes[off+6]&0x7f)<<7)|(bytes[off+7]&0x7f)
        : (bytes[off+4]<<24)|(bytes[off+5]<<16)|(bytes[off+6]<<8)|bytes[off+7];
      off += 10;
      if (fSize <= 0 || off + fSize > end) break;
      if (['TIT2','TPE1','TDRC','TYER'].includes(fid)) {
        const enc  = bytes[off];
        const data = bytes.slice(off + 1, off + fSize);
        let text = '';
        try {
          text = new TextDecoder(enc === 0 ? 'iso-8859-1' : enc === 3 ? 'utf-8' : 'utf-16le').decode(data);
        } catch { text = new TextDecoder().decode(data); }
        text = text.replace(/\0/g, '').trim();
        if (fid === 'TIT2') result.title  = text;
        if (fid === 'TPE1') result.artist = text;
        if (fid === 'TDRC' || fid === 'TYER') result.year = text.slice(0, 4);
      }
      off += fSize;
    }
    return result;
  }

  function _metaFromFilename(filename) {
    const base  = filename.replace(/\.[^.]+$/, '');
    const dash  = base.match(/^(.+?)\s+-\s+(.+)$/);
    if (dash) return { artist: dash[1].trim(), title: dash[2].trim() };
    return { title: base, artist: '' };
  }

  async function _extractMeta(buffer, filename) {
    const fromFile = _metaFromFilename(filename);
    let id3 = {};
    try { id3 = _parseID3(buffer); } catch { /* ignore */ }
    return {
      title:       id3.title  || fromFile.title  || '',
      artist:      id3.artist || fromFile.artist || '',
      releaseDate: id3.year   ? `${id3.year}-01-01` : null,
    };
  }

  async function _getDuration(buffer) {
    return new Promise(resolve => {
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        ctx.decodeAudioData(buffer.slice(0), d => { ctx.close(); resolve(d.duration); }, () => { ctx.close(); resolve(0); });
      } catch { resolve(0); }
    });
  }

  /* ─────────────────────────────────────────
     アップロード / ダウンロード
  ───────────────────────────────────────── */
  async function _pushAudio(track) {
    if (!track.blobKey || _uploadingAudio.has(track.id)) return;
    _uploadingAudio.add(track.id);
    try {
      const buf    = await Storage.getBlob(track.blobKey);
      if (!buf) return;
      const ext    = track._ext || '.mp3';
      const result = await _upload(`${track.id}${ext}`, 'audio/mpeg', buf, _audioFolderId, track.driveFileId || null);
      if (result?.id) await Storage.updateTrack(track.id, { driveFileId: result.id });
    } finally { _uploadingAudio.delete(track.id); }
  }

  async function _pushThumb(track) {
    if (!track.thumbKey || _uploadingThumb.has(track.id)) return;
    _uploadingThumb.add(track.id);
    try {
      const buf    = await Storage.getBlob(track.thumbKey);
      if (!buf) return;
      const result = await _upload(`${track.id}.jpg`, 'image/jpeg', buf, _thumbFolderId, track.driveThumbId || null);
      if (result?.id) await Storage.updateTrack(track.id, { driveThumbId: result.id });
    } finally { _uploadingThumb.delete(track.id); }
  }

  async function _pullAudio(track) {
    if (!track.driveFileId) return false;
    try {
      const buf = await _download(track.driveFileId);
      const key = await Storage.saveBlob(buf);
      await Storage.updateTrack(track.id, { blobKey: key });
      return true;
    } catch { return false; }
  }

  async function _pullThumb(track) {
    if (!track.driveThumbId) return false;
    try {
      const buf = await _download(track.driveThumbId);
      const key = await Storage.saveBlob(buf);
      await Storage.updateTrack(track.id, { thumbKey: key });
      return true;
    } catch { return false; }
  }

  /* ─────────────────────────────────────────
     並列制限ヘルパー
  ───────────────────────────────────────── */
  async function _parallelLimit(items, limit, fn) {
    if (!items.length) return [];
    const results = new Array(items.length);
    let idx = 0;
    const run = async () => {
      while (idx < items.length) {
        const i = idx++;
        results[i] = await fn(items[i], i).catch(e => ({ _err: e }));
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
    return results;
  }

  /* ─────────────────────────────────────────
     Drive直接追加の検出・取り込み
  ───────────────────────────────────────── */
  const AUDIO_EXTS = ['.mp3','.m4a','.wav','.flac','.ogg'];

  async function _detectDirectUploads(localTracks, remoteIndex) {
    const driveFiles = await _list(`'${_audioFolderId}' in parents and trashed=false`);

    const knownIds = new Set([
      ...localTracks.filter(t => t.driveFileId).map(t => t.driveFileId),
      ...((remoteIndex?.tracks || []).filter(t => t.driveFileId).map(t => t.driveFileId)),
    ]);

    const newFiles = driveFiles.filter(f =>
      !knownIds.has(f.id) &&
      AUDIO_EXTS.some(ext => f.name.toLowerCase().endsWith(ext))
    );
    if (!newFiles.length) return;

    UI.toast(`Drive から ${newFiles.length} 曲を検出。取り込み中...`);

    // thumbsフォルダのファイル一覧を事前取得
    const thumbFiles = await _list(`'${_thumbFolderId}' in parents and trashed=false`);
    const thumbMap   = new Map(thumbFiles.map(f => [f.name, f.id]));

    await _parallelLimit(newFiles, 3, async driveFile => {
      try {
        const buf      = await _download(driveFile.id);
        const meta     = await _extractMeta(buf, driveFile.name);
        const duration = await _getDuration(buf.slice(0));
        const blobKey  = await Storage.saveBlob(buf);

        // 対応サムネイルを探す
        let thumbKey = null, driveThumbId = null;
        const thumbName = driveFile.name.replace(/\.[^.]+$/, '') + '.jpg';
        const tid = thumbMap.get(thumbName);
        if (tid) {
          const tbuf   = await _download(tid);
          thumbKey     = await Storage.saveBlob(tbuf);
          driveThumbId = tid;
        }

        await Storage.addTrack({
          title: meta.title, artist: meta.artist, releaseDate: meta.releaseDate,
          duration, blobKey, thumbKey, driveFileId: driveFile.id, driveThumbId,
        });
      } catch (e) { console.warn('[Drive] direct import failed:', driveFile.name, e); }
    });
  }

  /* ─────────────────────────────────────────
     削除の検出・伝播
  ───────────────────────────────────────── */
  async function _processDeletions(localTracks, remoteIndex) {
    if (!remoteIndex) return;
    const localMap    = new Map(localTracks.map(t => [t.id, t]));
    const remoteIds   = new Set((remoteIndex.tracks || []).map(t => t.id));
    const deletedIds  = new Set(remoteIndex.deletedIds || []);
    const localDelIds = new Set(await Storage.getMeta('deletedTrackIds', []));

    // Drive 上の driveFileId セット（remote index に存在するもの）
    const remoteDriveIds = new Set(
      (remoteIndex.tracks || []).filter(t => t.driveFileId).map(t => t.driveFileId)
    );

    const toDelete = [];

    for (const local of localTracks) {
      if (localDelIds.has(local.id)) continue;

      // 他端末でページから削除された
      if (deletedIds.has(local.id)) { toDelete.push(local.id); continue; }

      // Drive上で直接削除された
      // driveFileId を持つが remote index にその driveFileId がない
      if (local.driveFileId && !remoteIds.has(local.id) && !remoteDriveIds.has(local.driveFileId)) {
        toDelete.push(local.id);
        // 自分の削除IDリストにも追加（他端末への伝播用）
        const arr = await Storage.getMeta('deletedTrackIds', []);
        if (!arr.includes(local.id)) { arr.push(local.id); await Storage.setMeta('deletedTrackIds', arr); }
      }
    }

    if (toDelete.length > 0) {
      await _parallelLimit(toDelete, 4, id => Storage.deleteTrack(id));
    }
  }

  /* ─────────────────────────────────────────
     メイン同期
  ───────────────────────────────────────── */
  async function syncNow() {
    if (!isLoggedIn()) { UI.toast('ログインしてから同期してください', 'error'); return; }
    if (_syncing) return;
    _syncing = true;

    try {
      _prog(5, 'フォルダを確認中...');
      await _ensureFolders();

      // Step 1: リモートindex & ローカルデータを並列取得
      _prog(12, 'データを並列取得中...');
      const [remoteIndex, localTracks] = await Promise.all([
        _pullIndex(),
        Storage.getTracks(),
      ]);

      // Step 2: 削除の検出・伝播
      _prog(22, '削除を検出中...');
      await _processDeletions(localTracks, remoteIndex);

      // Step 3: リモートの新トラックをローカルへマージ
      _prog(32, '新データをマージ中...');
      if (remoteIndex) await Storage.importSnapshot(remoteIndex);

      // Step 4: Drive直接追加ファイルの検出・取り込み
      _prog(42, 'Driveの新ファイルを検出中...');
      const currentTracks = await Storage.getTracks();
      await _detectDirectUploads(currentTracks, remoteIndex);

      // Step 5: アップロード（音声・サムネイル 4並列ずつ）
      const latest = await Storage.getTracks();
      const toUploadAudio = latest.filter(t => t.blobKey  && !t.driveFileId);
      const toUploadThumb = latest.filter(t => t.thumbKey && !t.driveThumbId);
      const upTotal = toUploadAudio.length + toUploadThumb.length;
      let upDone = 0;

      if (upTotal > 0) {
        _prog(52, `アップロード中 (0/${upTotal})...`);
        await Promise.allSettled([
          _parallelLimit(toUploadAudio, 4, async t => {
            await _pushAudio(t); upDone++;
            _prog(52 + (upDone / upTotal) * 24, `アップロード中 (${upDone}/${upTotal})...`);
          }),
          _parallelLimit(toUploadThumb, 4, async t => {
            await _pushThumb(t); upDone++;
            _prog(52 + (upDone / upTotal) * 24, `アップロード中 (${upDone}/${upTotal})...`);
          }),
        ]);
      }

      // Step 6: ダウンロード（blobなしでDriveにあるもの 4並列）
      const afterMerge  = await Storage.getTracks();
      const dlAudio = afterMerge.filter(t => !t.blobKey  && t.driveFileId);
      const dlThumb = afterMerge.filter(t => !t.thumbKey && t.driveThumbId);
      const dlTotal = dlAudio.length + dlThumb.length;
      let dlDone = 0;

      if (dlTotal > 0) {
        _prog(78, `ダウンロード中 (0/${dlTotal})...`);
        await Promise.allSettled([
          _parallelLimit(dlAudio, 4, async t => {
            await _pullAudio(t); dlDone++;
            _prog(78 + (dlDone / dlTotal) * 12, `ダウンロード中 (${dlDone}/${dlTotal})...`);
          }),
          _parallelLimit(dlThumb, 4, async t => {
            await _pullThumb(t); dlDone++;
          }),
        ]);
      }

      // Step 7: index を更新
      _prog(92, 'インデックスを更新中...');
      await _pushIndex();
      await Storage.setMeta('deletedTrackIds', []);

      _prog(100, '同期完了');
      _progDone();
      UI.toast('同期が完了しました', 'success');
      if (typeof App !== 'undefined') await App.refreshAll();

    } catch (err) {
      console.error('[Drive] Sync error:', err);
      _progDone();
      UI.toast('同期エラー: ' + (err.message || '不明'), 'error');
    } finally {
      _syncing = false;
    }
  }

  /* ─────────────────────────────────────────
     トラック追加時：即時アップロード
  ───────────────────────────────────────── */
  async function onTrackAdded(track) {
    if (!isLoggedIn()) return;
    try {
      await _ensureFolders();
      // 音声・サムネイルを並列アップロード後、indexを更新
      await Promise.allSettled([
        _pushAudio(track),
        track.thumbKey ? _pushThumb(track) : Promise.resolve(),
      ]);
      await _pushIndex();
    } catch (e) { console.warn('[Drive] onTrackAdded failed:', e); }
  }

  /* ─────────────────────────────────────────
     トラック削除時：即時伝播
  ───────────────────────────────────────── */
  async function onTrackDeleted(trackId, track) {
    // 削除IDを記録
    const arr = await Storage.getMeta('deletedTrackIds', []);
    if (!arr.includes(trackId)) { arr.push(trackId); await Storage.setMeta('deletedTrackIds', arr); }
    if (!isLoggedIn()) return;
    try {
      await _ensureFolders();
      // Drive上のファイル削除 & index更新 を並列
      await Promise.allSettled([
        track?.driveFileId  ? _deleteFile(track.driveFileId)  : Promise.resolve(),
        track?.driveThumbId ? _deleteFile(track.driveThumbId) : Promise.resolve(),
        _pushIndex(),
      ]);
    } catch (e) { console.warn('[Drive] onTrackDeleted failed:', e); }
  }

  /* ─────────────────────────────────────────
     Driveデータ全削除
  ───────────────────────────────────────── */
  async function resetDriveData() {
    if (!isLoggedIn()) return;
    try {
      _prog(5, 'Driveデータを削除中...');
      if (_folderId) await _deleteFile(_folderId);
      _folderId = _audioFolderId = _thumbFolderId = null;
      await Promise.allSettled([
        Storage.deleteMeta('driveFolderId'),
        Storage.deleteMeta('driveAudioFolderId'),
        Storage.deleteMeta('driveThumbFolderId'),
        Storage.deleteMeta('driveIndexFileId'),
      ]);
      _prog(100, '削除完了');
      _progDone();
    } catch (e) {
      console.error('[Drive] resetDriveData error:', e);
      _progDone();
    }
  }

  /* ─────────────────────────────────────────
     公開API
  ───────────────────────────────────────── */
  return {
    init,
    isLoggedIn,
    toggleLogin,
    toggleAutoSync,
    triggerAutoSync,
    scheduleSyncLogs,
    syncNow,
    onTrackAdded,
    onTrackDeleted,
    resetDriveData,
    extractMeta: _extractMeta,
  };

})();
