/**
 * storage.js — IndexedDB wrapper for Sonora
 *
 * Stores:
 *   tracks     — { id, title, artist, dateAdded, releaseDate, tags[], manualOrder, driveFileId, driveThumbId, blobKey }
 *   blobs      — { key, data: ArrayBuffer }  (raw audio / thumbnail binaries)
 *   playlists  — { id, name, desc, trackIds[], createdAt }
 *   tags       — { id, name, color, textColor, order }
 *   logs       — { id, trackId, playedAt, duration }
 *   meta       — { key, value }  (settings, sync state, etc.)
 */

const Storage = (() => {
  const DB_NAME    = 'SonoraDB';
  const DB_VERSION = 1;
  const STORES = ['tracks', 'blobs', 'playlists', 'tags', 'logs', 'meta'];

  let _db = null;

  /* ─────────────────────────────────────────
     INIT
  ───────────────────────────────────────── */
  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('tracks')) {
          const ts = db.createObjectStore('tracks', { keyPath: 'id' });
          ts.createIndex('by_artist',    'artist',     { unique: false });
          ts.createIndex('by_title',     'title',      { unique: false });
          ts.createIndex('by_added',     'dateAdded',  { unique: false });
          ts.createIndex('by_release',   'releaseDate',{ unique: false });
          ts.createIndex('by_order',     'manualOrder',{ unique: false });
        }
        if (!db.objectStoreNames.contains('blobs')) {
          db.createObjectStore('blobs', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('playlists')) {
          const ps = db.createObjectStore('playlists', { keyPath: 'id' });
          ps.createIndex('by_created', 'createdAt', { unique: false });
        }
        if (!db.objectStoreNames.contains('tags')) {
          const tgs = db.createObjectStore('tags', { keyPath: 'id' });
          tgs.createIndex('by_order', 'order', { unique: false });
        }
        if (!db.objectStoreNames.contains('logs')) {
          const ls = db.createObjectStore('logs', { keyPath: 'id' });
          ls.createIndex('by_track',   'trackId',  { unique: false });
          ls.createIndex('by_playedAt','playedAt',  { unique: false });
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }
      };

      req.onsuccess = e => { _db = e.target.result; resolve(_db); };
      req.onerror   = e => reject(e.target.error);
    });
  }

  /* ─────────────────────────────────────────
     LOW-LEVEL HELPERS
  ───────────────────────────────────────── */
  function tx(storeName, mode = 'readonly') {
    return _db.transaction(storeName, mode).objectStore(storeName);
  }
  function txMulti(storeNames, mode = 'readwrite') {
    const t = _db.transaction(storeNames, mode);
    const stores = {};
    storeNames.forEach(s => { stores[s] = t.objectStore(s); });
    return stores;
  }

  function req2p(r) {
    return new Promise((res, rej) => {
      r.onsuccess = e => res(e.target.result);
      r.onerror   = e => rej(e.target.error);
    });
  }

  function getAll(storeName, indexName, query) {
    const store = tx(storeName);
    const src   = indexName ? store.index(indexName) : store;
    return req2p(src.getAll(query));
  }

  function getOne(storeName, key) {
    return req2p(tx(storeName).get(key));
  }

  function put(storeName, obj) {
    return req2p(tx(storeName, 'readwrite').put(obj));
  }

  function del(storeName, key) {
    return req2p(tx(storeName, 'readwrite').delete(key));
  }

  function clearStore(storeName) {
    return req2p(tx(storeName, 'readwrite').clear());
  }

  /* ─────────────────────────────────────────
     ID GENERATOR
  ───────────────────────────────────────── */
  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  /* ─────────────────────────────────────────
     TRACKS
  ───────────────────────────────────────── */
  async function getTracks() {
    return getAll('tracks');
  }

  async function getTrack(id) {
    return getOne('tracks', id);
  }

  async function addTrack(trackData) {
    const existing = await getTracks();
    const maxOrder = existing.reduce((m, t) => Math.max(m, t.manualOrder || 0), 0);
    const track = {
      id:           uid(),
      title:        trackData.title        || '不明なタイトル',
      artist:       trackData.artist       || '不明なアーティスト',
      dateAdded:    Date.now(),
      releaseDate:  trackData.releaseDate  || null,
      tags:         trackData.tags         || [],
      manualOrder:  maxOrder + 1,
      driveFileId:  trackData.driveFileId  || null,
      driveThumbId: trackData.driveThumbId || null,
      blobKey:      trackData.blobKey      || null,
      thumbKey:     trackData.thumbKey     || null,
      duration:     trackData.duration     || 0,
    };
    await put('tracks', track);
    return track;
  }

  async function updateTrack(id, changes) {
    const track = await getTrack(id);
    if (!track) throw new Error('Track not found: ' + id);
    const updated = { ...track, ...changes };
    await put('tracks', updated);
    return updated;
  }

  async function deleteTrack(id) {
    const track = await getTrack(id);
    if (!track) return;
    // Remove from all playlists
    const pls = await getPlaylists();
    for (const pl of pls) {
      if (pl.trackIds.includes(id)) {
        await updatePlaylist(pl.id, { trackIds: pl.trackIds.filter(t => t !== id) });
      }
    }
    // Delete associated blobs
    if (track.blobKey)  await del('blobs', track.blobKey);
    if (track.thumbKey) await del('blobs', track.thumbKey);
    // Delete logs
    const logs = await getAll('logs', 'by_track', id);
    for (const log of logs) await del('logs', log.id);
    // Delete track
    await del('tracks', id);
  }

  async function reorderTracks(orderedIds) {
    const t = _db.transaction('tracks', 'readwrite');
    const store = t.objectStore('tracks');
    return new Promise((resolve, reject) => {
      let i = 0;
      const next = () => {
        if (i >= orderedIds.length) { resolve(); return; }
        const id = orderedIds[i];
        const getReq = store.get(id);
        getReq.onsuccess = e => {
          const track = e.target.result;
          if (track) {
            track.manualOrder = i + 1;
            store.put(track);
          }
          i++;
          next();
        };
        getReq.onerror = e => reject(e.target.error);
      };
      next();
      t.oncomplete = resolve;
      t.onerror = e => reject(e.target.error);
    });
  }

  /* ─────────────────────────────────────────
     BLOBS (audio + thumbnails)
  ───────────────────────────────────────── */
  async function saveBlob(data) {
    const key = 'blob_' + uid();
    await put('blobs', { key, data });
    return key;
  }

  async function getBlob(key) {
    if (!key) return null;
    const rec = await getOne('blobs', key);
    return rec ? rec.data : null;
  }

  async function deleteBlob(key) {
    if (!key) return;
    await del('blobs', key);
  }

  async function getBlobUrl(key) {
    const data = await getBlob(key);
    if (!data) return null;
    const blob = new Blob([data]);
    return URL.createObjectURL(blob);
  }

  async function getAudioBlobUrl(trackId) {
    const track = await getTrack(trackId);
    if (!track || !track.blobKey) return null;
    return getBlobUrl(track.blobKey);
  }

  async function getThumbBlobUrl(trackId) {
    const track = await getTrack(trackId);
    if (!track || !track.thumbKey) return null;
    return getBlobUrl(track.thumbKey);
  }

  /* ─────────────────────────────────────────
     PLAYLISTS
  ───────────────────────────────────────── */
  async function getPlaylists() {
    return getAll('playlists');
  }

  async function getPlaylist(id) {
    return getOne('playlists', id);
  }

  async function createPlaylist(name, desc = '') {
    const pl = {
      id:        uid(),
      name:      name.trim() || '新しいプレイリスト',
      desc,
      trackIds:  [],
      createdAt: Date.now(),
    };
    await put('playlists', pl);
    return pl;
  }

  async function updatePlaylist(id, changes) {
    const pl = await getPlaylist(id);
    if (!pl) throw new Error('Playlist not found: ' + id);
    const updated = { ...pl, ...changes };
    await put('playlists', updated);
    return updated;
  }

  async function deletePlaylist(id) {
    await del('playlists', id);
  }

  async function addTrackToPlaylist(playlistId, trackId) {
    const pl = await getPlaylist(playlistId);
    if (!pl) return;
    if (!pl.trackIds.includes(trackId)) {
      await updatePlaylist(playlistId, { trackIds: [...pl.trackIds, trackId] });
    }
  }

  async function removeTrackFromPlaylist(playlistId, trackId) {
    const pl = await getPlaylist(playlistId);
    if (!pl) return;
    await updatePlaylist(playlistId, { trackIds: pl.trackIds.filter(id => id !== trackId) });
  }

  /* ─────────────────────────────────────────
     TAGS
  ───────────────────────────────────────── */
  async function getTags() {
    const tags = await getAll('tags', 'by_order');
    return tags.sort((a, b) => (a.order || 0) - (b.order || 0));
  }

  async function getTag(id) {
    return getOne('tags', id);
  }

  async function createTag(name, color = '#DBEAFE', textColor = '#1D4ED8') {
    const existing = await getTags();
    const tag = {
      id:        uid(),
      name:      name.trim(),
      color,
      textColor,
      order:     existing.length,
    };
    await put('tags', tag);
    return tag;
  }

  async function updateTag(id, changes) {
    const tag = await getTag(id);
    if (!tag) throw new Error('Tag not found: ' + id);
    const updated = { ...tag, ...changes };
    await put('tags', updated);
    return updated;
  }

  async function deleteTag(id) {
    // Remove from all tracks
    const tracks = await getTracks();
    for (const track of tracks) {
      if (track.tags.includes(id)) {
        await updateTrack(track.id, { tags: track.tags.filter(t => t !== id) });
      }
    }
    await del('tags', id);
  }

  async function reorderTags(orderedIds) {
    for (let i = 0; i < orderedIds.length; i++) {
      const tag = await getTag(orderedIds[i]);
      if (tag) await put('tags', { ...tag, order: i });
    }
  }

  /* ─────────────────────────────────────────
     PLAY LOGS
  ───────────────────────────────────────── */
  async function getLogs() {
    return getAll('logs');
  }

  async function addLog(trackId, duration = 0) {
    const log = {
      id:       uid(),
      trackId,
      playedAt: Date.now(),
      duration, // seconds actually played
    };
    await put('logs', log);
    return log;
  }

  async function deleteLogsByTrack(trackId) {
    const logs = await getAll('logs', 'by_track', trackId);
    for (const log of logs) await del('logs', log.id);
  }

  /* ─────────────────────────────────────────
     META / SETTINGS
  ───────────────────────────────────────── */
  async function getMeta(key, fallback = null) {
    const rec = await getOne('meta', key);
    return rec ? rec.value : fallback;
  }

  async function setMeta(key, value) {
    await put('meta', { key, value });
  }

  async function deleteMeta(key) {
    await del('meta', key);
  }

  /* ─────────────────────────────────────────
     EXPORT SNAPSHOT (for Drive sync)
  ───────────────────────────────────────── */
  async function exportSnapshot() {
    const [tracks, playlists, tags, logs] = await Promise.all([
      getTracks(),
      getPlaylists(),
      getTags(),
      getLogs(),
    ]);
    return {
      version:   1,
      exportedAt: Date.now(),
      tracks:    tracks.map(t => {
        const { blobKey, thumbKey, ...rest } = t; // don't include local blob keys
        return rest;
      }),
      playlists,
      tags,
      logs,
    };
  }

  async function importSnapshot(snapshot) {
    if (!snapshot || snapshot.version !== 1) return;
    // Merge tracks (by id)
    for (const t of snapshot.tracks || []) {
      const existing = await getTrack(t.id);
      if (!existing) {
        await put('tracks', { ...t, blobKey: null, thumbKey: null });
      }
    }
    // Merge playlists
    for (const pl of snapshot.playlists || []) {
      const existing = await getPlaylist(pl.id);
      if (!existing) await put('playlists', pl);
      else {
        // merge trackIds
        const merged = [...new Set([...existing.trackIds, ...pl.trackIds])];
        await put('playlists', { ...existing, trackIds: merged });
      }
    }
    // Merge tags
    for (const tag of snapshot.tags || []) {
      const existing = await getTag(tag.id);
      if (!existing) await put('tags', tag);
    }
    // Append logs (dedup by id)
    const existingLogs = await getLogs();
    const existingIds = new Set(existingLogs.map(l => l.id));
    for (const log of snapshot.logs || []) {
      if (!existingIds.has(log.id)) await put('logs', log);
    }
  }

  /* ─────────────────────────────────────────
     FULL RESET
  ───────────────────────────────────────── */
  async function resetAll() {
    for (const store of STORES) {
      await clearStore(store);
    }
  }

  async function resetLocalOnly() {
    // Clears audio/thumb blobs and resets blobKey/thumbKey on tracks
    await clearStore('blobs');
    const tracks = await getTracks();
    for (const t of tracks) {
      await put('tracks', { ...t, blobKey: null, thumbKey: null });
    }
  }

  /* ─────────────────────────────────────────
     AUDIO METADATA READER (from File)
  ───────────────────────────────────────── */
  async function readAudioMeta(file) {
    // Drive.extractMeta が利用可能なら ID3パース優先
    if (typeof Drive !== 'undefined' && Drive.extractMeta) {
      try {
        const buf  = await file.arrayBuffer();
        const meta = await Drive.extractMeta(buf, file.name);
        // 再生時間はaudio elementで取得
        const duration = await _probeDuration(file);
        return { ...meta, duration };
      } catch { /* fallback below */ }
    }
    // フォールバック：ファイル名パース + audio element duration
    const baseName  = file.name.replace(/\.[^.]+$/, '');
    let title  = baseName;
    let artist = '';
    const dashMatch = baseName.match(/^(.+?)\s+-\s+(.+)$/);
    if (dashMatch) { artist = dashMatch[1].trim(); title = dashMatch[2].trim(); }
    const duration = await _probeDuration(file);
    return { title, artist, duration };
  }

  function _probeDuration(file) {
    return new Promise(resolve => {
      const el  = document.createElement('audio');
      const url = URL.createObjectURL(file);
      el.src     = url;
      el.preload = 'metadata';
      el.onloadedmetadata = () => { URL.revokeObjectURL(url); resolve(el.duration || 0); };
      el.onerror          = () => { URL.revokeObjectURL(url); resolve(0); };
    });
  }

  /* ─────────────────────────────────────────
     PUBLIC API
  ───────────────────────────────────────── */
  return {
    open,
    uid,

    // Tracks
    getTracks,
    getTrack,
    addTrack,
    updateTrack,
    deleteTrack,
    reorderTracks,

    // Blobs
    saveBlob,
    getBlob,
    deleteBlob,
    getBlobUrl,
    getAudioBlobUrl,
    getThumbBlobUrl,

    // Playlists
    getPlaylists,
    getPlaylist,
    createPlaylist,
    updatePlaylist,
    deletePlaylist,
    addTrackToPlaylist,
    removeTrackFromPlaylist,

    // Tags
    getTags,
    getTag,
    createTag,
    updateTag,
    deleteTag,
    reorderTags,

    // Logs
    getLogs,
    addLog,
    deleteLogsByTrack,

    // Meta
    getMeta,
    setMeta,
    deleteMeta,

    // Snapshot
    exportSnapshot,
    importSnapshot,

    // Reset
    resetAll,
    resetLocalOnly,

    // Utilities
    readAudioMeta,
  };
})();
