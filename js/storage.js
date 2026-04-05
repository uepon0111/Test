/**
 * storage.js — IndexedDB wrapper + metadata utilities for Sonora
 */

const Storage = (() => {
  const DB_NAME    = 'SonoraDB';
  const DB_VERSION = 1;
  const STORES = ['tracks','blobs','playlists','tags','logs','meta'];
  let _db = null;

  /* ─── OPEN ─── */
  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('tracks')) {
          const ts = db.createObjectStore('tracks', { keyPath:'id' });
          ts.createIndex('by_artist',  'artist',      { unique:false });
          ts.createIndex('by_title',   'title',       { unique:false });
          ts.createIndex('by_added',   'dateAdded',   { unique:false });
          ts.createIndex('by_release', 'releaseDate', { unique:false });
          ts.createIndex('by_order',   'manualOrder', { unique:false });
        }
        if (!db.objectStoreNames.contains('blobs'))
          db.createObjectStore('blobs', { keyPath:'key' });
        if (!db.objectStoreNames.contains('playlists')) {
          const ps = db.createObjectStore('playlists', { keyPath:'id' });
          ps.createIndex('by_created','createdAt',{ unique:false });
        }
        if (!db.objectStoreNames.contains('tags')) {
          const tgs = db.createObjectStore('tags', { keyPath:'id' });
          tgs.createIndex('by_order','order',{ unique:false });
        }
        if (!db.objectStoreNames.contains('logs')) {
          const ls = db.createObjectStore('logs', { keyPath:'id' });
          ls.createIndex('by_track',   'trackId',  { unique:false });
          ls.createIndex('by_playedAt','playedAt', { unique:false });
        }
        if (!db.objectStoreNames.contains('meta'))
          db.createObjectStore('meta', { keyPath:'key' });
      };
      req.onsuccess = e => { _db = e.target.result; resolve(_db); };
      req.onerror   = e => reject(e.target.error);
    });
  }

  /* ─── LOW-LEVEL ─── */
  function tx(s, mode='readonly') { return _db.transaction(s, mode).objectStore(s); }
  function req2p(r) {
    return new Promise((res,rej) => {
      r.onsuccess = e => res(e.target.result);
      r.onerror   = e => rej(e.target.error);
    });
  }
  function getAll(s, idx, q) {
    const store = tx(s);
    return req2p((idx ? store.index(idx) : store).getAll(q));
  }
  const getOne     = (s, k)   => req2p(tx(s).get(k));
  const put        = (s, obj) => req2p(tx(s,'readwrite').put(obj));
  const del        = (s, k)   => req2p(tx(s,'readwrite').delete(k));
  const clearStore = (s)      => req2p(tx(s,'readwrite').clear());
  const uid        = ()       => Date.now().toString(36) + Math.random().toString(36).slice(2,7);

  /* ─── TRACKS ─── */
  const getTracks  = () => getAll('tracks');
  const getTrack   = id => getOne('tracks', id);

  async function addTrack(data) {
    const existing = await getTracks();
    const maxOrder = existing.reduce((m,t) => Math.max(m, t.manualOrder||0), 0);
    const track = {
      id:           data.id           || uid(),
      title:        data.title        || '不明なタイトル',
      artist:       data.artist       || '不明なアーティスト',
      dateAdded:    data.dateAdded    || Date.now(),
      releaseDate:  data.releaseDate  || null,
      tags:         data.tags         || [],
      manualOrder:  data.manualOrder  || (maxOrder + 1),
      driveFileId:  data.driveFileId  || null,
      driveThumbId: data.driveThumbId || null,
      blobKey:      data.blobKey      || null,
      thumbKey:     data.thumbKey     || null,
      duration:     data.duration     || 0,
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
    // Remove from playlists
    const pls = await getPlaylists();
    for (const pl of pls)
      if (pl.trackIds.includes(id))
        await updatePlaylist(pl.id, { trackIds: pl.trackIds.filter(t => t !== id) });
    // Delete blobs
    if (track.blobKey)  await del('blobs', track.blobKey);
    if (track.thumbKey) await del('blobs', track.thumbKey);
    // Delete logs
    const logs = await getAll('logs','by_track', id);
    for (const l of logs) await del('logs', l.id);
    await del('tracks', id);
  }

  async function reorderTracks(orderedIds) {
    const t = _db.transaction('tracks','readwrite');
    const store = t.objectStore('tracks');
    return new Promise((resolve, reject) => {
      let i = 0;
      const next = () => {
        if (i >= orderedIds.length) { resolve(); return; }
        const r = store.get(orderedIds[i]);
        r.onsuccess = e => {
          const track = e.target.result;
          if (track) { track.manualOrder = i+1; store.put(track); }
          i++; next();
        };
        r.onerror = e => reject(e.target.error);
      };
      next();
      t.oncomplete = resolve;
      t.onerror    = e => reject(e.target.error);
    });
  }

  /* ─── BLOBS ─── */
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
  const deleteBlob = key => key ? del('blobs', key) : Promise.resolve();
  async function getBlobUrl(key) {
    const data = await getBlob(key);
    return data ? URL.createObjectURL(new Blob([data])) : null;
  }
  async function getAudioBlobUrl(trackId) {
    const t = await getTrack(trackId);
    return t?.blobKey ? getBlobUrl(t.blobKey) : null;
  }

  /* ─── PLAYLISTS ─── */
  const getPlaylists  = ()  => getAll('playlists');
  const getPlaylist   = id  => getOne('playlists', id);
  async function createPlaylist(name, desc='') {
    const pl = { id:uid(), name:name.trim()||'新しいプレイリスト', desc, trackIds:[], createdAt:Date.now() };
    await put('playlists', pl); return pl;
  }
  async function updatePlaylist(id, changes) {
    const pl = await getPlaylist(id);
    if (!pl) throw new Error('Playlist not found: ' + id);
    const updated = { ...pl, ...changes };
    await put('playlists', updated); return updated;
  }
  const deletePlaylist = id => del('playlists', id);
  async function addTrackToPlaylist(pid, tid) {
    const pl = await getPlaylist(pid);
    if (!pl || pl.trackIds.includes(tid)) return;
    await updatePlaylist(pid, { trackIds:[...pl.trackIds, tid] });
  }
  async function removeTrackFromPlaylist(pid, tid) {
    const pl = await getPlaylist(pid);
    if (!pl) return;
    await updatePlaylist(pid, { trackIds: pl.trackIds.filter(id => id !== tid) });
  }

  /* ─── TAGS ─── */
  async function getTags() {
    const tags = await getAll('tags','by_order');
    return tags.sort((a,b) => (a.order||0)-(b.order||0));
  }
  const getTag = id => getOne('tags', id);
  async function createTag(name, color='#DBEAFE', textColor='#1D4ED8') {
    const existing = await getTags();
    const tag = { id:uid(), name:name.trim(), color, textColor, order:existing.length };
    await put('tags', tag); return tag;
  }
  async function updateTag(id, changes) {
    const tag = await getTag(id);
    if (!tag) throw new Error('Tag not found: ' + id);
    const updated = { ...tag, ...changes };
    await put('tags', updated); return updated;
  }
  async function deleteTag(id) {
    const tracks = await getTracks();
    for (const t of tracks)
      if ((t.tags||[]).includes(id))
        await updateTrack(t.id, { tags: t.tags.filter(g => g !== id) });
    await del('tags', id);
  }
  async function reorderTags(orderedIds) {
    for (let i=0; i<orderedIds.length; i++) {
      const tag = await getTag(orderedIds[i]);
      if (tag) await put('tags', { ...tag, order:i });
    }
  }

  /* ─── LOGS ─── */
  const getLogs = () => getAll('logs');
  async function addLog(trackId, dur=0) {
    const log = { id:uid(), trackId, playedAt:Date.now(), duration:dur };
    await put('logs', log); return log;
  }

  /* ─── META ─── */
  async function getMeta(key, fallback=null) {
    const rec = await getOne('meta', key);
    return rec ? rec.value : fallback;
  }
  const setMeta    = (k,v) => put('meta', { key:k, value:v });
  const deleteMeta = k     => del('meta', k);

  /* ─── SNAPSHOT ─── */
  async function exportSnapshot() {
    const [tracks, playlists, tags, logs] = await Promise.all([
      getTracks(), getPlaylists(), getTags(), getLogs()
    ]);
    return {
      version:    1,
      exportedAt: Date.now(),
      tracks:     tracks.map(({ blobKey, thumbKey, ...rest }) => rest),
      playlists, tags, logs,
    };
  }

  async function importSnapshot(snapshot) {
    if (!snapshot || snapshot.version !== 1) return;
    for (const t of snapshot.tracks||[]) {
      const ex = await getTrack(t.id);
      if (!ex) await put('tracks', { ...t, blobKey:null, thumbKey:null });
    }
    for (const pl of snapshot.playlists||[]) {
      const ex = await getPlaylist(pl.id);
      if (!ex) await put('playlists', pl);
      else await put('playlists', { ...ex, trackIds:[...new Set([...ex.trackIds,...pl.trackIds])] });
    }
    for (const tag of snapshot.tags||[]) {
      if (!(await getTag(tag.id))) await put('tags', tag);
    }
    const exIds = new Set((await getLogs()).map(l => l.id));
    for (const log of snapshot.logs||[])
      if (!exIds.has(log.id)) await put('logs', log);
  }

  /* ─── RESET ─── */
  async function resetAll() {
    for (const s of STORES) await clearStore(s);
  }

  /* ─────────────────────────────────────────
     ID3v2 PARSER — extracts title/artist/year/cover from ArrayBuffer
  ───────────────────────────────────────── */
  function parseAudioMetaFromBuffer(buffer, filename) {
    const result = { title:'', artist:'', releaseDate:null, thumbData:null, thumbMime:null };

    // Filename fallback
    const base = (filename||'').replace(/\.[^.]+$/, '');
    const dash = base.match(/^(.+?)\s+-\s+(.+)$/);
    if (dash) { result.artist = dash[1].trim(); result.title = dash[2].trim(); }
    else        result.title  = base;

    if (!buffer || buffer.byteLength < 10) return result;
    const bytes = new Uint8Array(buffer);

    // ID3v2 magic: 'I','D','3'
    if (!(bytes[0]===0x49 && bytes[1]===0x44 && bytes[2]===0x33)) return result;

    const major = bytes[3];
    if (major < 3 || major > 4) return result;  // only v2.3 / v2.4

    // Tag size is a syncsafe integer
    const tagSize = ((bytes[6]&0x7F)<<21)|((bytes[7]&0x7F)<<14)|
                    ((bytes[8]&0x7F)<<7) | (bytes[9]&0x7F);
    let off = 10;
    const end = Math.min(10 + tagSize, bytes.length);

    while (off + 10 < end) {
      const fid = String.fromCharCode(bytes[off],bytes[off+1],bytes[off+2],bytes[off+3]);
      const fsz = (bytes[off+4]<<24)|(bytes[off+5]<<16)|(bytes[off+6]<<8)|bytes[off+7];
      off += 10;
      if (fsz <= 0 || off + fsz > end) break;
      const fd = bytes.slice(off, off + fsz);

      switch (fid) {
        case 'TIT2': { const v=_id3Text(fd); if(v) result.title   = v; break; }
        case 'TPE1': { const v=_id3Text(fd); if(v) result.artist  = v; break; }
        case 'TDRC':
        case 'TYER': {
          const v = _id3Text(fd);
          if (v && /^\d{4}/.test(v)) result.releaseDate = v.slice(0,4)+'-01-01';
          break;
        }
        case 'APIC': {
          const apic = _id3APIC(fd);
          if (apic) { result.thumbData = apic.data; result.thumbMime = apic.mime; }
          break;
        }
      }
      off += fsz;
    }
    return result;
  }

  function _id3Text(data) {
    if (!data || !data.length) return '';
    const enc = data[0];
    const raw = data.slice(1);
    try {
      const s = enc===1 ? new TextDecoder('utf-16').decode(raw)
              : enc===3 ? new TextDecoder('utf-8').decode(raw)
              :            new TextDecoder('latin1').decode(raw);
      return s.replace(/\0/g,'').trim();
    } catch { return ''; }
  }

  function _id3APIC(data) {
    if (!data || data.length < 4) return null;
    const enc = data[0];
    let off = 1;
    const mimeStart = off;
    while (off < data.length && data[off] !== 0) off++;
    const mime = new TextDecoder('latin1').decode(data.slice(mimeStart,off)) || 'image/jpeg';
    off++; // null
    off++; // picture type
    // Skip description (null-terminated, UTF-16 uses double-null)
    if (enc === 1) {
      while (off+1 < data.length && !(data[off]===0 && data[off+1]===0)) off++;
      off += 2;
    } else {
      while (off < data.length && data[off] !== 0) off++;
      off++;
    }
    if (off >= data.length) return null;
    return { data: data.slice(off).buffer, mime };
  }

  /* ─── FILE META (from File object) ─── */
  async function readAudioMeta(file) {
    // Read first 256 KB for ID3 tags
    const buf  = await file.slice(0, 256*1024).arrayBuffer();
    const meta = parseAudioMetaFromBuffer(buf, file.name);

    // Duration via Audio element
    const duration = await new Promise(resolve => {
      const a   = document.createElement('audio');
      const url = URL.createObjectURL(file);
      a.src = url; a.preload = 'metadata';
      a.onloadedmetadata = () => { URL.revokeObjectURL(url); resolve(a.duration||0); };
      a.onerror          = () => { URL.revokeObjectURL(url); resolve(0); };
    });
    return { ...meta, duration };
  }

  /* ─── PUBLIC ─── */
  return {
    open, uid,
    getTracks, getTrack, addTrack, updateTrack, deleteTrack, reorderTracks,
    saveBlob, getBlob, deleteBlob, getBlobUrl, getAudioBlobUrl,
    getPlaylists, getPlaylist, createPlaylist, updatePlaylist, deletePlaylist,
    addTrackToPlaylist, removeTrackFromPlaylist,
    getTags, getTag, createTag, updateTag, deleteTag, reorderTags,
    getLogs, addLog,
    getMeta, setMeta, deleteMeta,
    exportSnapshot, importSnapshot,
    resetAll,
    readAudioMeta,
    parseAudioMetaFromBuffer,
  };
})();
