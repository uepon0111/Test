
import { COMPONENT_DEFS, componentTypeToLabel } from './components.js';
import { clone, uid } from './utils.js';
import { defaultLogicRule, triggerOptions, actionOptions } from './logic.js';

function inputField(label, value, name, type = 'text') {
  return `
    <div class="field">
      <label>${label}</label>
      <input class="input" data-prop="${name}" type="${type}" value="${value ?? ''}">
    </div>`;
}

export function renderInspector(root, state, api) {
  const el = api.getSelectedElement();
  const page = api.getCurrentPage();
  const project = state;
  const commonStyle = el ? (el.styles || {}) : {};
  const logicRules = project.logicRules || [];
  root.innerHTML = `
    <div class="panel-header">
      <div class="panel-title"><i class="fa-solid fa-sliders"></i> プロパティ</div>
      <div class="note">${el ? `${componentTypeToLabel(el.type)} / ${el.id.slice(-6)}` : '未選択'}</div>
    </div>
    <div class="panel-body">
      <div class="section">
        <div class="section-head">
          <span>ページ設定</span>
        </div>
        <div class="section-body">
          ${inputField('ページ名', page?.name || '', 'pageName')}
          ${inputField('ページ幅', page?.width || 1440, 'pageWidth', 'number')}
          ${inputField('ページ高さ', page?.height || 2400, 'pageHeight', 'number')}
          ${inputField('ページ背景', project.settings.pageBg || '#ffffff', 'pageBg', 'color')}
        </div>
      </div>

      <div class="section">
        <div class="section-head">
          <span>要素</span>
          <div class="chip">${el ? el.type : '未選択'}</div>
        </div>
        <div class="section-body">
          ${el ? `
            ${inputField('表示テキスト', el.text || '', 'text')}
            ${inputField('X', el.x ?? 0, 'x', 'number')}
            ${inputField('Y', el.y ?? 0, 'y', 'number')}
            ${inputField('幅', el.w ?? 100, 'w', 'number')}
            ${inputField('高さ', el.h ?? 40, 'h', 'number')}
            ${inputField('z-index', el.zIndex ?? 1, 'zIndex', 'number')}
            ${inputField('リンク先', el.attrs?.href || '', 'href')}
            ${inputField('画像/動画URL', el.src || '', 'src')}
            ${inputField('プレースホルダー', el.attrs?.placeholder || '', 'placeholder')}
            ${inputField('アイコンクラス', el.iconClass || '', 'iconClass')}
            <div class="field">
              <label>要素操作</label>
              <div style="display:flex; gap:8px; flex-wrap:wrap">
                <button class="btn small" data-act="duplicate"><i class="fa-regular fa-copy"></i>複製</button>
                <button class="btn small" data-act="group"><i class="fa-solid fa-layer-group"></i>親に入れる</button>
                <button class="btn small danger" data-act="delete"><i class="fa-regular fa-trash-can"></i>削除</button>
              </div>
            </div>
            <div class="field">
              <label>スタイル</label>
              <div class="property-grid">
                ${inputField('文字色', commonStyle.color || '#172033', 'style_color', 'color')}
                ${inputField('背景色', commonStyle.backgroundColor || '#ffffff', 'style_backgroundColor', 'color')}
                ${inputField('フォントサイズ', commonStyle.fontSize || 16, 'style_fontSize', 'number')}
                ${inputField('角丸', commonStyle.borderRadius || 0, 'style_borderRadius', 'text')}
                ${inputField('padding', commonStyle.padding || 0, 'style_padding', 'text')}
                ${inputField('margin', commonStyle.margin || 0, 'style_margin', 'text')}
                ${inputField('影', commonStyle.boxShadow || '', 'style_boxShadow')}
                ${inputField('ボーダー', commonStyle.border || '', 'style_border')}
              </div>
            </div>
            <div class="field">
              <label>アニメーション</label>
              <div class="property-grid">
                <div class="field">
                  <select class="select" data-prop="anim_preset">
                    ${['none','fade-up','fade-down','fade-left','fade-right','zoom-in','slide-up','slide-down'].map(p => `<option value="${p}" ${el.animation?.preset===p?'selected':''}>${p}</option>`).join('')}
                  </select>
                </div>
                ${inputField('duration', el.animation?.duration ?? 0.6, 'anim_duration', 'number')}
                ${inputField('delay', el.animation?.delay ?? 0, 'anim_delay', 'number')}
              </div>
            </div>
          ` : '<div class="note">キャンバス上の要素を選択すると詳細を編集できます。</div>'}
        </div>
      </div>

      <div class="section">
        <div class="section-head"><span>ビジュアルロジック</span><button class="btn small" data-act="add-rule"><i class="fa-solid fa-plus"></i>追加</button></div>
        <div class="section-body">
          <div class="note">トリガーとアクションを組み合わせて、ページ遷移や要素の表示切替、カスタムJSの実行を設定します。</div>
          <div class="list" style="margin-top:10px">
            ${logicRules.map(rule => `
              <div class="section" style="margin:0">
                <div class="section-body">
                  <div class="property-grid">
                    <div class="field">
                      <label>トリガー</label>
                      <select class="select" data-rule="${rule.id}" data-prop="trigger">
                        ${triggerOptions.map(o => `<option value="${o.value}" ${o.value===rule.trigger?'selected':''}>${o.label}</option>`).join('')}
                      </select>
                    </div>
                    <div class="field">
                      <label>アクション</label>
                      <select class="select" data-rule="${rule.id}" data-prop="action">
                        ${actionOptions.map(o => `<option value="${o.value}" ${o.value===rule.action?'selected':''}>${o.label}</option>`).join('')}
                      </select>
                    </div>
                  </div>
                  <div class="property-grid">
                    ${inputField('対象要素ID', rule.targetId || '', `rule_target_${rule.id}`)}
                    ${inputField('値 / クラス名 / URL', rule.value || '', `rule_value_${rule.id}`)}
                  </div>
                  <div class="field">
                    <label>カスタムJS</label>
                    <textarea class="textarea" data-rule="${rule.id}" data-prop="customCode">${rule.customCode || ''}</textarea>
                  </div>
                  <div style="display:flex;justify-content:flex-end">
                    <button class="btn small danger" data-act="remove-rule" data-rule-id="${rule.id}"><i class="fa-regular fa-trash-can"></i>削除</button>
                  </div>
                </div>
              </div>
            `).join('') || '<div class="note">まだルールはありません。</div>'}
          </div>
        </div>
      </div>

      <div class="section">
        <div class="section-head"><span>ページ共通コンポーネント</span></div>
        <div class="section-body">
          <button class="btn small" data-act="sync-master"><i class="fa-solid fa-arrows-rotate"></i>全ページへ即時反映</button>
          <div class="note" style="margin-top:8px">ヘッダーとフッターはマスターとして同期されます。</div>
        </div>
      </div>
    </div>
  `;

  root.querySelectorAll('input[data-prop], textarea[data-prop], select[data-prop]').forEach(input => {
    input.addEventListener('input', () => api.updateFromInspector(input));
    input.addEventListener('change', () => api.updateFromInspector(input));
  });

  root.querySelectorAll('input[data-rule], textarea[data-rule], select[data-rule]').forEach(input => {
    input.addEventListener('input', () => api.updateRuleFromInspector(input.dataset.rule, input.dataset.prop, input.value));
    input.addEventListener('change', () => api.updateRuleFromInspector(input.dataset.rule, input.dataset.prop, input.value));
  });

  root.querySelector('[data-act="add-rule"]')?.addEventListener('click', () => api.addLogicRule(defaultLogicRule()));
  root.querySelectorAll('[data-act="remove-rule"]').forEach(btn => btn.addEventListener('click', () => api.removeLogicRule(btn.dataset.ruleId)));
  root.querySelector('[data-act="delete"]')?.addEventListener('click', () => api.deleteSelected());
  root.querySelector('[data-act="duplicate"]')?.addEventListener('click', () => api.duplicateSelected());
  root.querySelector('[data-act="group"]')?.addEventListener('click', () => api.groupSelectedIntoContainer());
  root.querySelector('[data-act="sync-master"]')?.addEventListener('click', () => api.syncMasterToAllPages());
}
