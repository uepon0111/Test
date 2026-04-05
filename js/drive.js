/**
 * drive.js — Google Drive integration for Sonora
 *
 * Folder layout:
 *   Sonora/
 *     sonora_index.json   ← snapshot + deletedIds
 *     audio/
 *       <trackId>.<ext>   ← audio files
 *     thumbs/
 *       <trackId>.jpg     ← thumbnails
 *
 * Sync is split into parallel phases for speed:
 *   Phase A (parallel): pull index + list audio dir + list thumbs dir
 *   Phase B: compute diff (fast, local only)
 *   Phase C (parallel): upload new audio + upload new thumbs + download missing audio
 *   Phase D: push updated index
 */

const Drive = (() => {

  /* ─────────────────────────────────────────
     CONFIG  ← Replace CLIENT_ID before deploy
  ───────────────────────────────────────── */
  const CLIENT_ID   = 'YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com';
  const SCOPES      = 'https://www.googleapis.com/auth/drive.file openid email profile';
  const FOLDER_NAME = 'Sonora';
  const INDEX_FILE  = 'sonora_index.json';
  const AUDIO_EXTS  = ['.mp3','.m4a','.wav','.flac','.ogg'];

  /* ─────────────────────────────────────────
     STATE
  ───────────────────────────────────────── */
  let _token       = null;
  let _userEmail   = null;
  let _tokenClient = null;
  let _autoSync    = false;
  let _syncBusy    = false;
  let _autoTimer   = null;
  let _debounce    = null;
  let _logTimer    = null;

  // Cached folder IDs
  let _fid  = null;   // root
  let _afid = null;   // audio
  let _tfid = null;   // thumbs

  /* ─────────────────────────────────────────
     PROGRESS
  ───────────────────────────────────────── */
  function _prog(pct, detail) {
    const wrap = document.getElementById('sync-progress-wrap');
    const fill = document.getElementById('sync-bar-fill');
    const det  = document.getElementById('sync-detail-txt');
    const pctEl= document.getElementById('sync-pct-txt');
    if (wrap)  wrap.classList.add('visible');
    if (fill)  fill.style.width = Math.min(100,pct) + '%';
    if (det)   det.textContent  = detail;
    if (pctEl) pctEl.textContent= Math.round(pct) + '%';
  }
  function _progDone() {
    setTimeout(() => {
      const w = document.getElementById('sync-progress-wrap');
      const f = document.getElementById('sync-bar-fill');
      if (w) w.classList.remove('visible');
      if (f) f.style.width = '0%';
    }, 2000);
  }

  /* ─────────────────────────────────────────
     CONCURRENCY HELPER  (run N at a time)
  ───────────────────────────────────────── */
  async function _parallel(items, fn, limit=3) {
    const queue = [...items];
    const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
      while (queue.length) {
        const item = queue.shift();
        try { await fn(item); } catch (e) { console.warn('parallel task failed:', e); }
      }
    });
    await Promise.all(workers);
  }

  /* ─────────────────────────────────────────
     AUTH
  ───────────────────────────────────────── */
  function init() {
    const check = setInterval(() => {
      if (typeof google !== 'undefined' && google.accounts?.oauth2) {
        clearInterval(check);
        _tokenClient = google.accounts.oauth2.initTokenClient({
          client_id: CLIENT_ID,
          scope:     SCOPES,
          callback:  _onToken,
        });
      }
    }, 300);

    // Restore saved token
    Storage.getMeta('driveToken').then(tok => {
      if (tok?.expiry > Date.now()) {
        _token     = tok.token;
        _userEmail = tok.email || null;
        _updateLoginUI(true);
      }
    });

    // Restore auto-sync
    Storage.getMeta('autoSync', false).then(v => {
      _autoSync = v;
      const t = document.getElementById('auto-sync-toggle');
      if (t && v) t.classList.add('on');
    });
  }

  async function _onToken(resp) {
    if (resp.error) { UI?.toast('Googleログインに失敗しました','error'); return; }
    _token = resp.access_token;
    const expiry = Date.now() + (resp.expires_in - 60) * 1000;

    // Fetch email
    try {
      const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo',
        { headers: { Authorization: 'Bearer ' + _token } });
      const d = await r.json();
      _userEmail = d.email || null;
    } catch {}

    await Storage.setMeta('driveToken', { token:_token, expiry, email:_userEmail });
    _updateLoginUI(true);
    UI?.toast('Googleアカウントでログインしました');
    syncNow();
  }

  function toggleLogin() { _token ? _logout() : _login(); }

  function _login() {
    if (!_tokenClient) { UI?.toast('Google認証の読み込み中です','error'); return; }
    _tokenClient.requestAccessToken({ prompt:'consent' });
  }

  function _logout() {
    if (_token && typeof google !== 'undefined')
      google.accounts.oauth2.revoke(_token, () => {});
    _token = null; _userEmail = null; _fid = null; _afid = null; _tfid = null;
    Storage.deleteMeta('driveToken');
    Storage.deleteMeta('driveFolderId');
    Storage.deleteMeta('driveAudioFolderId');
    Storage.deleteMeta('driveThumbFolderId');
    Storage.deleteMeta('driveIndexFileId');
    _updateLoginUI(false);
    UI?.toast('ログアウトしました');
  }

  const isLoggedIn = () => !!_token;

  function _updateLoginUI(on) {
    const txt  = document.getElementById('settings-login-txt');
    const row  = document.getElementById('account-info-row');
    const mail = document.getElementById('account-email');
    const sbtn = document.getElementById('sync-now-btn');
    if (txt)  txt.textContent  = on ? 'ログアウト' : 'ログイン';
    if (row)  row.style.display= on ? 'flex' : 'none';
    if (mail && _userEmail) mail.textContent = _userEmail;
    if (sbtn) sbtn.disabled = !on;
  }

  /* ─────────────────────────────────────────
     AUTO SYNC
  ───────────────────────────────────────── */
  function toggleAutoSync(btn) {
    _autoSync = !_autoSync;
    btn.classList.toggle('on', _autoSync);
    Storage.setMeta('autoSync', _autoSync);
    if (_autoSync && _token) _scheduleAuto();
    else clearTimeout(_autoTimer);
    UI?.toast(_autoSync ? '自動同期オン' : '自動同期オフ');
  }

  function _scheduleAuto() {
    clearTimeout(_autoTimer);
    _autoTimer = setTimeout(() => { if (_autoSync && _token) syncNow().then(_scheduleAuto); }, 5*60*1000);
  }

  /** Debounced trigger after local changes */
  function triggerAutoSync() {
    if (!_autoSync || !_token) return;
    clearTimeout(_debounce);
    _debounce = setTimeout(() => syncNow(), 4000);
  }

  /** Lightweight log sync (just push index) */
  function scheduleSyncLogs() {
    clearTimeout(_logTimer);
    _logTimer = setTimeout(() => { if (_token) _pushIndex().catch(()=>{}); }, 15000);
  }

  /* ─────────────────────────────────────────
     DRIVE API HELPERS
  ───────────────────────────────────────── */
  async function _api(method, url, body, ct) {
    if (!_token) throw new Error('Not authenticated');
    const headers = { Authorization: 'Bearer ' + _token };
    if (ct) headers['Content-Type'] = ct;
    const res = await fetch(url, { method, headers, body });
    if (res.status === 401) {
      _token = null; Storage.deleteMeta('driveToken'); _updateLoginUI(false);
      throw new Error('Token expired');
    }
    if (!res.ok) throw new Error(`Drive ${res.status}: ` + await res.text());
    const ctype = res.headers.get('content-type') || '';
    return ctype.includes('application/json') ? res.json() : res.arrayBuffer();
  }

  async function _list(params) {
    const qs = new URLSearchParams(params).toString();
    return _api('GET', `https://www.googleapis.com/drive/v3/files?${qs}`);
  }

  async function _createFolder(name, parentId) {
    return _api('POST',
      'https://www.googleapis.com/drive/v3/files?fields=id,name',
      JSON.stringify({ name, mimeType:'application/vnd.google-apps.folder', parents: parentId ? [parentId] : [] }),
      'application/json');
  }

  async function _upload(name, mime, data, parentId, existingId) {
    const metaBlob = new Blob([JSON.stringify({ name, parents: existingId ? undefined : (parentId ? [parentId] : []) })],
                              { type:'application/json' });
    const fileBlob = data instanceof Blob ? data : new Blob([data], { type: mime });
    const form = new FormData();
    form.append('metadata', metaBlob);
    form.append('file', fileBlob, name);
    const url = existingId
      ? `https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=multipart&fields=id,name`
      : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name`;
    return _api(existingId ? 'PATCH' : 'POST', url, form);
  }

  const _download   = id => _api('GET', `https://www.googleapis.com/drive/v3/files/${id}?alt=media`);
  const _deleteFile = id => fetch(`https://www.googleapis.com/drive/v3/files/${id}`,
    { method:'DELETE', headers:{ Authorization:'Bearer '+_token } });

  /* ─────────────────────────────────────────
     FOLDER SETUP  (idempotent, cached)
  ───────────────────────────────────────── */
  async function _folders() {
    // Root
    if (!_fid) _fid = await Storage.getMeta('driveFolderId');
    if (!_fid) {
      const r = await _list({ q:`name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`, fields:'files(id)' });
      _fid = r.files?.[0]?.id || (await _createFolder(FOLDER_NAME)).id;
      await Storage.setMeta('driveFolderId', _fid);
    }
    // Sub-folders in parallel
    const [af, tf] = await Promise.all([
      _ensureSubFolder('audio', 'driveAudioFolderId', _afid),
      _ensureSubFolder('thumbs','driveThumbFolderId', _tfid),
    ]);
    _afid = af; _tfid = tf;
  }

  async function _ensureSubFolder(name, metaKey, cached) {
    if (cached) return cached;
    let id = await Storage.getMeta(metaKey);
    if (!id) {
      const r = await _list({ q:`name='${name}' and mimeType='application/vnd.google-apps.folder' and '${_fid}' in parents and trashed=false`, fields:'files(id)' });
      id = r.files?.[0]?.id || (await _createFolder(name, _fid)).id;
      await Storage.setMeta(metaKey, id);
    }
    return id;
  }

  /* ─────────────────────────────────────────
     INDEX (sonora_index.json)
  ───────────────────────────────────────── */
  async function _indexFileId() {
    let id = await Storage.getMeta('driveIndexFileId');
    if (id) return id;
    const r = await _list({ q:`name='${INDEX_FILE}' and '${_fid}' in parents and trashed=false`, fields:'files(id)' });
    if (r.files?.[0]?.id) { id = r.files[0].id; await Storage.setMeta('driveIndexFileId', id); }
    return id || null;
  }

  async function _pushIndex() {
    await _folders();
    const snap       = await Storage.exportSnapshot();
    const deletedIds = await Storage.getMeta('deletedTrackIds', []);
    snap.deletedIds  = deletedIds;
    const blob       = new Blob([JSON.stringify(snap)], { type:'application/json' });
    const existing   = await _indexFileId();
    const r = await _upload(INDEX_FILE, 'application/json', blob, _fid, existing);
    if (r?.id) await Storage.setMeta('driveIndexFileId', r.id);
  }

  async function _pullIndex() {
    const id = await _indexFileId();
    if (!id) return null;
    try {
      const buf  = await _download(id);
      return JSON.parse(new TextDecoder().decode(buf));
    } catch { return null; }
  }

  /* ─────────────────────────────────────────
     AUDIO / THUMB UPLOAD
  ───────────────────────────────────────── */
  function _guessAudioMime(trackId, blobKey) {
    return 'audio/mpeg'; // default; Drive accepts it for all audio
  }

  async function _uploadAudio(track) {
    if (!track.blobKey) return;
    const buf = await Storage.getBlob(track.blobKey);
    if (!buf) return;
    const ext  = '.mp3';
    const name = track.id + ext;
    const r    = await _upload(name, 'audio/mpeg', buf, _afid, track.driveFileId || null);
    if (r?.id) await Storage.updateTrack(track.id, { driveFileId: r.id });
  }

  async function _uploadThumb(track) {
    if (!track.thumbKey) return;
    const buf = await Storage.getBlob(track.thumbKey);
    if (!buf) return;
    const r = await _upload(track.id+'.jpg','image/jpeg', buf, _tfid, track.driveThumbId||null);
    if (r?.id) await Storage.updateTrack(track.id, { driveThumbId: r.id });
  }

  async function _downloadAudio(track) {
    if (!track.driveFileId) return false;
    try {
      const buf = await _download(track.driveFileId);
      const key = await Storage.saveBlob(buf);
      await Storage.updateTrack(track.id, { blobKey: key });
      return true;
    } catch { return false; }
  }

  async function _downloadThumb(track) {
    if (!track.driveThumbId) return false;
    try {
      const buf = await _download(track.driveThumbId);
      const key = await Storage.saveBlob(buf);
      await Storage.updateTrack(track.id, { thumbKey: key });
      return true;
    } catch { return false; }
  }

  /* ─────────────────────────────────────────
     EXTRACT METADATA FROM DRIVE FILE
     (for files uploaded directly to Drive)
  ───────────────────────────────────────── */
  async function _extractDriveMeta(driveFileId, fileName) {
    // Download first 256KB for ID3 parsing
    try {
      const full = await _download(driveFileId);
      const slice = full.slice ? full.slice(0, 256*1024) : full;
      const meta = Storage.parseAudioMetaFromBuffer(slice, fileName);

      // Get duration via Audio element
      const blob = new Blob([full]);
      const url  = URL.createObjectURL(blob);
      const dur  = await new Promise(resolve => {
        const a = document.createElement('audio');
        a.src = url; a.preload = 'metadata';
        a.onloadedmetadata = () => { URL.revokeObjectURL(url); resolve(a.duration||0); };
        a.onerror          = () => { URL.revokeObjectURL(url); resolve(0); };
      });
      return { ...meta, duration: dur, rawBuffer: full };
    } catch {
      // Fallback: filename only
      const base = (fileName||'').replace(/\.[^.]+$/,'');
      const dash = base.match(/^(.+?)\s+-\s+(.+)$/);
      return { title: dash?dash[2].trim():base, artist: dash?dash[1].trim():'', duration:0, rawBuffer:null };
    }
  }

  /* ─────────────────────────────────────────
     DETECT DRIVE-DIRECT CHANGES
  ───────────────────────────────────────── */
  /**
   * Returns:
   *   added   — files present in Drive audio/ but no matching local track by driveFileId
   *   deleted — local tracks whose driveFileId is no longer in Drive audio/
   */
  async function _diffDriveAudio() {
    const r = await _list({
      q:      `'${_afid}' in parents and trashed=false`,
      fields: 'files(id,name,modifiedTime)',
      pageSize: 1000,
    }).catch(() => ({ files:[] }));

    const driveFiles  = r.files || [];
    const driveIdSet  = new Set(driveFiles.map(f => f.id));
    const driveByName = Object.fromEntries(driveFiles.map(f => [f.name, f]));

    const localTracks = await Storage.getTracks();
    const localByDriveId = Object.fromEntries(
      localTracks.filter(t => t.driveFileId).map(t => [t.driveFileId, t])
    );

    // Drive-direct DELETED: local track has driveFileId that no longer exists in Drive
    const deleted = localTracks.filter(t => t.driveFileId && !driveIdSet.has(t.driveFileId));

    // Drive-direct ADDED: drive files not associated with any local track
    const localDriveIds = new Set(localTracks.map(t => t.driveFileId).filter(Boolean));
    const added = driveFiles.filter(f => {
      if (localDriveIds.has(f.id)) return false;
      // Also check if we might have this track by matching id in filename
      const baseName = f.name.replace(/\.[^.]+$/,'');
      return !localTracks.find(t => t.id === baseName);
    });

    return { added, deleted };
  }

  async function _diffDriveThumbs() {
    const r = await _list({
      q:      `'${_tfid}' in parents and trashed=false`,
      fields: 'files(id,name)',
      pageSize: 1000,
    }).catch(() => ({ files:[] }));
    return new Set((r.files||[]).map(f => f.id));
  }

  /* ─────────────────────────────────────────
     MAIN SYNC  (parallel phases)
  ───────────────────────────────────────── */
  async function syncNow() {
    if (!_token) { UI?.toast('ログインしてから同期してください','error'); return; }
    if (_syncBusy) return;
    _syncBusy = true;

    try {
      _prog(5,'フォルダを確認中...');
      await _folders();

      /* ── Phase A (parallel): fetch remote data ── */
      _prog(10,'リモートデータを取得中...');
      const [remoteIndex, driveAudioDiff] = await Promise.all([
        _pullIndex(),
        _diffDriveAudio(),
      ]);

      /* ── Phase B: compute diffs (local, fast) ── */
      _prog(25,'差分を計算中...');

      const localTracks  = await Storage.getTracks();
      const localIds     = new Set(localTracks.map(t => t.id));
      const remoteIds    = new Set((remoteIndex?.tracks||[]).map(t => t.id));
      const remoteDelIds = new Set(remoteIndex?.deletedIds||[]);
      const localDelIds  = new Set(await Storage.getMeta('deletedTrackIds',[]));

      // 1. Apply remote-side deletions (from deletedIds in remote index)
      for (const id of remoteDelIds) {
        if (localIds.has(id) && !localDelIds.has(id)) {
          await Storage.deleteTrack(id);
        }
      }

      // 2. Apply Drive-direct deletions
      for (const track of driveAudioDiff.deleted) {
        // Mark as deleted so other devices propagate too
        await _recordDeletion(track.id);
        await Storage.deleteTrack(track.id);
      }

      // 3. Merge remote tracks (new tracks from other devices)
      if (remoteIndex) await Storage.importSnapshot(remoteIndex);

      /* ── Phase C (parallel): I/O operations ── */
      _prog(35,'ファイルを同期中...');

      // Re-fetch updated local tracks after merge
      const mergedTracks = await Storage.getTracks();

      // Tracks to upload (have local blob but no driveFileId)
      const toUpload     = mergedTracks.filter(t => t.blobKey  && !t.driveFileId);
      // Tracks to download audio (have driveFileId but no local blob)
      const toDownload   = mergedTracks.filter(t => !t.blobKey && t.driveFileId);
      // Tracks to upload thumbnail
      const toUpThumb    = mergedTracks.filter(t => t.thumbKey && !t.driveThumbId);
      // Tracks to download thumbnail
      const toDownThumb  = mergedTracks.filter(t => !t.thumbKey && t.driveThumbId);

      const total = toUpload.length + toDownload.length + toUpThumb.length + toDownThumb.length
                  + driveAudioDiff.added.length;
      let done = 0;
      const tick = () => { done++; _prog(35 + (done/Math.max(total,1))*45, '同期中...'); };

      // Run uploads and downloads concurrently (3 workers each category)
      await Promise.all([
        _parallel(toUpload,   async t => { await _uploadAudio(t);  tick(); }, 3),
        _parallel(toDownload, async t => { await _downloadAudio(t); tick(); }, 3),
        _parallel(toUpThumb,  async t => { await _uploadThumb(t);  tick(); }, 3),
        _parallel(toDownThumb,async t => { await _downloadThumb(t);tick(); }, 3),
      ]);

      /* ── Phase C2: Handle Drive-direct ADDED files ── */
      _prog(80,'新規ファイルを取り込み中...');
      for (const driveFile of driveAudioDiff.added) {
        await _importDriveFile(driveFile);
        tick();
      }

      /* ── Phase D: push updated index ── */
      _prog(93,'インデックスを保存中...');
      await _pushIndex();
      await Storage.setMeta('deletedTrackIds',[]);  // clear after push

      _prog(100,'同期完了');
      _progDone();
      UI?.toast('同期が完了しました','success');
      if (typeof App !== 'undefined') App.refreshAll();

    } catch (err) {
      console.error('Sync error:', err);
      _progDone();
      UI?.toast('同期エラー: ' + (err.message||'不明'), 'error');
    } finally {
      _syncBusy = false;
    }
  }

  /* ─────────────────────────────────────────
     IMPORT A DRIVE-DIRECT ADDED FILE
  ───────────────────────────────────────── */
  async function _importDriveFile(driveFile) {
    // Extract metadata (downloads the file, parses ID3)
    const meta = await _extractDriveMeta(driveFile.id, driveFile.name);

    // Save audio blob
    let blobKey  = null;
    let thumbKey = null;

    if (meta.rawBuffer) {
      blobKey = await Storage.saveBlob(meta.rawBuffer);
    }

    // Save embedded cover art if found
    if (meta.thumbData) {
      thumbKey = await Storage.saveBlob(meta.thumbData);
    }

    // Try to find matching thumb in Drive thumbs folder
    if (!thumbKey) {
      // Check thumbs/ folder for <trackId>.jpg  (won't have one for direct uploads)
      // Skip for now — user can add thumb via edit UI
    }

    // Create track
    const trackIdFromName = driveFile.name.replace(/\.[^.]+$/,'');
    // Use filename as ID if it looks like one of ours, else generate new
    const isOurId = /^[a-z0-9]{8,}$/.test(trackIdFromName);

    await Storage.addTrack({
      id:          isOurId ? trackIdFromName : undefined,
      title:       meta.title   || driveFile.name,
      artist:      meta.artist  || '',
      releaseDate: meta.releaseDate || null,
      duration:    meta.duration || 0,
      blobKey,
      thumbKey,
      driveFileId: driveFile.id,
      dateAdded:   new Date(driveFile.modifiedTime||Date.now()).getTime(),
    });
  }

  /* ─────────────────────────────────────────
     ON TRACK ADDED (immediate upload)
  ───────────────────────────────────────── */
  async function onTrackAdded(track) {
    if (!_token) return;
    try {
      await _folders();
      await _uploadAudio(track);
      if (track.thumbKey) await _uploadThumb(track);
      await _pushIndex();
    } catch (e) {
      console.warn('onTrackAdded push failed:', e);
    }
  }

  /* ─────────────────────────────────────────
     ON TRACK DELETED — record deletion + push index
  ───────────────────────────────────────── */
  async function onTrackDeleted(trackId) {
    await _recordDeletion(trackId);
    if (_token) {
      // Push index so other devices see deletion ASAP
      _pushIndex().catch(()=>{});
    }
  }

  async function _recordDeletion(trackId) {
    const existing = await Storage.getMeta('deletedTrackIds',[]);
    if (!existing.includes(trackId)) {
      existing.push(trackId);
      await Storage.setMeta('deletedTrackIds', existing);
    }
  }

  /* ─────────────────────────────────────────
     FULL DRIVE RESET
  ───────────────────────────────────────── */
  async function resetDriveData() {
    if (!_token) return;
    _prog(5,'Driveデータを削除中...');
    if (_fid) { await _deleteFile(_fid).catch(()=>{}); }
    _fid = null; _afid = null; _tfid = null;
    await Promise.all([
      Storage.deleteMeta('driveFolderId'),
      Storage.deleteMeta('driveAudioFolderId'),
      Storage.deleteMeta('driveThumbFolderId'),
      Storage.deleteMeta('driveIndexFileId'),
    ]);
    _prog(100,'削除完了');
    _progDone();
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
    onTrackAdded,
    onTrackDeleted,
    resetDriveData,
  };
})();
