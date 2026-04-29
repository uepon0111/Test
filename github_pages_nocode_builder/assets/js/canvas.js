
import { clamp } from './utils.js';

const HANDLE_POS = ['nw','n','ne','w','e','sw','s','se'];

function styleObjToText(styles = {}) {
  return Object.entries(styles).filter(([,v]) => v !== '' && v != null).map(([k,v]) => `${k.replace(/[A-Z]/g, m => '-' + m.toLowerCase())}:${v}`).join(';');
}

function absolutePos(el, lookupById) {
  let x = Number(el.x || 0);
  let y = Number(el.y || 0);
  let p = el.parentId ? lookupById(el.parentId) : null;
  while (p) {
    x += Number(p.x || 0);
    y += Number(p.y || 0);
    p = p.parentId ? lookupById(p.parentId) : null;
  }
  return { x, y };
}

function renderElementNode(el, state, api, lookupById, selectedId) {
  const node = document.createElement(el.type === 'button' || el.type === 'link' ? 'a' : el.type === 'input' ? 'input' : el.type === 'textarea' ? 'textarea' : el.type === 'select' ? 'select' : el.type === 'image' ? 'img' : el.type === 'video' || el.type === 'map' || el.type === 'iframe' ? 'iframe' : el.type === 'icon' ? 'i' : 'div');
  node.className = 'el';
  node.dataset.id = el.id;
  node.dataset.type = el.type;
  node.style.left = `${el.x || 0}px`;
  node.style.top = `${el.y || 0}px`;
  node.style.width = `${Math.max(1, el.w || 100)}px`;
  node.style.height = `${Math.max(1, el.h || 40)}px`;
  node.style.zIndex = el.zIndex || 1;
  node.style.cssText += `;${styleObjToText(el.styles || {})}`;
  if (el.hidden) node.style.display = 'none';
  if (el.id === selectedId) node.classList.add('selected');

  if (el.animation?.preset && el.animation.preset !== 'none') {
    node.dataset.aos = el.animation.preset;
  }

  switch (el.type) {
    case 'heading1':
      node.textContent = el.text || '見出し';
      break;
    case 'heading2':
      node.textContent = el.text || '見出し';
      break;
    case 'text':
      node.textContent = el.text || '本文';
      break;
    case 'button':
      node.textContent = el.text || 'ボタン';
      node.href = el.attrs?.href || '#';
      node.target = el.attrs?.target || '_self';
      break;
    case 'link':
      node.textContent = el.text || 'リンク';
      node.href = el.attrs?.href || '#';
      break;
    case 'image':
      node.src = el.src || '';
      node.alt = el.alt || 'image';
      break;
    case 'divider':
      node.innerHTML = '';
      node.style.height = '2px';
      break;
    case 'input':
      node.type = 'text';
      node.placeholder = el.attrs?.placeholder || '';
      node.value = el.text || '';
      break;
    case 'textarea':
      node.value = el.text || '';
      node.placeholder = el.attrs?.placeholder || '';
      break;
    case 'select':
      node.innerHTML = (el.options || ['選択肢1','選択肢2']).map(o => `<option>${o}</option>`).join('');
      break;
    case 'checkbox':
    case 'radio':
      node.innerHTML = `<label style="display:flex;align-items:center;gap:8px;font-size:15px;"><input type="${el.type}" name="${el.id}">${el.text || ''}</label>`;
      break;
    case 'video':
    case 'map':
    case 'iframe':
      node.src = el.src || '';
      break;
    case 'icon':
      node.className = `el ${el.iconClass || 'fa-solid fa-star'}`;
      node.style.display = 'inline-flex';
      node.style.alignItems = 'center';
      node.style.justifyContent = 'center';
      break;
    case 'code':
      node.innerHTML = `<pre style="margin:0;white-space:pre-wrap;font-family:var(--mono);font-size:13px;">${(el.text || '').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre>`;
      break;
    case 'spacer':
      node.style.background = 'transparent';
      break;
    case 'shape':
      node.style.borderRadius = el.styles?.borderRadius || '999px';
      break;
    case 'container':
    case 'section':
    case 'navbar':
    case 'footer':
    case 'columns':
    case 'grid':
    case 'form':
    case 'tabs':
    case 'accordion':
    case 'modal':
    case 'carousel':
      node.innerHTML = '';
      break;
    default:
      node.textContent = el.text || el.type;
  }

  if (el.isContainer || ['section','navbar','footer','columns','grid','form','tabs','accordion','modal','carousel','container'].includes(el.type)) {
    node.style.overflow = 'hidden';
  }

  if (selectedId === el.id) {
    const badge = document.createElement('div');
    badge.className = 'badge';
    badge.textContent = el.type;
    node.appendChild(badge);
    HANDLE_POS.forEach(pos => {
      const h = document.createElement('div');
      h.className = `handle ${pos}`;
      h.dataset.handle = pos;
      node.appendChild(h);
    });
  }

  node.addEventListener('mousedown', (ev) => {
    ev.stopPropagation();
    api.selectElement(el.id);
    const handle = ev.target.closest('.handle');
    if (handle) {
      api.beginResize(el.id, handle.dataset.handle, ev);
    } else {
      api.beginDrag(el.id, ev);
    }
  });
  node.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    api.openContextMenu(el.id, ev.clientX, ev.clientY);
  });
  node.addEventListener('dblclick', (ev) => {
    ev.stopPropagation();
    if (el.type === 'text' || el.type.startsWith('heading') || el.type === 'button' || el.type === 'link') api.beginInlineEdit(el.id, ev);
  });

  if (el.children?.length) {
    el.children.forEach(ch => {
      const child = renderElementNode(ch, state, api, lookupById, selectedId);
      node.appendChild(child);
    });
  }
  return node;
}

