
import { templates } from './templates.js';
import { COMPONENT_DEFS, createComponent, componentDefMap, defaultMasterComponents } from './components.js';
import { clone, uid, clamp, px, toNum } from './utils.js';
import { loadState, saveState, clearState, exportStateJson, importStateFromJson } from './storage.js';
import { HistoryManager } from './history.js';
import { CanvasView } from './canvas.js';
import { renderInspector } from './inspector.js';
import { CodeEditor } from './code-editor.js';
import { exportAsZip, exportInlineHtml, exportCssText, exportJsText, previewInNewTab, deployToGithub, exportHtmlText } from './export.js';
import { defaultLogicRule, triggerOptions, actionOptions } from './logic.js';

const initialProject = () => ({
  settings: {
    title: '新規サイト',
    accent: '#3b82f6',
    pageBg: '#ffffff',
    gridSnap: 8,
    autosave: true,
    responsive: true,
    zipName: 'site',
    htmlTitle: '新規サイト',
  },
  pages: [{ id: uid('page'), name: 'Top', slug: 'index', width: 1440, height: 2400, components: [], css: '', js: '', head: '', bodyClass: '' }],
  currentPageId: null,
  master: { header: defaultMasterComponents()[0], footer: defaultMasterComponents()[1] },
  assets: [],
  customComponents: [],
  logicRules: [],
  ui: { previewMode: 'desktop', showGrid: true, showGuides: true, leftTab: 'parts', rightTab: 'props', mobileTab: 'canvas' },
});
const starter = initialProject();
starter.currentPageId = starter.pages[0].id;

function normalizeProject(data) {
  const p = clone(data || initialProject());
  p.settings ||= {};
  p.ui ||= {};
  p.pages ||= [];
  if (!p.pages.length) p.pages = [{ id: uid('page'), name: 'Top', slug: 'index', width: 1440, height: 2400, components: [], css: '', js: '', head: '', bodyClass: '' }];
  if (!p.currentPageId) p.currentPageId = p.pages[0].id;
  p.master ||= { header: defaultMasterComponents()[0], footer: defaultMasterComponents()[1] };
  p.logicRules ||= [];
  p.assets ||= [];
  p.customComponents ||= [];
  Object.assign(p.settings, { accent: '#3b82f6', pageBg: '#ffffff', gridSnap: 8, autosave: true, responsive: true, title: '新規サイト', htmlTitle: '新規サイト', zipName: 'site' }, p.settings);
  Object.assign(p.ui, { previewMode: 'desktop', showGrid: true, showGuides: true, leftTab: 'parts', rightTab: 'props', mobileTab: 'canvas' }, p.ui);
  if (!p.pages.find(pg => pg.id === p.currentPageId)) p.currentPageId = p.pages[0].id;
  return p;
}

class App {
  constructor(root) {
    this.root = root;
    this.state = normalizeProject(loadState() || starter);
    this.history = new HistoryManager(100);
    this.history.push(this.state);
    this.selectedId = null;
    this.codeEditor = null;
    this.canvasView = null;
    this.modalRoot = document.getElementById('modal-root');
    this.contextMenu = document.getElementById('context-menu');
    this._bindKeyboard();
    this._renderShell();
    this._showWelcome();
    this.render();
    if (this.state.settings.autosave) saveState(this.state);
    setInterval(() => { if (this.state.settings.autosave) saveState(this.state); }, 60_000);
  }

  getCurrentPage() { return this.state.pages.find(p => p.id === this.state.currentPageId) || this.state.pages[0]; }
  getSelectedElement() { return this.findById(this.selectedId); }
  findById(id) {
    if (!id) return null;
    const walk = (nodes) => {
      for (const n of nodes || []) {
        if (n.id === id) return n;
        const nested = walk(n.children || []);
        if (nested) return nested;
      }
      return null;
    };
    return walk([this.state.master.header, this.state.master.footer, ...this.getCurrentPage().components]);
  }
  lookupById = (id) => this.findById(id);
  getScaleForPreview(width) {
    const max = Math.max(280, this.root.clientWidth - 56);
    return Math.min(1, max / width);
  }

  _renderShell() {
    this.root.innerHTML = `
      <div class="topbar">
        <div class="brand">
          <div class="logo"><i class="fa-solid fa-sitemap"></i></div>
          <div>
            <div>GitHub Pages ノーコードビルダー</div>
            <div class="note">HTML / CSS / JS を分割生成し、GitHub Pages へ書き出せます</div>
          </div>
        </div>
        <div class="toolbar-actions">
          <button class="btn small" data-act="undo"><i class="fa-solid fa-arrow-rotate-left"></i>元に戻す</button>
          <button class="btn small" data-act="redo"><i class="fa-solid fa-arrow-rotate-right"></i>やり直す</button>
          <button class="btn small" data-act="save"><i class="fa-solid fa-floppy-disk"></i>保存</button>
          <button class="btn small" data-act="import"><i class="fa-solid fa-file-import"></i>読み込み</button>
          <button class="btn small" data-act="export-json"><i class="fa-solid fa-file-export"></i>JSON出力</button>
          <button class="btn small" data-act="new-page"><i class="fa-solid fa-file-circle-plus"></i>ページ追加</button>
          <button class="btn small" data-act="template"><i class="fa-solid fa-wand-magic-sparkles"></i>テンプレート</button>
        </div>
        <div class="spacer"></div>
        <button class="btn small primary" data-act="export-zip"><i class="fa-solid fa-box-archive"></i>ZIP出力</button>
        <button class="btn small" data-act="github"><i class="fa-brands fa-github"></i>GitHubデプロイ</button>
      </div>
      <div class="workspace">
        <aside id="left-panel" class="panel left"></aside>
        <main id="canvas-panel" class="canvas-shell"></main>
        <aside id="right-panel" class="panel right"></aside>
      </div>
      <div class="mobile-tabs">
        <button data-mobile="parts"><i class="fa-solid fa-puzzle-piece"></i><span>パーツ</span></button>
        <button data-mobile="canvas"><i class="fa-solid fa-pen-ruler"></i><span>編集</span></button>
        <button data-mobile="layers"><i class="fa-solid fa-layer-group"></i><span>レイヤー</span></button>
        <button data-mobile="props"><i class="fa-solid fa-sliders"></i><span>設定</span></button>
      </div>
    `;
    this.leftPanel = this.root.querySelector('#left-panel');
    this.canvasPanel = this.root.querySelector('#canvas-panel');
    this.rightPanel = this.root.querySelector('#right-panel');
    this.canvasView = new CanvasView(this.canvasPanel, this);
    this._bindTopbar();
    this._bindMobileTabs();
  }

