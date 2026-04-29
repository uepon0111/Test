
import { exportCssText, exportJsText } from './export.js';

function ensureCodeMirror(el, mode) {
  return CodeMirror(el, {
    value: '',
    mode,
    theme: 'eclipse',
    lineNumbers: true,
    lineWrapping: true,
    tabSize: 2,
    indentUnit: 2,
    viewportMargin: Infinity,
  });
}

export class CodeEditor {
  constructor(root, onApply) {
    this.root = root;
    this.onApply = onApply;
    this.cm = { html: null, css: null, js: null };
    this.active = 'html';
    this._render();
  }

  _render() {
    this.root.innerHTML = `
      <div class="code-tabs">
        <button class="tab active" data-tab="html"><i class="fa-solid fa-file-code"></i>HTML</button>
        <button class="tab" data-tab="css"><i class="fa-solid fa-brush"></i>CSS</button>
        <button class="tab" data-tab="js"><i class="fa-solid fa-bolt"></i>JS</button>
        <button class="tab" data-tab="raw"><i class="fa-solid fa-database"></i>構成データ</button>
      </div>
      <div class="code-pane">
        <div id="cm-html" class="tabpanel active"></div>
        <div id="cm-css" class="tabpanel"></div>
        <div id="cm-js" class="tabpanel"></div>
        <div id="cm-raw" class="tabpanel"></div>
      </div>
      <div class="footer-bar">
        <button class="btn small ghost" data-act="reload"><i class="fa-solid fa-rotate"></i>再生成</button>
        <button class="btn small" data-act="apply"><i class="fa-solid fa-check"></i>反映</button>
      </div>
    `;
    this.cm.html = ensureCodeMirror(this.root.querySelector('#cm-html'), 'htmlmixed');
    this.cm.css = ensureCodeMirror(this.root.querySelector('#cm-css'), 'css');
    this.cm.js = ensureCodeMirror(this.root.querySelector('#cm-js'), 'javascript');
    this.cm.raw = ensureCodeMirror(this.root.querySelector('#cm-raw'), 'javascript');
    this._bindTabs();
    this.root.querySelector('[data-act="reload"]').addEventListener('click', () => this.onApply('reload'));
    this.root.querySelector('[data-act="apply"]').addEventListener('click', () => this.onApply('apply'));
  }

  _bindTabs(){
    this.root.querySelectorAll('.tab').forEach(btn => {
      btn.addEventListener('click', () => {
        this.active = btn.dataset.tab;
        this.root.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b === btn));
        this.root.querySelectorAll('.tabpanel').forEach(p => p.classList.toggle('active', p.id === `cm-${this.active}`));
        setTimeout(() => {
          const cm = this.cm[this.active];
          if (cm?.refresh) cm.refresh();
        }, 20);
      });
    });
  }

  setValues({ html, css, js, raw }) {
    if (this.cm.html) this.cm.html.setValue(html || '');
    if (this.cm.css) this.cm.css.setValue(css || '');
    if (this.cm.js) this.cm.js.setValue(js || '');
    if (this.cm.raw) this.cm.raw.setValue(raw || '');
  }

  getValues() {
    return {
      html: this.cm.html?.getValue() || '',
      css: this.cm.css?.getValue() || '',
      js: this.cm.js?.getValue() || '',
      raw: this.cm.raw?.getValue() || '',
    };
  }
}
