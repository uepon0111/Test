/**
 * storage.js — IndexedDB wrapper + metadata utilities for Sonora
 */

const Storage = (() => {
  const DB_NAME    = 'SonoraDB';
  const DB_VERSION = 1;
  const STORES     = ['tracks','blobs','playlists','tags','logs','meta'];
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
  const getOne     = (s,k)   => req2p(tx(s).get(k));
  const put        = (s,obj) => req2p(tx(s,'readwrite').put(obj));
  const del        = (s,k)   => req2p(tx(s,'readwrite').delete(k));
  const clearStore = s       => req2p(tx(s,'readwrite').clear());
  const uid        = ()      => Date.now().toString(36) + Math.random().toString(36).slice(2,7);

  /* ─── TRACKS ─── */
  const getTracks  = ()  => getAll('tracks');
  const getTrack   = id  => getOne('tracks', id);

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
      // Strip local blob keys – Drive holds the canonical binary
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

  /* ═══════════════════════════════════════
     ID3v2 METADATA PARSER
     Supports ID3v2.3 and v2.4
     Extracts: TIT2, TPE1, TDRC/TYER, APIC
  ═══════════════════════════════════════ */

  /**
   * Parse ID3v2 tags from an ArrayBuffer.
   * @param {ArrayBuffer} buffer  — raw audio bytes (ideally the full file or at least tagSize+10 bytes)
   * @param {string}      filename — used as fallback title/artist
   * @returns {{ title, artist, releaseDate, thumbData: ArrayBuffer|null, thumbMime: string|null }}
   */
  function parseAudioMetaFromBuffer(buffer, filename) {
    const result = { title:'', artist:'', releaseDate:null, thumbData:null, thumbMime:null };

    // Filename fallback (Artist - Title pattern)
    const base = (filename||'').replace(/\.[^.]+$/, '');
    const dash = base.match(/^(.+?)\s+-\s+(.+)$/);
    if (dash) { result.artist = dash[1].trim(); result.title = dash[2].trim(); }
    else        result.title  = base;

    if (!buffer || buffer.byteLength < 10) return result;

    const bytes = new Uint8Array(buffer);

    // Check ID3v2 magic: 0x49='I', 0x44='D', 0x33='3'
    if (!(bytes[0]===0x49 && bytes[1]===0x44 && bytes[2]===0x33)) return result;

    const major = bytes[3];
    if (major < 3 || major > 4) return result; // only v2.3 / v2.4

    // Syncsafe integer tag size (bytes 6-9, MSB first, bit7 always 0)
    const tagSize = ((bytes[6]&0x7F)<<21)|((bytes[7]&0x7F)<<14)|
                    ((bytes[8]&0x7F)<<7) | (bytes[9]&0x7F);

    // Safety: don't exceed what we actually have
    const end = Math.min(10 + tagSize, bytes.length);
    let off = 10;

    while (off + 10 < end) {
      // Frame ID: 4 ASCII chars
      const fid = String.fromCharCode(bytes[off],bytes[off+1],bytes[off+2],bytes[off+3]);
      if (fid === '\0\0\0\0') break; // padding

      // Frame size: 4 bytes big-endian
      // NOTE: ID3v2.4 uses syncsafe integers here too, but we treat both as plain int
      // (most encoders use plain int even in v2.4)
      let fsz = (bytes[off+4]<<24)|(bytes[off+5]<<16)|(bytes[off+6]<<8)|bytes[off+7];
      if (fsz < 0) fsz = fsz >>> 0; // treat as unsigned
      off += 10; // move past frame header

      if (fsz <= 0 || fsz > end - off) break;

      // Extract frame data as a Uint8Array view (no copy yet)
      const fd = bytes.subarray(off, off + fsz);

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
          // Only grab the first APIC we find
          if (!result.thumbData) {
            const apic = _id3APIC(fd);
            if (apic) { result.thumbData = apic.data; result.thumbMime = apic.mime; }
          }
          break;
        }
      }
      off += fsz;
    }
    return result;
  }

  /** Decode an ID3 text frame (encoding byte + text) */
  function _id3Text(data) {
    if (!data || data.length === 0) return '';
    const enc = data[0];
    const raw = data.subarray(1);
    try {
      let s;
      if (enc === 1 || enc === 2) {
        // UTF-16 — skip BOM if present
        s = new TextDecoder('utf-16').decode(raw);
      } else if (enc === 3) {
        s = new TextDecoder('utf-8').decode(raw);
      } else {
        // enc=0: ISO-8859-1
        s = new TextDecoder('latin1').decode(raw);
      }
      // Strip null chars and whitespace
      return s.replace(/\0/g,'').trim();
    } catch { return ''; }
  }

  /**
   * Decode an APIC (Attached Picture) frame.
   * Layout: encoding(1) | MIME(\0) | picType(1) | description(\0 or \0\0) | imageData
   */
  function _id3APIC(data) {
    if (!data || data.length < 6) return null;

    let pos = 0;
    const encoding = data[pos++];

    // MIME type: null-terminated ASCII
    const mimeStart = pos;
    while (pos < data.length && data[pos] !== 0) pos++;
    const mimeStr = new TextDecoder('latin1').decode(data.slice(mimeStart, pos));
    if (pos >= data.length) return null;
    pos++; // consume null terminator

    // Picture type byte (0x03 = Cover front, but accept any)
    if (pos >= data.length) return null;
    pos++; // skip picture type

    // Description: null-terminated
    // Encoding 1/2 = UTF-16 → double-null terminator, advance by 2 at a time
    // Encoding 0/3 = Latin1/UTF-8 → single null
    if (encoding === 1 || encoding === 2) {
      // Word-align if needed and scan for double null
      while (pos + 1 < data.length) {
        if (data[pos] === 0 && data[pos+1] === 0) { pos += 2; break; }
        pos += 2;
      }
    } else {
      while (pos < data.length && data[pos] !== 0) pos++;
      if (pos < data.length) pos++; // consume null
    }

    if (pos >= data.length) return null;

    // Remaining bytes are the image
    // Use slice() to get a copy with its own ArrayBuffer
    const imgBytes = data.slice(pos);
    if (imgBytes.length < 4) return null;

    // Determine actual mime from magic bytes if mime string is missing or wrong
    let mime = mimeStr.toLowerCase();
    if (!mime || mime === 'image/' || mime === '-->') {
      // Detect from magic bytes
      if (imgBytes[0]===0xFF && imgBytes[1]===0xD8) mime = 'image/jpeg';
      else if (imgBytes[0]===0x89 && imgBytes[1]===0x50) mime = 'image/png';
      else mime = 'image/jpeg';
    }

    return { data: imgBytes.buffer, mime };
  }

  /* ─────────────────────────────────────────
     FILE META — reads ID3 tags from a File object
     Strategy:
       1. Read first 10 bytes → parse ID3 tag size
       2. Read full tag (may be several MB for embedded cover art)
       3. Also probe audio duration
  ───────────────────────────────────────── */
  async function readAudioMeta(file) {
    let meta = { title:'', artist:'', releaseDate:null, thumbData:null, thumbMime:null };

    try {
      // Step 1: read header (10 bytes) to find tag size
      const headerBuf = await file.slice(0, 10).arrayBuffer();
      const hdr = new Uint8Array(headerBuf);

      let readSize = 512 * 1024; // default 512 KB

      if (hdr[0]===0x49 && hdr[1]===0x44 && hdr[2]===0x33 && hdr[3] >= 3) {
        // ID3v2 tag present — read exactly tagSize + 10 bytes
        const tagSize = ((hdr[6]&0x7F)<<21)|((hdr[7]&0x7F)<<14)|
                        ((hdr[8]&0x7F)<<7) | (hdr[9]&0x7F);
        // Cap at 20 MB to avoid OOM on corrupt files
        readSize = Math.min(tagSize + 10, 20 * 1024 * 1024);
      }

      // Step 2: read full ID3 block
      const buf = await file.slice(0, readSize).arrayBuffer();
      meta = parseAudioMetaFromBuffer(buf, file.name);
    } catch (e) {
      console.warn('ID3 parse error:', e);
      // Filename fallback
      const base = file.name.replace(/\.[^.]+$/,'');
      const dash = base.match(/^(.+?)\s+-\s+(.+)$/);
      meta.title  = dash ? dash[2].trim() : base;
      meta.artist = dash ? dash[1].trim() : '';
    }

    // Step 3: get duration via Audio element
    const duration = await new Promise(resolve => {
      const a   = document.createElement('audio');
      const url = URL.createObjectURL(file);
      a.src     = url;
      a.preload = 'metadata';
      a.onloadedmetadata = () => { URL.revokeObjectURL(url); resolve(a.duration || 0); };
      a.onerror          = () => { URL.revokeObjectURL(url); resolve(0); };
      // Safety timeout
      setTimeout(() => { URL.revokeObjectURL(url); resolve(0); }, 5000);
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
