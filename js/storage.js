/**
 * storage.js — IndexedDB wrapper + audio metadata utilities for Sonora
 *
 * Metadata extraction supports:
 *   MP3  — ID3v2.3 (plain frame sizes) and ID3v2.4 (syncsafe frame sizes)
 *   M4A/AAC — MP4 atom parser (moov > udta > meta > ilst > covr)
 *   FLAC — METADATA_BLOCK_PICTURE
 *   All  — filename fallback (Artist - Title pattern)
 */

const Storage = (() => {
  const DB_NAME = 'SonoraDB';
  const DB_VERSION = 1;
  const STORES = ['tracks','blobs','playlists','tags','logs','meta'];
  let _db = null;

  /* ════════════════ OPEN / SCHEMA ════════════════ */
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

  /* ════════════════ LOW-LEVEL DB ════════════════ */
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

  /* ════════════════ TRACKS ════════════════ */
  const getTracks = () => getAll('tracks');
  const getTrack  = id => getOne('tracks', id);

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

  /* ════════════════ BLOBS ════════════════ */
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

  /* ════════════════ PLAYLISTS ════════════════ */
  const getPlaylists  = () => getAll('playlists');
  const getPlaylist   = id => getOne('playlists', id);
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

  /* ════════════════ TAGS ════════════════ */
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

  /* ════════════════ LOGS ════════════════ */
  const getLogs = () => getAll('logs');
  async function addLog(trackId, dur=0) {
    const log = { id:uid(), trackId, playedAt:Date.now(), duration:dur };
    await put('logs', log); return log;
  }

  /* ════════════════ META ════════════════ */
  async function getMeta(key, fallback=null) {
    const rec = await getOne('meta', key);
    return rec ? rec.value : fallback;
  }
  const setMeta    = (k,v) => put('meta', { key:k, value:v });
  const deleteMeta = k     => del('meta', k);

  /* ════════════════ SNAPSHOT ════════════════ */
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

  /* ════════════════ RESET ════════════════ */
  async function resetAll() {
    for (const s of STORES) await clearStore(s);
  }

  /* ════════════════════════════════════════════════════════════════════
     AUDIO METADATA EXTRACTION
     ────────────────────────────────────────────────────────────────
     Dispatch order:
       1. ID3v2  (MP3, usually at byte 0)
       2. MP4/M4A atoms (ftyp or moov at byte 0)
       3. FLAC   (fLaC at byte 0)
       4. Filename fallback
  ════════════════════════════════════════════════════════════════════ */

  /**
   * Parse metadata from an ArrayBuffer.
   * Returns { title, artist, releaseDate, thumbData: ArrayBuffer|null, thumbMime }
   */
  function parseAudioMetaFromBuffer(buffer, filename) {
    const result = _filenameFallback(filename);
    if (!buffer || buffer.byteLength < 12) return result;

    const b = new Uint8Array(buffer);

    // --- ID3v2 ---
    if (b[0]===0x49 && b[1]===0x44 && b[2]===0x33) {
      return _parseID3v2(b, result);
    }

    // --- MP4 / M4A (ftyp or wide or mdat at start) ---
    // First 4 bytes = box size (big-endian), next 4 = fourcc
    const fourcc = String.fromCharCode(b[4],b[5],b[6],b[7]);
    if (fourcc === 'ftyp' || fourcc === 'moov' || fourcc === 'wide' ||
        fourcc === 'mdat' || fourcc === 'free') {
      return _parseMP4(b, result);
    }

    // --- FLAC ---
    if (b[0]===0x66 && b[1]===0x4C && b[2]===0x61 && b[3]===0x43) {
      return _parseFLAC(b, result);
    }

    return result;
  }

  /* ──────── FILENAME FALLBACK ──────── */
  function _filenameFallback(filename) {
    const base = (filename||'').replace(/\.[^.]+$/, '');
    const dash = base.match(/^(.+?)\s+-\s+(.+)$/);
    return {
      title:       dash ? dash[2].trim() : base,
      artist:      dash ? dash[1].trim() : '',
      releaseDate: null,
      thumbData:   null,
      thumbMime:   null,
    };
  }

  /* ──────────────────────────────────────
     ID3v2  PARSER  (v2.3 and v2.4)
  ────────────────────────────────────── */
  function _parseID3v2(b, result) {
    const major   = b[3];  // 3 = ID3v2.3, 4 = ID3v2.4
    if (major < 3 || major > 4) return result;

    const flags   = b[5];
    const hasExtHdr = !!(flags & 0x40);

    // Tag size: syncsafe integer (bit 7 of each byte always 0)
    const tagSize = ((b[6]&0x7F)<<21)|((b[7]&0x7F)<<14)|
                    ((b[8]&0x7F)<<7) | (b[9]&0x7F);
    const tagEnd  = Math.min(10 + tagSize, b.length);

    let off = 10;

    // Skip extended header (ID3v2.3: 4-byte size; ID3v2.4: syncsafe size)
    if (hasExtHdr && off + 4 < tagEnd) {
      let extSize;
      if (major === 4) {
        extSize = ((b[off]&0x7F)<<21)|((b[off+1]&0x7F)<<14)|
                  ((b[off+2]&0x7F)<<7) | (b[off+3]&0x7F);
      } else {
        extSize = (b[off]<<24)|(b[off+1]<<16)|(b[off+2]<<8)|b[off+3];
      }
      off += extSize;
    }

    while (off + 10 < tagEnd) {
      // Frame ID: 4 ASCII chars
      const fid = String.fromCharCode(b[off],b[off+1],b[off+2],b[off+3]);
      if (fid[0] === '\0') break; // padding

      // Frame size:
      //   ID3v2.3 → plain 32-bit big-endian
      //   ID3v2.4 → syncsafe 32-bit
      let fsz;
      if (major === 4) {
        fsz = ((b[off+4]&0x7F)<<21)|((b[off+5]&0x7F)<<14)|
              ((b[off+6]&0x7F)<<7) | (b[off+7]&0x7F);
      } else {
        fsz = (b[off+4]<<24)|(b[off+5]<<16)|(b[off+6]<<8)|b[off+7];
        if (fsz < 0) fsz = fsz >>> 0;
      }
      off += 10; // past frame header

      if (fsz <= 0 || off + fsz > tagEnd) break;
      const fd = b.subarray(off, off + fsz);

      switch (fid) {
        case 'TIT2': { const v=_id3Text(fd); if(v) result.title       = v; break; }
        case 'TPE1': { const v=_id3Text(fd); if(v) result.artist      = v; break; }
        case 'TDRC':
        case 'TYER': {
          const v = _id3Text(fd);
          if (v && /^\d{4}/.test(v) && !result.releaseDate)
            result.releaseDate = v.slice(0,4)+'-01-01';
          break;
        }
        case 'APIC': {
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

  /** Decode an ID3 text frame: encoding byte (1) + text */
  function _id3Text(data) {
    if (!data || !data.length) return '';
    const enc = data[0];
    const raw = data.subarray(1);
    try {
      let s;
      if      (enc === 1) s = new TextDecoder('utf-16').decode(raw);
      else if (enc === 2) s = new TextDecoder('utf-16be').decode(raw);
      else if (enc === 3) s = new TextDecoder('utf-8').decode(raw);
      else                s = new TextDecoder('latin1').decode(raw);
      return s.replace(/\0/g,'').trim();
    } catch { return ''; }
  }

  /**
   * Decode ID3v2 APIC frame.
   * Layout: encoding(1) | mime(\0) | picType(1) | description(\0 or \0\0) | imageBytes
   */
  function _id3APIC(data) {
    if (!data || data.length < 6) return null;
    let pos = 0;
    const enc = data[pos++];

    // MIME (null-terminated Latin1)
    const mimeStart = pos;
    while (pos < data.length && data[pos] !== 0) pos++;
    let mime = new TextDecoder('latin1').decode(data.slice(mimeStart, pos)).toLowerCase().trim();
    if (pos >= data.length) return null;
    pos++; // consume null

    // Picture type
    if (pos >= data.length) return null;
    pos++; // skip

    // Description: null-terminated (single null for enc 0/3, double null for enc 1/2)
    if (enc === 1 || enc === 2) {
      // Align to even offset if necessary, then scan for \0\0
      while (pos + 1 < data.length) {
        if (data[pos] === 0 && data[pos+1] === 0) { pos += 2; break; }
        pos += 2;
      }
    } else {
      while (pos < data.length && data[pos] !== 0) pos++;
      if (pos < data.length) pos++;
    }

    if (pos >= data.length) return null;

    const img = data.slice(pos); // Uint8Array slice = copy with own buffer
    if (img.length < 4) return null;

    // Detect MIME from magic bytes if missing
    if (!mime || mime === 'image/' || mime === '-->' || mime.length < 6) {
      if      (img[0]===0xFF && img[1]===0xD8)               mime = 'image/jpeg';
      else if (img[0]===0x89 && img[1]===0x50 && img[2]===0x4E) mime = 'image/png';
      else if (img[0]===0x47 && img[1]===0x49 && img[2]===0x46) mime = 'image/gif';
      else if (img[0]===0x52 && img[1]===0x49 && img[2]===0x46 && img[4]===0x57) mime = 'image/webp';
      else    mime = 'image/jpeg';
    }
    return { data: img.buffer, mime };
  }

  /* ──────────────────────────────────────
     MP4 / M4A  ATOM PARSER
     Finds: moov > udta > meta > ilst > covr → data
     Also reads: ©nam (title), ©ART (artist), ©day (date)
  ────────────────────────────────────── */
  function _parseMP4(b, result) {
    // Walk top-level atoms to find 'moov'
    const moov = _mp4FindAtom(b, 0, b.length, 'moov');
    if (!moov) return result;

    // moov > udta > meta > ilst  OR  moov > meta > ilst (iTunes variant)
    let ilst = null;

    const udta = _mp4FindAtom(b, moov.start, moov.end, 'udta');
    if (udta) {
      const meta = _mp4FindAtom(b, udta.start, udta.end, 'meta');
      if (meta) {
        // meta has a 4-byte version/flags field before child atoms
        ilst = _mp4FindAtom(b, meta.start + 4, meta.end, 'ilst');
      }
    }
    // Fallback: moov > meta > ilst
    if (!ilst) {
      const meta = _mp4FindAtom(b, moov.start, moov.end, 'meta');
      if (meta) ilst = _mp4FindAtom(b, meta.start + 4, meta.end, 'ilst');
    }
    if (!ilst) return result;

    // Walk ilst children
    let pos = ilst.start;
    while (pos + 8 < ilst.end) {
      const sz  = _mp4Be32(b, pos);
      if (sz < 8 || pos + sz > ilst.end) break;
      const box = String.fromCharCode(b[pos+4],b[pos+5],b[pos+6],b[pos+7]);

      // Each ilst item contains a 'data' child
      const dataAtom = _mp4FindAtom(b, pos + 8, pos + sz, 'data');
      if (dataAtom && dataAtom.end - dataAtom.start >= 8) {
        // data: version(1) + flags(3) + locale(4) + value
        const typeInt = _mp4Be32(b, dataAtom.start) & 0x00FFFFFF;
        const val     = b.subarray(dataAtom.start + 8, dataAtom.end);

        switch (box) {
          case '\u00a9nam': // ©nam = title
            if (!result.title || result.title === _filenameFallback('').title) {
              const s = _mp4Text(val, typeInt); if (s) result.title = s;
            }
            break;
          case '\u00a9ART': // ©ART = artist
            { const s = _mp4Text(val, typeInt); if (s) result.artist = s; break; }
          case '\u00a9day': // ©day = date/year
            {
              const s = _mp4Text(val, typeInt);
              if (s && /^\d{4}/.test(s) && !result.releaseDate)
                result.releaseDate = s.slice(0,4)+'-01-01';
              break;
            }
          case 'covr':  // cover art
            if (!result.thumbData && val.length > 4) {
              // typeInt: 13=JPEG, 14=PNG
              const mime = typeInt === 14 ? 'image/png' : 'image/jpeg';
              result.thumbData = val.buffer.slice(val.byteOffset, val.byteOffset + val.byteLength);
              result.thumbMime = mime;
            }
            break;
        }
      }
      pos += sz;
    }
    return result;
  }

  function _mp4FindAtom(b, start, end, name) {
    let pos = start;
    while (pos + 8 <= end) {
      let sz = _mp4Be32(b, pos);
      if      (sz === 0) { sz = end - pos; } // atom extends to EOF
      else if (sz === 1) {                   // 64-bit extended size
        sz = _mp4Be32(b, pos + 8) + (_mp4Be32(b, pos + 4) * 0x100000000);
      }
      if (sz < 8 || pos + sz > end + 8) break;
      const box = String.fromCharCode(b[pos+4],b[pos+5],b[pos+6],b[pos+7]);
      if (box === name) return { start: pos + 8, end: Math.min(pos + sz, end) };
      pos += sz;
    }
    return null;
  }

  function _mp4Be32(b, off) {
    return ((b[off]<<24)|(b[off+1]<<16)|(b[off+2]<<8)|b[off+3]) >>> 0;
  }

  function _mp4Text(data, typeInt) {
    try {
      // typeInt 1 = UTF-8, 0 or other = also try UTF-8
      return new TextDecoder('utf-8').decode(data).replace(/\0/g,'').trim();
    } catch { return ''; }
  }

  /* ──────────────────────────────────────
     FLAC METADATA PARSER
     Looks for METADATA_BLOCK_PICTURE (block type 6)
     and VORBIS_COMMENT (block type 4) for title/artist/date
  ────────────────────────────────────── */
  function _parseFLAC(b, result) {
    if (b.length < 8) return result;
    let pos = 4; // skip 'fLaC'
    let last = false;

    while (!last && pos + 4 <= b.length) {
      const hdr      = b[pos];
      last           = !!(hdr & 0x80);
      const blockType= hdr & 0x7F;
      const blockLen = (b[pos+1]<<16)|(b[pos+2]<<8)|b[pos+3];
      pos += 4;
      if (pos + blockLen > b.length) break;
      const block = b.subarray(pos, pos + blockLen);

      if (blockType === 4) {
        // VORBIS_COMMENT
        _parseVorbisComment(block, result);
      } else if (blockType === 6 && !result.thumbData) {
        // METADATA_BLOCK_PICTURE (same as APIC but different layout)
        _parseFLACPicture(block, result);
      }
      pos += blockLen;
    }
    return result;
  }

  function _parseVorbisComment(data, result) {
    // vendor_length(4LE) | vendor(n) | count(4LE) | [length(4LE)|string]*
    if (data.length < 8) return;
    let pos = 0;
    const vendorLen = _le32(data, pos); pos += 4 + vendorLen;
    if (pos + 4 > data.length) return;
    const count = _le32(data, pos); pos += 4;
    for (let i=0; i<count && pos+4<=data.length; i++) {
      const slen = _le32(data, pos); pos += 4;
      if (pos + slen > data.length) break;
      const comment = new TextDecoder('utf-8').decode(data.subarray(pos, pos+slen));
      pos += slen;
      const eq = comment.indexOf('=');
      if (eq < 0) continue;
      const key = comment.slice(0, eq).toUpperCase();
      const val = comment.slice(eq+1).trim();
      if (!val) continue;
      if      (key === 'TITLE'  && !result.title)  result.title  = val;
      else if (key === 'ARTIST' && !result.artist) result.artist = val;
      else if ((key === 'DATE' || key === 'YEAR') && !result.releaseDate && /^\d{4}/.test(val))
        result.releaseDate = val.slice(0,4)+'-01-01';
    }
  }

  function _parseFLACPicture(data, result) {
    if (data.length < 32) return;
    let pos = 0;
    const picType  = _be32(data, pos); pos += 4;
    const mimeLen  = _be32(data, pos); pos += 4;
    const mimeStr  = new TextDecoder('latin1').decode(data.subarray(pos, pos+mimeLen)); pos += mimeLen;
    const descLen  = _be32(data, pos); pos += 4;
    pos += descLen; // skip description
    pos += 16;      // skip width, height, colorDepth, colorCount
    const dataLen  = _be32(data, pos); pos += 4;
    if (pos + dataLen > data.length) return;
    const imgBytes = data.slice(pos, pos + dataLen);
    result.thumbData = imgBytes.buffer.slice(imgBytes.byteOffset, imgBytes.byteOffset + imgBytes.byteLength);
    result.thumbMime = mimeStr || 'image/jpeg';
  }

  function _le32(b, off) {
    return (b[off]|(b[off+1]<<8)|(b[off+2]<<16)|(b[off+3]<<24)) >>> 0;
  }
  function _be32(b, off) {
    return ((b[off]<<24)|(b[off+1]<<16)|(b[off+2]<<8)|b[off+3]) >>> 0;
  }

  /* ════════════════════════════════════════════════════════════════════
     readAudioMeta — reads a File object
     Strategy:
       1. Peek first 12 bytes to identify format + get tag size
       2. Read exactly the required bytes (ID3 tag or full file for M4A/FLAC)
       3. Parse metadata
       4. Get duration via <audio>
  ════════════════════════════════════════════════════════════════════ */
  async function readAudioMeta(file) {
    let meta = _filenameFallback(file.name);

    try {
      // Step 1: peek header
      const hdrBuf = await file.slice(0, 12).arrayBuffer();
      const hdr    = new Uint8Array(hdrBuf);

      let readSize;
      const fourcc = String.fromCharCode(hdr[4],hdr[5],hdr[6],hdr[7]);
      const isMP4  = (fourcc==='ftyp'||fourcc==='moov'||fourcc==='wide'||fourcc==='mdat'||fourcc==='free');
      const isFLAC = (hdr[0]===0x66&&hdr[1]===0x4C&&hdr[2]===0x61&&hdr[3]===0x43);

      if (hdr[0]===0x49 && hdr[1]===0x44 && hdr[2]===0x33 && hdr[3]>=3) {
        // ID3v2: compute exact tag size from syncsafe int
        const tagSize = ((hdr[6]&0x7F)<<21)|((hdr[7]&0x7F)<<14)|
                        ((hdr[8]&0x7F)<<7) | (hdr[9]&0x7F);
        // Allow up to 30 MB for files with large embedded album art
        readSize = Math.min(tagSize + 10, 30 * 1024 * 1024);
      } else if (isMP4 || isFLAC) {
        // Need to find moov/picture block — may be anywhere in the file
        // Read up to 50 MB (most M4A metadata is in the first few MB)
        readSize = Math.min(file.size, 50 * 1024 * 1024);
      } else {
        // Unknown format — try a generous slice anyway
        readSize = Math.min(file.size, 2 * 1024 * 1024);
      }

      // Step 2: read the required portion
      const buf = await file.slice(0, readSize).arrayBuffer();
      meta = parseAudioMetaFromBuffer(buf, file.name);

    } catch (e) {
      console.warn('[Storage] Metadata parse error:', e);
    }

    // Step 3: duration via Audio element
    const duration = await _probeDuration(file);

    return { ...meta, duration };
  }

  function _probeDuration(file) {
    return new Promise(resolve => {
      const url = URL.createObjectURL(file);
      const a   = document.createElement('audio');
      a.src     = url;
      a.preload = 'metadata';
      a.onloadedmetadata = () => { URL.revokeObjectURL(url); resolve(a.duration || 0); };
      a.onerror          = () => { URL.revokeObjectURL(url); resolve(0); };
      setTimeout(()      => { try { URL.revokeObjectURL(url); } catch {} resolve(0); }, 8000);
    });
  }

  /* ════════════════ PUBLIC ════════════════ */
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
