/**
 * storage.js — IndexedDB wrapper + comprehensive audio metadata parser for Sonora
 *
 * Metadata support:
 *   ID3v2.2  (MP3) — 3-char frame IDs: TT2, TP1, TYE, PIC
 *   ID3v2.3/4(MP3) — 4-char frame IDs: TIT2, TPE1, TDRC/TYER, APIC
 *   iTunes / M4A   — MPEG-4 udta/ilst atoms: ©nam, ©ART, ©day, covr
 *   FLAC           — STREAMINFO + VORBIS_COMMENT + PICTURE metadata blocks
 *   OGG Vorbis     — Vorbis comment header packet
 */

const Storage = (() => {
  const DB_NAME    = 'SonoraDB';
  const DB_VERSION = 1;
  const STORES     = ['tracks','blobs','playlists','tags','logs','meta'];
  let _db = null;

  /* ══════════════════════════════════════════
     DATABASE
  ══════════════════════════════════════════ */
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

  /* ══════════════════════════════════════════
     LOW-LEVEL DB HELPERS
  ══════════════════════════════════════════ */
  const tx     = (s, m='readonly') => _db.transaction(s, m).objectStore(s);
  const req2p  = r => new Promise((res,rej) => { r.onsuccess = e => res(e.target.result); r.onerror = e => rej(e.target.error); });
  const getAll = (s,idx,q) => { const st = tx(s); return req2p((idx ? st.index(idx) : st).getAll(q)); };
  const getOne     = (s,k)   => req2p(tx(s).get(k));
  const put        = (s,obj) => req2p(tx(s,'readwrite').put(obj));
  const del        = (s,k)   => req2p(tx(s,'readwrite').delete(k));
  const clearStore = s       => req2p(tx(s,'readwrite').clear());
  const uid        = ()      => Date.now().toString(36) + Math.random().toString(36).slice(2,7);

  /* ══════════════════════════════════════════
     TRACKS
  ══════════════════════════════════════════ */
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
    const pls = await getPlaylists();
    for (const pl of pls)
      if (pl.trackIds.includes(id))
        await updatePlaylist(pl.id, { trackIds: pl.trackIds.filter(t => t !== id) });
    if (track.blobKey)  await del('blobs', track.blobKey);
    if (track.thumbKey) await del('blobs', track.thumbKey);
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

  /* ══════════════════════════════════════════
     BLOBS
  ══════════════════════════════════════════ */
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

  /* ══════════════════════════════════════════
     PLAYLISTS
  ══════════════════════════════════════════ */
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

  /* ══════════════════════════════════════════
     TAGS
  ══════════════════════════════════════════ */
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

  /* ══════════════════════════════════════════
     LOGS
  ══════════════════════════════════════════ */
  const getLogs = () => getAll('logs');
  async function addLog(trackId, dur=0) {
    const log = { id:uid(), trackId, playedAt:Date.now(), duration:dur };
    await put('logs', log); return log;
  }

  /* ══════════════════════════════════════════
     META
  ══════════════════════════════════════════ */
  async function getMeta(key, fallback=null) {
    const rec = await getOne('meta', key);
    return rec ? rec.value : fallback;
  }
  const setMeta    = (k,v) => put('meta', { key:k, value:v });
  const deleteMeta = k     => del('meta', k);

  /* ══════════════════════════════════════════
     SNAPSHOT
  ══════════════════════════════════════════ */
  async function exportSnapshot() {
    const [tracks, playlists, tags, logs] = await Promise.all([
      getTracks(), getPlaylists(), getTags(), getLogs()
    ]);
    return {
      version: 1, exportedAt: Date.now(),
      tracks:  tracks.map(({ blobKey, thumbKey, ...rest }) => rest),
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

  async function resetAll() {
    for (const s of STORES) await clearStore(s);
  }

  /* ══════════════════════════════════════════
     ████  METADATA PARSER  ████

     Entry point:   readAudioMeta(file)          — for File objects
                    parseAudioMetaFromBuffer(buf, filename) — for ArrayBuffers

     Returns: { title, artist, releaseDate, thumbData: ArrayBuffer|null, thumbMime }
  ══════════════════════════════════════════ */

  /* ── Shared result structure ── */
  function _blankMeta(filename) {
    const result = { title:'', artist:'', releaseDate:null, thumbData:null, thumbMime:null };
    const base   = (filename||'').replace(/\.[^.]+$/, '');
    const dash   = base.match(/^(.+?)\s+-\s+(.+)$/);
    if (dash) { result.artist = dash[1].trim(); result.title = dash[2].trim(); }
    else        result.title  = base;
    return result;
  }

  /* ── UTF text decoders ── */
  function _decText(data, enc) {
    if (!data || !data.length) return '';
    try {
      const td = enc === 1 || enc === 2 ? new TextDecoder('utf-16')
               : enc === 3              ? new TextDecoder('utf-8')
               :                          new TextDecoder('latin1');
      return td.decode(data).replace(/\0/g,'').trim();
    } catch { return ''; }
  }

  /* ── Read null-terminated string ── */
  function _readCString(bytes, pos) {
    const start = pos;
    while (pos < bytes.length && bytes[pos] !== 0) pos++;
    return { str: new TextDecoder('latin1').decode(bytes.slice(start, pos)), end: pos + 1 };
  }

  /* ── Read 32-bit big-endian ── */
  function _u32be(b, o) { return ((b[o]<<24)|(b[o+1]<<16)|(b[o+2]<<8)|b[o+3]) >>> 0; }
  /* ── Read syncsafe int ── */
  function _syncsafe(b, o) {
    return ((b[o]&0x7F)<<21)|((b[o+1]&0x7F)<<14)|((b[o+2]&0x7F)<<7)|(b[o+3]&0x7F);
  }

  /* ──────────────────────────────────────────
     ID3v2.3 / ID3v2.4  (MP3)
     Handles extended headers and all encodings
  ────────────────────────────────────────── */
  function _parseID3v23(bytes, result) {
    const major   = bytes[3]; // 3 or 4
    const flags   = bytes[5];
    const tagSize = _syncsafe(bytes, 6);
    const end     = Math.min(10 + tagSize, bytes.length);
    let off       = 10;

    // Skip extended header if present (flag bit 6)
    if (flags & 0x40) {
      if (off + 4 >= end) return;
      const extSize = major === 4
        ? _syncsafe(bytes, off)          // v2.4: syncsafe
        : _u32be(bytes, off);            // v2.3: plain int
      off += extSize;
    }

    while (off + 10 < end) {
      const fid = String.fromCharCode(bytes[off], bytes[off+1], bytes[off+2], bytes[off+3]);
      if (fid === '\0\0\0\0') break;

      // Frame size: v2.4 uses syncsafe, v2.3 uses plain int
      const fsz = major === 4
        ? _syncsafe(bytes, off + 4)
        : _u32be(bytes, off + 4);
      off += 10;

      if (fsz <= 0 || off + fsz > end) break;
      const fd  = bytes.subarray(off, off + fsz);
      const enc = fd[0];

      switch (fid) {
        case 'TIT2': { const v=_decText(fd.subarray(1), enc); if(v) result.title   = v; break; }
        case 'TPE1': { const v=_decText(fd.subarray(1), enc); if(v) result.artist  = v; break; }
        case 'TDRC':
        case 'TYER': {
          const v = _decText(fd.subarray(1), enc);
          if (v && /^\d{4}/.test(v)) result.releaseDate = v.slice(0,4)+'-01-01';
          break;
        }
        case 'APIC':
          if (!result.thumbData) {
            const apic = _parseAPIC(fd);
            if (apic) { result.thumbData = apic.data; result.thumbMime = apic.mime; }
          }
          break;
      }
      off += fsz;
    }
  }

  function _parseAPIC(fd) {
    if (!fd || fd.length < 6) return null;
    const enc = fd[0];
    let pos   = 1;

    // MIME type (null-terminated latin1)
    const mimeRes = _readCString(fd, pos);
    let mime      = mimeRes.str.toLowerCase();
    pos           = mimeRes.end;

    if (pos >= fd.length) return null;
    pos++; // picture type byte — skip (we accept all types)

    // Description: null-terminated, encoding-aware
    if (enc === 1 || enc === 2) {
      // UTF-16: scan for double null (word-aligned)
      while (pos + 1 < fd.length && !(fd[pos] === 0 && fd[pos+1] === 0)) pos += 2;
      pos += 2;
    } else {
      while (pos < fd.length && fd[pos] !== 0) pos++;
      pos++;
    }

    if (pos >= fd.length) return null;

    const imgBytes = fd.slice(pos);
    if (imgBytes.length < 4) return null;

    // Detect MIME from magic bytes if missing/wrong
    if (!mime || mime === 'image/' || mime === '-->' || !mime.startsWith('image')) {
      if (imgBytes[0]===0xFF && imgBytes[1]===0xD8) mime = 'image/jpeg';
      else if (imgBytes[0]===0x89 && imgBytes[1]===0x50) mime = 'image/png';
      else mime = 'image/jpeg';
    }

    return { data: imgBytes.buffer, mime };
  }

  /* ──────────────────────────────────────────
     ID3v2.2  (older MP3, 3-char frame IDs)
  ────────────────────────────────────────── */
  function _parseID3v22(bytes, result) {
    const tagSize = ((bytes[6]&0x7F)<<14)|((bytes[7]&0x7F)<<7)|(bytes[8]&0x7F)
                    | ((bytes[9]&0x7F)); // v2.2 tag size is also 4 syncsafe bytes
    // Actually v2.2 size: bytes 6-9 syncsafe same as v2.3
    const end = Math.min(10 + tagSize, bytes.length);
    let off   = 10;

    while (off + 6 < end) {
      const fid = String.fromCharCode(bytes[off], bytes[off+1], bytes[off+2]);
      if (fid === '\0\0\0') break;
      // Frame size: 3 bytes big-endian in v2.2
      const fsz = (bytes[off+3]<<16)|(bytes[off+4]<<8)|bytes[off+5];
      off += 6;
      if (fsz <= 0 || off + fsz > end) break;
      const fd  = bytes.subarray(off, off + fsz);
      const enc = fd[0];

      switch (fid) {
        case 'TT2': { const v=_decText(fd.subarray(1), enc); if(v) result.title  = v; break; }
        case 'TP1': { const v=_decText(fd.subarray(1), enc); if(v) result.artist = v; break; }
        case 'TYE': {
          const v = _decText(fd.subarray(1), enc);
          if (v && /^\d{4}/.test(v)) result.releaseDate = v.slice(0,4)+'-01-01';
          break;
        }
        case 'PIC':
          if (!result.thumbData) {
            const pic = _parsePIC(fd);
            if (pic) { result.thumbData = pic.data; result.thumbMime = pic.mime; }
          }
          break;
      }
      off += fsz;
    }
  }

  function _parsePIC(fd) {
    if (!fd || fd.length < 6) return null;
    const enc = fd[0];
    // v2.2 PIC: encoding(1) + format(3 chars, e.g. "JPG") + picType(1) + desc + img
    const fmt = String.fromCharCode(fd[1], fd[2], fd[3]).toLowerCase();
    let mime  = fmt === 'png' ? 'image/png' : 'image/jpeg';
    let pos   = 4; // skip encoding + format
    pos++;         // skip picture type

    // Skip description
    if (enc === 1 || enc === 2) {
      while (pos + 1 < fd.length && !(fd[pos]===0 && fd[pos+1]===0)) pos += 2;
      pos += 2;
    } else {
      while (pos < fd.length && fd[pos] !== 0) pos++;
      pos++;
    }

    if (pos >= fd.length) return null;
    const imgBytes = fd.slice(pos);
    if (imgBytes.length < 4) return null;

    // Magic byte override
    if (imgBytes[0]===0x89 && imgBytes[1]===0x50) mime = 'image/png';
    return { data: imgBytes.buffer, mime };
  }

  /* ──────────────────────────────────────────
     iTunes / M4A / MP4  (MPEG-4 box parser)
     Atoms we care about:
       moov → udta → meta → ilst
         ©nam → title
         ©ART → artist
         ©day → date
         covr → cover art
  ────────────────────────────────────────── */
  function _parseM4A(bytes, result) {
    // Walk top-level boxes looking for 'moov'
    _walkBoxes(bytes, 0, bytes.length, (name, start, end) => {
      if (name === 'moov') {
        _walkBoxes(bytes, start, end, (n2, s2, e2) => {
          if (n2 === 'udta') {
            _walkBoxes(bytes, s2, e2, (n3, s3, e3) => {
              if (n3 === 'meta') {
                // meta has a 4-byte version/flags prefix before children
                _walkBoxes(bytes, s3 + 4, e3, (n4, s4, e4) => {
                  if (n4 === 'ilst') _parseIlst(bytes, s4, e4, result);
                });
              }
            });
          }
        });
        return true; // stop after moov
      }
    });
  }

  function _walkBoxes(bytes, start, end, callback) {
    let pos = start;
    while (pos + 8 <= end) {
      let size = _u32be(bytes, pos);
      const name = String.fromCharCode(bytes[pos+4], bytes[pos+5], bytes[pos+6], bytes[pos+7]);

      if (size === 1) {
        // Extended size: 8 more bytes (64-bit, take lower 32)
        if (pos + 16 > end) break;
        size = _u32be(bytes, pos + 12); // ignore upper 32 bits
        const childStart = pos + 16;
        if (callback(name, childStart, pos + size) === true) return;
        pos += size; continue;
      }
      if (size < 8) break;

      const childStart = pos + 8;
      if (callback(name, childStart, pos + size) === true) return;
      pos += size;
    }
  }

  function _parseIlst(bytes, start, end, result) {
    _walkBoxes(bytes, start, end, (name, s, e) => {
      // Each ilst child contains a 'data' box
      _walkBoxes(bytes, s, e, (dname, ds, de) => {
        if (dname !== 'data') return;
        if (de - ds < 8) return;
        // data box: 4-byte type indicator + 4-byte locale + payload
        const typeCode = _u32be(bytes, ds);
        const payload  = bytes.slice(ds + 8, de);

        switch (name) {
          case '\xa9nam': // ©nam — title
            if (!result.title) result.title = new TextDecoder('utf-8').decode(payload).replace(/\0/g,'').trim();
            break;
          case '\xa9ART': // ©ART — artist
            if (!result.artist) result.artist = new TextDecoder('utf-8').decode(payload).replace(/\0/g,'').trim();
            break;
          case '\xa9day': { // ©day — release date/year
            const dateStr = new TextDecoder('utf-8').decode(payload).replace(/\0/g,'').trim();
            if (dateStr && /^\d{4}/.test(dateStr) && !result.releaseDate)
              result.releaseDate = dateStr.slice(0,4) + '-01-01';
            break;
          }
          case 'covr': // cover art
            if (!result.thumbData && payload.length > 4) {
              const mime = (typeCode === 14) ? 'image/png' : 'image/jpeg';
              result.thumbData = payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
              result.thumbMime = mime;
            }
            break;
        }
      });
    });
  }

  /* ──────────────────────────────────────────
     FLAC  (fLaC marker + metadata blocks)
     Block types: 0=STREAMINFO, 4=VORBIS_COMMENT, 6=PICTURE
  ────────────────────────────────────────── */
  function _parseFLAC(bytes, result) {
    if (bytes.length < 8) return;
    // Magic: 'fLaC'
    if (!(bytes[0]===0x66 && bytes[1]===0x4C && bytes[2]===0x61 && bytes[3]===0x43)) return;

    let pos = 4;
    let lastBlock = false;

    while (!lastBlock && pos + 4 <= bytes.length) {
      const blockHeader = bytes[pos];
      lastBlock         = !!(blockHeader & 0x80);
      const blockType   = blockHeader & 0x7F;
      const blockSize   = (bytes[pos+1]<<16)|(bytes[pos+2]<<8)|bytes[pos+3];
      pos += 4;
      if (pos + blockSize > bytes.length) break;

      if (blockType === 4) {
        // VORBIS_COMMENT
        _parseVorbisComment(bytes.subarray(pos, pos + blockSize), result);
      } else if (blockType === 6 && !result.thumbData) {
        // PICTURE
        _parseFLACPicture(bytes.subarray(pos, pos + blockSize), result);
      }
      pos += blockSize;
    }
  }

  function _parseVorbisComment(data, result) {
    // Little-endian: vendor length(4) + vendor string + count(4) + comments
    if (data.length < 8) return;
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const vendorLen = dv.getUint32(0, true);
    let pos = 4 + vendorLen;
    if (pos + 4 > data.length) return;
    const count = dv.getUint32(pos, true);
    pos += 4;

    for (let i = 0; i < count && pos + 4 <= data.length; i++) {
      const len = dv.getUint32(pos, true);
      pos += 4;
      if (pos + len > data.length) break;
      const comment = new TextDecoder('utf-8').decode(data.subarray(pos, pos + len));
      pos += len;
      const eq = comment.indexOf('=');
      if (eq < 0) continue;
      const key = comment.slice(0, eq).toUpperCase();
      const val = comment.slice(eq + 1).trim();
      switch (key) {
        case 'TITLE':  if (!result.title  && val) result.title  = val; break;
        case 'ARTIST': if (!result.artist && val) result.artist = val; break;
        case 'DATE':
          if (!result.releaseDate && /^\d{4}/.test(val))
            result.releaseDate = val.slice(0,4)+'-01-01';
          break;
      }
    }
  }

  function _parseFLACPicture(data, result) {
    if (data.length < 32) return;
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let pos = 4; // skip picture type
    const mimeLen = dv.getUint32(pos, false); pos += 4;
    if (pos + mimeLen > data.length) return;
    const mime = new TextDecoder('latin1').decode(data.subarray(pos, pos + mimeLen));
    pos += mimeLen;
    const descLen = dv.getUint32(pos, false); pos += 4;
    pos += descLen; // skip description
    pos += 16;      // width(4) + height(4) + depth(4) + indexedColorCount(4)
    if (pos + 4 > data.length) return;
    const dataLen = dv.getUint32(pos, false); pos += 4;
    if (pos + dataLen > data.length) return;

    const imgBytes = data.slice(pos, pos + dataLen);
    if (imgBytes.length > 4) {
      result.thumbData = imgBytes.buffer.slice(imgBytes.byteOffset, imgBytes.byteOffset + imgBytes.byteLength);
      result.thumbMime = mime || 'image/jpeg';
    }
  }

  /* ──────────────────────────────────────────
     OGG Vorbis  (first 3 Ogg pages → Vorbis comment header)
  ────────────────────────────────────────── */
  function _parseOGG(bytes, result) {
    // OGG capture pattern: 0x4F 0x67 0x67 0x53 ('OggS')
    if (!(bytes[0]===0x4F && bytes[1]===0x67 && bytes[2]===0x67 && bytes[3]===0x53)) return;

    // Iterate OGG pages to find the comment header packet (type=0x03)
    let pos = 0;
    let pagesScanned = 0;
    while (pos + 27 <= bytes.length && pagesScanned < 20) {
      if (!(bytes[pos]===0x4F && bytes[pos+1]===0x67)) break;
      pagesScanned++;

      const headerType  = bytes[pos + 5];
      const numSegs     = bytes[pos + 26];
      if (pos + 27 + numSegs > bytes.length) break;

      // Collect segment sizes
      let pageDataSize = 0;
      for (let i = 0; i < numSegs; i++) pageDataSize += bytes[pos + 27 + i];

      const pageData = bytes.subarray(pos + 27 + numSegs, pos + 27 + numSegs + pageDataSize);

      // Vorbis comment packet starts with 0x03 + 'vorbis'
      if (pageData.length > 7 &&
          pageData[0] === 0x03 &&
          pageData[1] === 0x76 && pageData[2] === 0x6F && pageData[3] === 0x72 &&
          pageData[4] === 0x62 && pageData[5] === 0x69 && pageData[6] === 0x73) {
        _parseVorbisComment(pageData.subarray(7), result);
        return; // found what we need
      }

      pos += 27 + numSegs + pageDataSize;
    }
  }

  /* ──────────────────────────────────────────
     DISPATCHER — detect format and parse
  ────────────────────────────────────────── */
  function parseAudioMetaFromBuffer(buffer, filename) {
    const result = _blankMeta(filename);
    if (!buffer || buffer.byteLength < 12) return result;

    const bytes = new Uint8Array(buffer);

    try {
      // ID3v2.x
      if (bytes[0]===0x49 && bytes[1]===0x44 && bytes[2]===0x33) {
        const major = bytes[3];
        if (major === 2)        _parseID3v22(bytes, result);
        else if (major >= 3)    _parseID3v23(bytes, result);
        // After ID3, might still have atom data (rare but possible)
      }

      // FLAC
      if (bytes[0]===0x66 && bytes[1]===0x4C) {
        _parseFLAC(bytes, result);
      }

      // OGG
      if (bytes[0]===0x4F && bytes[1]===0x67) {
        _parseOGG(bytes, result);
      }

      // M4A / MP4 / AAC — look for 'ftyp' box within first 512 bytes
      // or just try parsing as M4A if not already identified
      if (!result.thumbData || (!result.title && !result.artist)) {
        // Scan for 'ftyp' box marker or 'moov' anywhere in the first portion
        const head512 = Math.min(512, bytes.length);
        let looksLikeM4A = false;
        for (let i = 4; i < head512 - 4; i++) {
          if (bytes[i]===0x66 && bytes[i+1]===0x74 && bytes[i+2]===0x79 && bytes[i+3]===0x70) {
            looksLikeM4A = true; break;
          }
          if (bytes[i]===0x6D && bytes[i+1]===0x6F && bytes[i+2]===0x6F && bytes[i+3]===0x76) {
            looksLikeM4A = true; break;
          }
        }
        if (looksLikeM4A) _parseM4A(bytes, result);
      }
    } catch (e) {
      console.warn('[Storage] Metadata parse error:', e);
    }

    return result;
  }

  /* ──────────────────────────────────────────
     readAudioMeta(file)
     Smart read strategy:
       1. Peek first 10 bytes to detect format & tag size
       2. Read exactly the tag block (ID3) or whole file cap (M4A/FLAC/OGG)
       3. Probe duration via Audio element
  ────────────────────────────────────────── */
  async function readAudioMeta(file) {
    let meta = _blankMeta(file.name);

    try {
      // Step 1: read first 12 bytes to identify format
      const headerBuf  = await file.slice(0, 12).arrayBuffer();
      const hdr        = new Uint8Array(headerBuf);

      let readSize = 0;

      // ID3v2: read exactly tagSize + 10 bytes (covers all ID3 frames incl. cover art)
      if (hdr[0]===0x49 && hdr[1]===0x44 && hdr[2]===0x33 && hdr[3] >= 2) {
        const tagSize = _syncsafe(hdr, 6);
        // tagSize can be 0 for oddly tagged files; fall back to 4 MB
        readSize = tagSize > 0 ? Math.min(tagSize + 10, 30 * 1024 * 1024) : 4 * 1024 * 1024;
      }
      // FLAC: metadata blocks are at the start; cap at 4 MB (covers all blocks)
      else if (hdr[0]===0x66 && hdr[1]===0x4C) {
        readSize = Math.min(file.size, 4 * 1024 * 1024);
      }
      // OGG: comment header is in first few pages; 512 KB is always enough
      else if (hdr[0]===0x4F && hdr[1]===0x67) {
        readSize = Math.min(file.size, 512 * 1024);
      }
      // M4A/MP4: moov atom can be anywhere; try 10 MB then full file
      else {
        readSize = Math.min(file.size, 10 * 1024 * 1024);
      }

      const buf = await file.slice(0, readSize).arrayBuffer();
      meta = parseAudioMetaFromBuffer(buf, file.name);

      // If M4A and moov not found in first 10 MB, try the whole file (moov at end)
      if (!meta.title && !meta.thumbData &&
          !(hdr[0]===0x49) && !(hdr[0]===0x66) && !(hdr[0]===0x4F)) {
        if (readSize < file.size) {
          const fullBuf = await file.arrayBuffer();
          meta = parseAudioMetaFromBuffer(fullBuf, file.name);
        }
      }
    } catch (e) {
      console.warn('[Storage] readAudioMeta error:', e);
    }

    // Step 3: get duration
    const duration = await new Promise(resolve => {
      const a   = document.createElement('audio');
      const url = URL.createObjectURL(file);
      a.src = url; a.preload = 'metadata';
      a.onloadedmetadata = () => { URL.revokeObjectURL(url); resolve(a.duration || 0); };
      a.onerror          = () => { URL.revokeObjectURL(url); resolve(0); };
      setTimeout(()      => { URL.revokeObjectURL(url); resolve(0); }, 8000);
    });

    return { ...meta, duration };
  }

  /* ══════════════════════════════════════════
     PUBLIC API
  ══════════════════════════════════════════ */
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