export class CanvasView {
  constructor(root, api) {
    this.root = root;
    this.api = api;
    this.drag = null;
    this.resize = null;
  }

  render(state) {
    const page = this.api.getCurrentPage();
    const lookupById = this.api.lookupById;
    const previewMode = state.ui?.previewMode || 'desktop';
    const width = previewMode === 'desktop' ? (page?.width || 1440) : previewMode === 'tablet' ? 768 : 375;
    const height = page?.height || 2400;
    const scale = this.api.getScaleForPreview(width);
    this.root.innerHTML = `
      <div class="canvas-shell active-mobile">
        <div class="canvas-toolbar">
          <button class="btn small ${previewMode==='desktop'?'primary':''}" data-mode="desktop"><i class="fa-solid fa-desktop"></i>PC</button>
          <button class="btn small ${previewMode==='tablet'?'primary':''}" data-mode="tablet"><i class="fa-solid fa-tablet-screen-button"></i>タブレット</button>
          <button class="btn small ${previewMode==='mobile'?'primary':''}" data-mode="mobile"><i class="fa-solid fa-mobile-screen-button"></i>スマホ</button>
          <span class="chip">幅 ${width}px</span>
          <span class="chip">スナップ ${state.settings.gridSnap || 8}px</span>
          <label class="chip"><input type="checkbox" data-toggle="grid" ${state.ui?.showGrid !== false ? 'checked' : ''}> グリッド</label>
          <label class="chip"><input type="checkbox" data-toggle="guides" ${state.ui?.showGuides !== false ? 'checked' : ''}> ガイド</label>
          <div class="spacer"></div>
          <button class="btn small" data-act="preview"><i class="fa-solid fa-up-right-from-square"></i>別タブで確認</button>
          <button class="btn small" data-act="export-inline"><i class="fa-solid fa-file-code"></i>1ファイル出力</button>
        </div>
        <div class="canvas-area">
          <div class="viewport-wrap">
            <div id="viewport" class="viewport ${state.ui?.showGrid !== false ? 'viewport-grid-on' : ''}" style="width:${width}px;height:${height}px;transform:scale(${scale});--grid-size:${state.settings.gridSnap || 8}px;">
              ${this._renderStage(state, page, lookupById)}
            </div>
          </div>
        </div>
      </div>
    `;
    this._bind(state);
  }