  _bindTopbar() {
    this.root.querySelector('[data-act="undo"]').addEventListener('click', () => this.undo());
    this.root.querySelector('[data-act="redo"]').addEventListener('click', () => this.redo());
    this.root.querySelector('[data-act="save"]').addEventListener('click', () => this.saveProject(true));
    this.root.querySelector('[data-act="import"]').addEventListener('click', () => this.importProject());
    this.root.querySelector('[data-act="export-json"]').addEventListener('click', () => this.exportJson());
    this.root.querySelector('[data-act="new-page"]').addEventListener('click', () => this.addPage());
    this.root.querySelector('[data-act="template"]').addEventListener('click', () => this.openTemplatePicker());
    this.root.querySelector('[data-act="export-zip"]').addEventListener('click', () => this.exportZip());
    this.root.querySelector('[data-act="github"]').addEventListener('click', () => this.openGithubModal());
  }

  _bindMobileTabs() {
    this.root.querySelectorAll('[data-mobile]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.state.ui.mobileTab = btn.dataset.mobile;
        this.render();
      });
    });
  }

  render() {
    this._renderLeftPanel();
    this._renderCanvas();
    this._renderRightPanel();
    this._syncMobileVisibility();
    this._updateTopbar();
    if (this.state.settings.autosave) saveState(this.state);
  }

  _updateTopbar() {
    this.root.querySelectorAll('.mobile-tabs button').forEach(btn => btn.classList.toggle('active', btn.dataset.mobile === this.state.ui.mobileTab));
  }

  _syncMobileVisibility() {
    this.leftPanel.classList.remove('active-mobile');
    this.canvasPanel.classList.remove('active-mobile');
    this.rightPanel.classList.remove('active-mobile');
    if (window.matchMedia('(max-width: 900px)').matches) {
      const map = { parts: this.leftPanel, canvas: this.canvasPanel, layers: this.leftPanel, props: this.rightPanel };
      const active = map[this.state.ui.mobileTab] || this.canvasPanel;
      active.classList.add('active-mobile');
      if (this.state.ui.mobileTab === 'layers') {
        this.state.ui.leftTab = 'layers';
        this._renderLeftPanel();
      }
      if (this.state.ui.mobileTab === 'parts') {
        this.state.ui.leftTab = 'parts';
        this._renderLeftPanel();
      }
      if (this.state.ui.mobileTab === 'props') {
        this.state.ui.rightTab = 'props';
        this._renderRightPanel();
      }
    } else {
      this.leftPanel.classList.add('active-mobile');
      this.canvasPanel.classList.add('active-mobile');
      this.rightPanel.classList.add('active-mobile');
    }
  }

  _renderLeftPanel() {
    const page = this.getCurrentPage();
    const paletteHtml = `
      <div class="panel-header">
        <div class="panel-title"><i class="fa-solid fa-puzzle-piece"></i> パーツ / ページ / レイヤー</div>
        <button class="btn small" data-act="add-page-inline"><i class="fa-solid fa-plus"></i>ページ</button>
      </div>
      <div class="panel-body">
        <div class="section">
          <div class="section-head"><span>ページ</span><span class="chip">${this.state.pages.length}件</span></div>
          <div class="section-body">
            <div class="list">
              ${this.state.pages.map(pg => `
                <button class="btn ${pg.id === this.state.currentPageId ? 'primary' : ''}" style="justify-content:space-between" data-page-id="${pg.id}">
                  <span><i class="fa-regular fa-file"></i> ${pg.name}</span>
                  <span class="note">${pg.width}px</span>
                </button>
              `).join('')}
            </div>
          </div>
        </div>
        <div class="section">
          <div class="section-head"><span>テンプレート</span></div>
          <div class="section-body">
            <div class="palette">
              ${Object.entries(templates).map(([key, fn]) => `
                <button class="item" data-template="${key}">
                  <div class="iconbox"><i class="fa-solid fa-wand-magic-sparkles"></i></div>
                  <div class="meta"><div class="name">${this._templateName(key)}</div><div class="desc">編集後に変更可能</div></div>
                </button>
              `).join('')}
            </div>
          </div>
        </div>
        <div class="section">
          <div class="section-head"><span>パーツ一覧</span><span class="chip">ドラッグで追加</span></div>
          <div class="section-body">
            <div class="palette">
              ${COMPONENT_DEFS.map(def => `
                <button class="item" draggable="true" data-add="${def.type}">
                  <div class="iconbox"><i class="fa-solid ${def.icon}"></i></div>
                  <div class="meta"><div class="name">${def.label}</div><div class="desc">${def.category}</div></div>
                </button>
              `).join('')}
            </div>
          </div>
        </div>
        <div class="section">
          <div class="section-head"><span>レイヤー</span><button class="btn small" data-act="refresh-layers"><i class="fa-solid fa-rotate"></i></button></div>
          <div class="section-body">
            ${this._renderTree(page.components || [])}
          </div>
        </div>
        <div class="section">
          <div class="section-head"><span>アセット</span></div>
          <div class="section-body">
            <input class="input" type="file" data-act="asset-file" accept="image/*,video/*,application/pdf" />
            <div class="note">画像はBase64化して埋め込みできます。GitHub Pages環境向けです。</div>
            <div class="list" style="margin-top:10px">
              ${(this.state.assets || []).map(a => `<div class="tree-item"><span class="label">${a.name}</span><span class="note">${a.type}</span></div>`).join('') || '<div class="note">アセットはまだありません。</div>'}
            </div>
          </div>
        </div>
        <div class="section">
          <div class="section-head"><span>共通コンポーネント</span></div>
          <div class="section-body">
            <button class="btn small" data-act="save-component"><i class="fa-solid fa-bookmark"></i>選択要素を保存</button>
            <div class="list" style="margin-top:10px">
              ${(this.state.customComponents || []).map(c => `<div class="tree-item"><span class="label">${c.name}</span><span class="note">${c.type}</span></div>`).join('') || '<div class="note">保存済みコンポーネントはありません。</div>'}
            </div>
          </div>
        </div>
      </div>
    `;
    this.leftPanel.innerHTML = paletteHtml;
    this.leftPanel.querySelectorAll('[data-page-id]').forEach(btn => btn.addEventListener('click', () => this.setCurrentPage(btn.dataset.pageId)));
    this.leftPanel.querySelectorAll('[data-template]').forEach(btn => btn.addEventListener('click', () => this.applyTemplate(btn.dataset.template)));
    this.leftPanel.querySelectorAll('[data-add]').forEach(btn => {
      btn.addEventListener('click', () => this.addComponent(btn.dataset.add));
      btn.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', btn.dataset.add); });
    });
    this.leftPanel.querySelector('[data-act="refresh-layers"]')?.addEventListener('click', () => this.render());
    this.leftPanel.querySelector('[data-act="add-page-inline"]')?.addEventListener('click', () => this.addPage());
    this.leftPanel.querySelector('[data-act="asset-file"]')?.addEventListener('change', (e) => this.importAsset(e.target.files?.[0]));
    this.leftPanel.querySelector('[data-act="save-component"]')?.addEventListener('click', () => this.saveSelectedAsComponent());
    this.leftPanel.querySelectorAll('[data-select]').forEach(btn => btn.addEventListener('click', () => this.selectElement(btn.dataset.select)));
    this.leftPanel.querySelectorAll('[data-hide]').forEach(btn => btn.addEventListener('click', () => this.toggleHidden(btn.dataset.hide)));
    this.leftPanel.ondragover = (e) => e.preventDefault();
    this.leftPanel.ondrop = (e) => {
      e.preventDefault();
      const type = e.dataTransfer.getData('text/plain');
      if (type) this.addComponent(type);
    };
  }

  _renderTree(nodes, depth = 0) {
    const items = [];
    const walk = (arr, lvl) => {
      arr.forEach(node => {
        items.push(`
          <div class="tree-item ${node.id === this.selectedId ? 'selected' : ''}" style="margin-left:${lvl * 10}px">
            <div class="left">
              <i class="fa-solid ${componentDefMap[node.type]?.icon || 'fa-square'}"></i>
              <span class="label">${node.text || componentDefMap[node.type]?.label || node.type}</span>
            </div>
            <div style="display:flex;gap:6px">
              <button class="btn small icon" data-select="${node.id}" title="選択"><i class="fa-regular fa-circle"></i></button>
              <button class="btn small icon" data-hide="${node.id}" title="表示切替"><i class="fa-solid ${node.hidden ? 'fa-eye-slash' : 'fa-eye'}"></i></button>
            </div>
          </div>
        `);
        if (node.children?.length) walk(node.children, lvl + 1);
      });
    };
    walk(nodes, depth);
    return `<div class="tree">${items.join('')}</div>`;
  }

  _renderCanvas() {
    this.canvasView.render(this.state);
  }

  _renderRightPanel() {
    this.rightPanel.innerHTML = `
      <div class="panel-header">
        <div class="panel-title"><i class="fa-solid fa-sliders"></i> 設定</div>
        <div style="display:flex;gap:6px">
          <button class="btn small ${this.state.ui.rightTab==='props' ? 'primary' : ''}" data-right="props">プロパティ</button>
          <button class="btn small ${this.state.ui.rightTab==='code' ? 'primary' : ''}" data-right="code">コード</button>
          <button class="btn small ${this.state.ui.rightTab==='logic' ? 'primary' : ''}" data-right="logic">ロジック</button>
          <button class="btn small ${this.state.ui.rightTab==='settings' ? 'primary' : ''}" data-right="settings">設定</button>
        </div>
      </div>
      <div id="right-panel-inner" class="panel-body"></div>
    `;
    this.rightPanel.querySelectorAll('[data-right]').forEach(btn => btn.addEventListener('click', () => {
      this.state.ui.rightTab = btn.dataset.right;
      this.render();
    }));
    const inner = this.rightPanel.querySelector('#right-panel-inner');
    if (this.state.ui.rightTab === 'props') {
      renderInspector(inner, this.state, this);
    } else if (this.state.ui.rightTab === 'code') {
      this._renderCode(inner);
    } else if (this.state.ui.rightTab === 'logic') {
      this._renderLogicPanel(inner);
    } else {
      this._renderSettingsPanel(inner);
    }
  }

  _renderCode(inner) {
    if (!this.codeEditor) {
      this.codeEditor = new CodeEditor(inner, (mode) => {
        if (mode === 'reload') {
          this._syncCodeEditor();
          return;
        }
        this.applyCodeEditor();
      });
      this._syncCodeEditor();
    } else {
      inner.innerHTML = '';
      this.codeEditor.root = inner;
      this.codeEditor._render();
      this._syncCodeEditor();
    }
    this._syncCodeEditor();
  }

  _syncCodeEditor() {
    if (!this.codeEditor) return;
    const page = this.getCurrentPage();
    const raw = JSON.stringify(this.state, null, 2);
    this.codeEditor.setValues({
      html: this._buildReadableHtml(),
      css: exportCssText(this.state, page),
      js: exportJsText(this.state, page),
      raw,
    });
  }

  _buildReadableHtml() {
    const page = this.getCurrentPage();
    return exportHtmlText(this.state, page, true);
  }

  applyCodeEditor() {
    if (!this.codeEditor) return;
    const { html, css, js, raw } = this.codeEditor.getValues();
    try {
      const parsed = JSON.parse(raw);
      this.state = normalizeProject(parsed);
      this.history.push(this.state);
      this.render();
      return;
    } catch {}
    const page = this.getCurrentPage();
    page.css = css;
    page.js = js;
    const title = html.match(/<title>(.*?)<\/title>/i)?.[1];
    if (title) this.state.settings.title = title;
    this.history.push(this.state);
    this.render();
  }

  _renderLogicPanel(inner) {
    inner.innerHTML = `
      <div class="section">
        <div class="section-head"><span>ビジュアルロジック</span><button class="btn small" data-act="logic-add">追加</button></div>
        <div class="section-body">
          <div class="note">イベント条件に応じて要素の表示切替、クラス追加、ページ遷移、カスタムJSの実行を設定できます。</div>
          <div class="list" style="margin-top:10px">
            ${(this.state.logicRules || []).map(rule => `
              <div class="section" style="margin:0">
                <div class="section-body">
                  <div class="property-grid">
                    <div class="field">
                      <label>トリガー</label>
                      <select class="select" data-rule="${rule.id}" data-prop="trigger">
                        ${triggerOptions.map(o => `<option value="${o.value}" ${rule.trigger===o.value?'selected':''}>${o.label}</option>`).join('')}
                      </select>
                    </div>
                    <div class="field">
                      <label>アクション</label>
                      <select class="select" data-rule="${rule.id}" data-prop="action">
                        ${actionOptions.map(o => `<option value="${o.value}" ${rule.action===o.value?'selected':''}>${o.label}</option>`).join('')}
                      </select>
                    </div>
                  </div>
                  <div class="property-grid">
                    <div class="field"><label>対象要素ID</label><input class="input" data-rule="${rule.id}" data-prop="targetId" value="${rule.targetId || ''}"></div>
                    <div class="field"><label>値 / クラス名 / URL</label><input class="input" data-rule="${rule.id}" data-prop="value" value="${rule.value || ''}"></div>
                  </div>
                  <div class="field"><label>カスタムJS</label><textarea class="textarea" data-rule="${rule.id}" data-prop="customCode">${rule.customCode || ''}</textarea></div>
                  <div style="display:flex;justify-content:flex-end"><button class="btn small danger" data-rule-remove="${rule.id}">削除</button></div>
                </div>
              </div>
            `).join('') || '<div class="note">ルールはありません。</div>'}
          </div>
        </div>
      </div>
    `;
    inner.querySelector('[data-act="logic-add"]')?.addEventListener('click', () => this.addLogicRule(defaultLogicRule()));
    inner.querySelectorAll('[data-rule-remove]').forEach(btn => btn.addEventListener('click', () => this.removeLogicRule(btn.dataset.ruleRemove)));
    inner.querySelectorAll('[data-rule][data-prop]').forEach(input => {
      input.addEventListener('input', () => this.updateRuleFromInspector(input.dataset.rule, input.dataset.prop, input.value));
      input.addEventListener('change', () => this.updateRuleFromInspector(input.dataset.rule, input.dataset.prop, input.value));
    });
  }

  _renderSettingsPanel(inner) {
    inner.innerHTML = `
      <div class="section">
        <div class="section-head"><span>プロジェクト設定</span></div>
        <div class="section-body">
          <div class="field"><label>サイトタイトル</label><input class="input" data-setting="title" value="${this.state.settings.title || ''}"></div>
          <div class="field"><label>HTMLタイトル</label><input class="input" data-setting="htmlTitle" value="${this.state.settings.htmlTitle || ''}"></div>
          <div class="field"><label>ZIP名</label><input class="input" data-setting="zipName" value="${this.state.settings.zipName || 'site'}"></div>
          <div class="property-grid">
            <div class="field"><label>アクセントカラー</label><input class="input" data-setting="accent" type="color" value="${this.state.settings.accent || '#3b82f6'}"></div>
            <div class="field"><label>背景色</label><input class="input" data-setting="pageBg" type="color" value="${this.state.settings.pageBg || '#ffffff'}"></div>
          </div>
          <div class="field"><label>グリッド間隔</label><input class="input" data-setting="gridSnap" type="number" value="${this.state.settings.gridSnap || 8}"></div>
          <div class="field inline"><input type="checkbox" data-setting="autosave" ${this.state.settings.autosave ? 'checked' : ''}><label>LocalStorageへ即時保存</label></div>
          <div class="field inline"><input type="checkbox" data-setting="responsive" ${this.state.settings.responsive ? 'checked' : ''}><label>レスポンシブ対応</label></div>
          <div class="field inline"><input type="checkbox" data-setting="showGuides" ${this.state.ui.showGuides ? 'checked' : ''}><label>ガイド表示</label></div>
        </div>
      </div>
      <div class="section">
        <div class="section-head"><span>マスターコンポーネント</span></div>
        <div class="section-body">
          <div class="note">ヘッダー / フッターは全ページに即時反映されます。</div>
          <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
            <button class="btn small" data-act="edit-master-header">ヘッダー編集</button>
            <button class="btn small" data-act="edit-master-footer">フッター編集</button>
            <button class="btn small" data-act="sync-master">同期</button>
          </div>
        </div>
      </div>
    `;
    inner.querySelectorAll('[data-setting]').forEach(inp => {
      inp.addEventListener('input', () => {
        const key = inp.dataset.setting;
        const value = inp.type === 'checkbox' ? inp.checked : inp.type === 'number' ? Number(inp.value) : inp.value;
        if (key in this.state.settings) this.state.settings[key] = value;
        else if (key in this.state.ui) this.state.ui[key] = value;
        this.render();
      });
      inp.addEventListener('change', () => {
        const key = inp.dataset.setting;
        const value = inp.type === 'checkbox' ? inp.checked : inp.type === 'number' ? Number(inp.value) : inp.value;
        if (key in this.state.settings) this.state.settings[key] = value;
        else if (key in this.state.ui) this.state.ui[key] = value;
        this.history.push(this.state);
        this.render();
      });
    });
    inner.querySelector('[data-act="edit-master-header"]')?.addEventListener('click', () => this.editMaster('header'));
    inner.querySelector('[data-act="edit-master-footer"]')?.addEventListener('click', () => this.editMaster('footer'));
    inner.querySelector('[data-act="sync-master"]')?.addEventListener('click', () => this.syncMasterToAllPages());
  }

  _templateName(key) {
    return { blank: '空白', portfolio: 'ポートフォリオ', lp: 'LP', corporate: 'コーポレート', blog: 'ブログ風', ec: 'EC風' }[key] || key;
  }

  _showWelcome() {
    this.openModal(`
      <div class="modal">
        <div class="modal-header">
          <strong>新規作成</strong>
          <button class="btn icon" data-close><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="modal-body">
          <div class="modal-grid">
            <div class="section">
              <div class="section-head"><span>空白から開始</span></div>
              <div class="section-body">
                <div class="note">一から編集できます。</div>
                <button class="btn primary" data-template="blank" style="margin-top:10px">開始</button>
              </div>
            </div>
            <div class="section">
              <div class="section-head"><span>テンプレートから開始</span></div>
              <div class="section-body">
                <div class="palette">
                  ${Object.keys(templates).map(k => `<button class="item" data-template="${k}"><div class="iconbox"><i class="fa-solid fa-wand-magic-sparkles"></i></div><div class="meta"><div class="name">${this._templateName(k)}</div><div class="desc">編集可能</div></div></button>`).join('')}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `);
    this.modalRoot.querySelector('[data-close]')?.addEventListener('click', () => this.closeModal());
    this.modalRoot.querySelectorAll('[data-template]').forEach(btn => btn.addEventListener('click', () => { this.applyTemplate(btn.dataset.template); this.closeModal(); }));
  }

  openModal(html, onMount) {
    this.modalRoot.innerHTML = `<div class="modal-backdrop">${html}</div>`;
    if (onMount) onMount(this.modalRoot.querySelector('.modal'));
    this.modalRoot.querySelector('[data-close]')?.addEventListener('click', () => this.closeModal());
    this.modalRoot.querySelector('.modal-backdrop')?.addEventListener('click', (e) => {
      if (e.target.classList.contains('modal-backdrop')) this.closeModal();
    });
  }
  closeModal(){ this.modalRoot.innerHTML = ''; }

  setCurrentPage(id) { this.state.currentPageId = id; this.selectedId = null; this.render(); this.history.push(this.state); }
  setPreviewMode(mode) { this.state.ui.previewMode = mode; this.render(); this.history.push(this.state); }
  setUiSetting(key, value) { this.state.ui[key] = value; this.render(); this.history.push(this.state); }
  selectElement(id) { this.selectedId = id; this.render(); }

  getElementStoreForCurrentPage() { return this.getCurrentPage().components; }

  addPage() {
    const num = this.state.pages.length + 1;
    const page = { id: uid('page'), name: `Page ${num}`, slug: `page-${num}`, width: 1440, height: 2400, components: [], css: '', js: '', head: '', bodyClass: '' };
    this.state.pages.push(page);
    this.setCurrentPage(page.id);
    this.history.push(this.state);
  }

  applyTemplate(key) {
    const tpl = templates[key];
    if (!tpl) return;
    const data = tpl();
    this.state.settings.title = data.title || this.state.settings.title;
    this.state.pages = data.pages;
    this.state.currentPageId = this.state.pages[0].id;
    this.state.logicRules = [];
    this.selectedId = null;
    this.history.push(this.state);
    this.render();
  }

  addComponent(type) {
    const page = this.getCurrentPage();
    const el = createComponent(type, 80, 80);
    const scale = this.state.ui.previewMode === 'desktop' ? page.width : this.state.ui.previewMode === 'tablet' ? 768 : 375;
    el.x = 120;
    el.y = 120 + (page.components?.length || 0) * 16;
    if (type === 'section' || type === 'container' || type === 'columns' || type === 'grid' || type === 'form' || type === 'tabs' || type === 'accordion' || type === 'modal' || type === 'carousel' || type === 'navbar' || type === 'footer') {
      el.x = 70;
      el.y = 60 + (page.components?.length || 0) * 20;
      if (type === 'footer') el.y = Math.max((page.height || 2400) - 180, 100);
    }
    page.components.push(el);
    this.selectedId = el.id;
    this.history.push(this.state);
    this.render();
  }
  addComponentAt(type, x, y) {
    const page = this.getCurrentPage();
    const el = createComponent(type, x, y);
    const snap = this.state.settings.gridSnap || 8;
    el.x = Math.round(x / snap) * snap;
    el.y = Math.round(y / snap) * snap;
    if (type === 'section' || type === 'container' || type === 'columns' || type === 'grid' || type === 'form' || type === 'tabs' || type === 'accordion' || type === 'modal' || type === 'carousel' || type === 'navbar' || type === 'footer') {
      el.w = Math.max(el.w || 1000, page.width - 120);
    }
    page.components.push(el);
    this.selectedId = el.id;
    this.history.push(this.state);
    this.render();
  }


  duplicateSelected() {
    const el = this.getSelectedElement();
    if (!el) return;
    const regenIds = (node) => {
      node.id = uid('el');
      if (node.children?.length) node.children.forEach(ch => regenIds(ch));
      return node;
    };
    const copy = regenIds(clone(el));
    copy.x += 24; copy.y += 24;
    const page = this.getCurrentPage();
    const insertInto = (nodes) => {
      for (let i = 0; i < nodes.length; i++) {
        if (nodes[i].id === el.id) {
          nodes.splice(i + 1, 0, copy);
          return true;
        }
        if (nodes[i].children?.length && insertInto(nodes[i].children)) return true;
      }
      return false;
    };
    insertInto(page.components) || page.components.push(copy);
    this.selectedId = copy.id;
    this.history.push(this.state);
    this.render();
  }

  deleteSelected() {
    if (!this.selectedId) return;
    const page = this.getCurrentPage();
    const remove = (nodes) => {
      const idx = nodes.findIndex(n => n.id === this.selectedId);
      if (idx >= 0) return nodes.splice(idx, 1);
      for (const n of nodes) if (n.children?.length && remove(n.children)) return true;
      return false;
    };
    if (this.state.master.header.id === this.selectedId || this.state.master.footer.id === this.selectedId) return;
    remove(page.components);
    this.selectedId = null;
    this.history.push(this.state);
    this.render();
  }

  groupSelectedIntoContainer() {
    const el = this.getSelectedElement();
    if (!el) return;
    const page = this.getCurrentPage();
    const container = this._findClosestContainer(page.components, el.id);
    if (!container) return;
    if (container.id === el.id) return;
    this._moveElementToParent(el.id, container.id);
    this.history.push(this.state);
    this.render();
  }

  _findClosestContainer(nodes, id) {
    let result = null;
    const walk = (arr, parent = null) => {
      for (const n of arr) {
        if (n.id === id) return true;
        if (n.isContainer || ['section','container','columns','grid','form','tabs','accordion','modal','carousel','navbar','footer'].includes(n.type)) result = n;
        if (n.children?.length && walk(n.children, n)) return true;
      }
      return false;
    };
    walk(nodes);
    return result;
  }

  _moveElementToParent(id, parentId) {
    const page = this.getCurrentPage();
    let target = null, targetParent = null;
    const extract = (nodes, parent = null) => {
      const idx = nodes.findIndex(n => n.id === id);
      if (idx >= 0) {
        target = nodes.splice(idx, 1)[0];
        targetParent = parent;
        return true;
      }
      for (const n of nodes) {
        if (n.children?.length && extract(n.children, n)) return true;
      }
      return false;
    };
    extract(page.components);
    if (!target) return;
    const parent = this.findById(parentId);
    if (!parent) { page.components.push(target); return; }
    const abs = this._absolutePos(target);
    const pAbs = this._absolutePos(parent);
    target.parentId = parent.id;
    target.x = Math.max(0, abs.x - pAbs.x);
    target.y = Math.max(0, abs.y - pAbs.y);
    parent.children ||= [];
    parent.children.push(target);
  }

  _absolutePos(el) {
    let x = Number(el.x || 0), y = Number(el.y || 0);
    let p = el.parentId ? this.findById(el.parentId) : null;
    while (p) {
      x += Number(p.x || 0);
      y += Number(p.y || 0);
      p = p.parentId ? this.findById(p.parentId) : null;
    }
    return { x, y };
  }

  saveSelectedAsComponent() {
    const el = this.getSelectedElement();
    if (!el) return;
    this.state.customComponents ||= [];
    this.state.customComponents.push({ id: uid('cmp'), name: el.text || el.type, type: el.type, data: clone(el) });
    this.history.push(this.state);
    this.render();
  }

  editMaster(which) {
    this.selectedId = null;
    const master = this.state.master[which];
    this.openModal(`
      <div class="modal">
        <div class="modal-header"><strong>マスター ${which === 'header' ? 'ヘッダー' : 'フッター'}編集</strong><button class="btn icon" data-close><i class="fa-solid fa-xmark"></i></button></div>
        <div class="modal-body">
          <div class="section"><div class="section-body">
            <div class="field"><label>テキスト</label><input class="input" id="master-text" value="${master.text || ''}"></div>
            <div class="field"><label>高さ</label><input class="input" id="master-h" type="number" value="${master.h || 80}"></div>
            <div class="field"><label>背景色</label><input class="input" id="master-bg" type="color" value="${master.styles?.backgroundColor || '#ffffff'}"></div>
            <div class="field"><label>文字色</label><input class="input" id="master-color" type="color" value="${master.styles?.color || '#172033'}"></div>
            <button class="btn primary" id="master-save">保存</button>
          </div></div>
        </div>
      </div>
    `, (modal) => {
      modal.querySelector('#master-save').addEventListener('click', () => {
        master.text = modal.querySelector('#master-text').value;
        master.h = Number(modal.querySelector('#master-h').value);
        master.styles ||= {};
        master.styles.backgroundColor = modal.querySelector('#master-bg').value;
        master.styles.color = modal.querySelector('#master-color').value;
        this.history.push(this.state);
        this.closeModal();
        this.render();
      });
    });
  }

  syncMasterToAllPages() {
    // master is global already; this is a UI action to reflect immediately.
    this.history.push(this.state);
    this.render();
  }

  updateFromInspector(input) {
    const page = this.getCurrentPage();
    const el = this.getSelectedElement();
    const prop = input.dataset.prop;
    const value = input.type === 'number' ? Number(input.value) : input.value;
    if (prop === 'pageName') { page.name = value; this.history.push(this.state); this.render(); return; }
    if (prop === 'pageWidth') { page.width = Number(value); this.history.push(this.state); this.render(); return; }
    if (prop === 'pageHeight') { page.height = Number(value); this.history.push(this.state); this.render(); return; }
    if (prop === 'pageBg') { this.state.settings.pageBg = value; this.history.push(this.state); this.render(); return; }
    if (!el) return;
    if (prop === 'text') el.text = value;
    else if (prop === 'x') el.x = Number(value);
    else if (prop === 'y') el.y = Number(value);
    else if (prop === 'w') el.w = Number(value);
    else if (prop === 'h') el.h = Number(value);
    else if (prop === 'zIndex') el.zIndex = Number(value);
    else if (prop === 'href') { el.attrs ||= {}; el.attrs.href = value; }
    else if (prop === 'src') el.src = value;
    else if (prop === 'placeholder') { el.attrs ||= {}; el.attrs.placeholder = value; }
    else if (prop === 'iconClass') el.iconClass = value;
    else if (prop.startsWith('style_')) {
      el.styles ||= {};
      const key = prop.replace('style_', '');
      el.styles[key] = input.type === 'number' ? Number(value) : value;
      if (key === 'fontSize' || key === 'borderRadius') el.styles[key] = input.value;
    } else if (prop === 'anim_preset') { el.animation ||= {}; el.animation.preset = value; }
    else if (prop === 'anim_duration') { el.animation ||= {}; el.animation.duration = Number(value); }
    else if (prop === 'anim_delay') { el.animation ||= {}; el.animation.delay = Number(value); }
    this.history.push(this.state);
    this.render();
  }

  updateRuleFromInspector(ruleId, prop, value) {
    const rule = this.state.logicRules.find(r => r.id === ruleId);
    if (!rule) return;
    rule[prop] = value;
    this.history.push(this.state);
    this.render();
  }

  addLogicRule(rule) {
    this.state.logicRules.push(rule);
    this.history.push(this.state);
    this.render();
  }
  removeLogicRule(id) {
    this.state.logicRules = this.state.logicRules.filter(r => r.id !== id);
    this.history.push(this.state);
    this.render();
  }

  importAsset(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      this.state.assets.push({ id: uid('asset'), name: file.name, type: file.type, dataUrl: reader.result });
      this.history.push(this.state);
      this.render();
    };
    reader.readAsDataURL(file);
  }

  toggleHidden(id) {
    const el = this.findById(id);
    if (!el) return;
    el.hidden = !el.hidden;
    this.history.push(this.state);
    this.render();
  }

  openContextMenu(id, x, y) {
    this.contextMenu.innerHTML = `
      <button data-act="select"><i class="fa-regular fa-circle"></i> 選択</button>
      <button data-act="duplicate"><i class="fa-regular fa-copy"></i> 複製</button>
      <button data-act="nest"><i class="fa-solid fa-layer-group"></i> 親に入れる</button>
      <button data-act="delete"><i class="fa-regular fa-trash-can"></i> 削除</button>
    `;
    this.contextMenu.classList.remove('hidden');
    this.contextMenu.style.left = `${x}px`;
    this.contextMenu.style.top = `${y}px`;
    const close = () => this.contextMenu.classList.add('hidden');
    this.contextMenu.querySelectorAll('button').forEach(btn => btn.addEventListener('click', () => {
      this.selectElement(id);
      if (btn.dataset.act === 'duplicate') this.duplicateSelected();
      if (btn.dataset.act === 'delete') this.deleteSelected();
      if (btn.dataset.act === 'nest') this.groupSelectedIntoContainer();
      close();
    }));
    setTimeout(() => {
      const handler = (e) => { if (!this.contextMenu.contains(e.target)) { close(); document.removeEventListener('click', handler); } };
      document.addEventListener('click', handler);
    }, 0);
  }

  beginInlineEdit(id, ev) {
    const el = this.findById(id);
    if (!el) return;
    const target = ev.currentTarget;
    target.contentEditable = 'true';
    target.focus();
    const onBlur = () => {
      target.contentEditable = 'false';
      el.text = target.textContent;
      target.removeEventListener('blur', onBlur);
      this.history.push(this.state);
      this.render();
    };
    target.addEventListener('blur', onBlur, { once: true });
  }

  updateDrag(drag, ev, viewport) {
    const scale = viewport.getBoundingClientRect().width / viewport.clientWidth;
    const dx = (ev.clientX - drag.startX) / scale;
    const dy = (ev.clientY - drag.startY) / scale;
    const el = this.findById(drag.id);
    if (!el) return;
    const snap = this.state.settings.gridSnap || 8;
    el.x = Math.round((drag.originX + dx) / snap) * snap;
    el.y = Math.round((drag.originY + dy) / snap) * snap;
    this.render();
  }

  endDrag(drag, ev, viewport) {
    const el = this.findById(drag.id);
    if (!el) return;
    const target = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('[data-id]');
    if (target && target.dataset.id && target.dataset.id !== el.id) {
      const newParent = this.findById(target.dataset.id);
      if (newParent && (newParent.isContainer || ['section','container','columns','grid','form','tabs','accordion','modal','carousel','navbar','footer'].includes(newParent.type))) {
        this._moveElementToParent(el.id, newParent.id);
      }
    }
    this.history.push(this.state);
    this.render();
  }

  updateResize(resize, ev, viewport) {
    const el = this.findById(resize.id);
    if (!el) return;
    const scale = viewport.getBoundingClientRect().width / viewport.clientWidth;
    const dx = (ev.clientX - resize.startX) / scale;
    const dy = (ev.clientY - resize.startY) / scale;
    const o = resize.origin;
    const snap = this.state.settings.gridSnap || 8;
    let x = o.x, y = o.y, w = o.w, h = o.h;
    if (resize.handle.includes('e')) w = o.w + dx;
    if (resize.handle.includes('s')) h = o.h + dy;
    if (resize.handle.includes('w')) { w = o.w - dx; x = o.x + dx; }
    if (resize.handle.includes('n')) { h = o.h - dy; y = o.y + dy; }
    el.x = Math.round(x / snap) * snap;
    el.y = Math.round(y / snap) * snap;
    el.w = Math.max(20, Math.round(w / snap) * snap);
    el.h = Math.max(20, Math.round(h / snap) * snap);
    this.render();
  }

  endResize() {
    this.history.push(this.state);
    this.render();
  }

  saveProject(toast = false) {
    saveState(this.state);
    if (toast) this.showToast('保存しました');
  }

  exportJson() {
    const blob = exportStateJson(this.state);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${this.state.settings.zipName || 'project'}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async importProject() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const data = await importStateFromJson(file);
      this.state = normalizeProject(data);
      this.history.push(this.state);
      this.render();
    };
    input.click();
  }

  async exportZip() {
    const page = this.getCurrentPage();
    await exportAsZip(this.state, page);
    this.showToast('ZIP を出力しました');
  }

  async exportInline() {
    const page = this.getCurrentPage();
    const blob = exportInlineHtml(this.state, page);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${this.state.settings.zipName || 'site'}.html`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async openPreview() {
    await previewInNewTab(this.state, this.getCurrentPage());
  }

  openTemplatePicker() {
    this._showWelcome();
  }

  openGithubModal() {
    this.openModal(`
      <div class="modal">
        <div class="modal-header">
          <strong>GitHub Pages デプロイ</strong>
          <button class="btn icon" data-close><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="modal-body">
          <div class="section">
            <div class="section-body">
              <div class="note">Personal Access Token を使って、指定リポジトリへ index.html / style.css / script.js を配置します。</div>
              <div class="field"><label>トークン</label><input class="input" id="gh-token" type="password"></div>
              <div class="property-grid">
                <div class="field"><label>Owner</label><input class="input" id="gh-owner"></div>
                <div class="field"><label>Repo</label><input class="input" id="gh-repo"></div>
              </div>
              <div class="property-grid">
                <div class="field"><label>Branch</label><input class="input" id="gh-branch" value="gh-pages"></div>
                <div class="field"><label>Path Prefix</label><input class="input" id="gh-prefix" placeholder="例: docs"></div>
              </div>
              <div class="field inline"><input type="checkbox" id="gh-create"><label for="gh-create">新規リポジトリを作成する</label></div>
              <button class="btn primary" id="gh-deploy"><i class="fa-brands fa-github"></i>デプロイ</button>
              <div class="note" id="gh-result" style="margin-top:10px"></div>
            </div>
          </div>
        </div>
      </div>
    `, (modal) => {
      modal.querySelector('#gh-deploy').addEventListener('click', async () => {
        const token = modal.querySelector('#gh-token').value.trim();
        const owner = modal.querySelector('#gh-owner').value.trim();
        const repo = modal.querySelector('#gh-repo').value.trim();
        const branch = modal.querySelector('#gh-branch').value.trim() || 'gh-pages';
        const pathPrefix = modal.querySelector('#gh-prefix').value.trim();
        const createRepo = modal.querySelector('#gh-create').checked;
        const result = modal.querySelector('#gh-result');
        try{
          result.textContent = 'デプロイ中...';
          const out = await deployToGithub({ token, owner, repo, branch, pathPrefix, createRepo }, this.state, this.getCurrentPage());
          result.textContent = `完了: ${out.owner}/${out.repo} (${out.branch})`;
        }catch(err){
          result.textContent = `失敗: ${err.message || err}`;
        }
      });
    });
  }

  showToast(msg) {
    const toast = document.createElement('div');
    toast.className = 'modal-backdrop';
    toast.style.background = 'transparent';
    toast.innerHTML = `<div class="modal" style="width:auto;max-width:420px"><div class="modal-body">${msg}</div></div>`;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 1800);
  }

  undo() {
    const prev = this.history.undo();
    if (prev) { this.state = prev; this.render(); }
  }
  redo() {
    const next = this.history.redo();
    if (next) { this.state = next; this.render(); }
  }

  _bindKeyboard() {
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); this.undo(); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); this.redo(); }
      if (e.key === 'Delete' && this.selectedId) { e.preventDefault(); this.deleteSelected(); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd' && this.selectedId) { e.preventDefault(); this.duplicateSelected(); }
      if (e.key === 'Escape') { this.closeModal(); this.contextMenu.classList.add('hidden'); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); this.saveProject(true); }
    });
  }
}

window.addEventListener('DOMContentLoaded', () => {
  const app = new App(document.getElementById('app'));
  window.__builderApp = app;
});