  _renderStage(state, page, lookupById) {
    const selectedId = this.api.selectedId;
    const stage = document.createElement('div');
    stage.className = 'canvas-stage';
    stage.style.width = '100%';
    stage.style.height = '100%';
    const masterTop = document.createElement('div');
    masterTop.className = 'canvas-master';
    masterTop.style.top = '0';
    if (state.master?.header) {
      const header = renderElementNode(state.master.header, state, this.api, lookupById, selectedId);
      header.dataset.master = 'header';
      header.style.left = `${header.x || 0}px`;
      header.style.top = `${header.y || 0}px`;
      masterTop.appendChild(header);
    }
    const root = document.createElement('div');
    root.style.position = 'relative';
    root.style.width = '100%';
    root.style.height = '100%';

    (page?.components || []).forEach(ch => {
      const node = renderElementNode(ch, state, this.api, lookupById, selectedId);
      root.appendChild(node);
    });
    if (state.master?.footer) {
      const footer = renderElementNode(state.master.footer, state, this.api, lookupById, selectedId);
      footer.dataset.master = 'footer';
      footer.style.top = `${Math.max((page?.height || 1200) - (footer.h || 120), 0)}px`;
      root.appendChild(footer);
    }
    stage.appendChild(masterTop);
    stage.appendChild(root);
    return stage.innerHTML;
  }

  _bind(state){
    const viewport = this.root.querySelector('#viewport');
    if (!viewport) return;

    this.root.querySelectorAll('[data-mode]').forEach(btn => {
      btn.addEventListener('click', () => this.api.setPreviewMode(btn.dataset.mode));
    });
    this.root.querySelector('[data-toggle="grid"]').addEventListener('change', (e) => this.api.setUiSetting('showGrid', e.target.checked));
    this.root.querySelector('[data-toggle="guides"]').addEventListener('change', (e) => this.api.setUiSetting('showGuides', e.target.checked));
    this.root.querySelector('[data-act="preview"]').addEventListener('click', () => this.api.openPreview());
    this.root.querySelector('[data-act="export-inline"]').addEventListener('click', () => this.api.exportInline());

    viewport.addEventListener('dragover', (e) => e.preventDefault());
    viewport.addEventListener('drop', (e) => {
      e.preventDefault();
      const type = e.dataTransfer.getData('text/plain');
      if (!type) return;
      const rect = viewport.getBoundingClientRect();
      const scale = rect.width / viewport.clientWidth;
      const x = (e.clientX - rect.left) / scale;
      const y = (e.clientY - rect.top) / scale;
      this.api.addComponentAt(type, x, y);
    });
    const onMove = (ev) => {
      if (this.drag) this.api.updateDrag(this.drag, ev, viewport);
      if (this.resize) this.api.updateResize(this.resize, ev, viewport);
    };
    const onUp = (ev) => {
      if (this.drag) this.api.endDrag(this.drag, ev, viewport);
      if (this.resize) this.api.endResize(this.resize, ev, viewport);
      this.drag = null;
      this.resize = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    this.api.beginDrag = (id, ev) => {
      const el = this.api.findById(id);
      if (!el || el.locked) return;
      const parent = el.parentId ? this.api.findById(el.parentId) : null;
      this.drag = {
        id,
        startX: ev.clientX,
        startY: ev.clientY,
        originX: el.x || 0,
        originY: el.y || 0,
        parentId: el.parentId || null,
        parentAbs: parent ? absolutePos(parent, lookupById) : { x: 0, y: 0 },
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    };
    this.api.beginResize = (id, handle, ev) => {
      const el = this.api.findById(id);
      if (!el || el.locked) return;
      this.resize = {
        id, handle,
        startX: ev.clientX, startY: ev.clientY,
        origin: { x: el.x || 0, y: el.y || 0, w: el.w || 100, h: el.h || 40 },
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    };
  }
}
