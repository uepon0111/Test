
import { uid } from './utils.js';

export const COMPONENT_DEFS = [
  { type: 'heading1', label: '見出し H1', icon: 'fa-heading', category: 'basic', kind: 'text' },
  { type: 'heading2', label: '見出し H2', icon: 'fa-heading', category: 'basic', kind: 'text' },
  { type: 'text', label: 'テキスト', icon: 'fa-align-left', category: 'basic', kind: 'text' },
  { type: 'button', label: 'ボタン', icon: 'fa-square-caret-right', category: 'basic', kind: 'interactive' },
  { type: 'link', label: 'リンク', icon: 'fa-link', category: 'basic', kind: 'interactive' },
  { type: 'image', label: '画像', icon: 'fa-image', category: 'media', kind: 'media' },
  { type: 'divider', label: '区切り線', icon: 'fa-grip-lines', category: 'basic', kind: 'layout' },
  { type: 'section', label: 'セクション', icon: 'fa-layer-group', category: 'layout', kind: 'layout' },
  { type: 'container', label: 'コンテナ', icon: 'fa-box', category: 'layout', kind: 'layout' },
  { type: 'columns', label: 'カラム', icon: 'fa-columns', category: 'layout', kind: 'layout' },
  { type: 'grid', label: 'グリッド', icon: 'fa-table-cells-large', category: 'layout', kind: 'layout' },
  { type: 'navbar', label: 'ナビバー', icon: 'fa-bars', category: 'navigation', kind: 'layout' },
  { type: 'footer', label: 'フッター', icon: 'fa-shoe-prints', category: 'navigation', kind: 'layout' },
  { type: 'breadcrumbs', label: 'パンくず', icon: 'fa-ellipsis', category: 'navigation', kind: 'layout' },
  { type: 'form', label: 'フォーム', icon: 'fa-square-check', category: 'form', kind: 'form' },
  { type: 'input', label: '入力', icon: 'fa-i-cursor', category: 'form', kind: 'form' },
  { type: 'textarea', label: 'テキストエリア', icon: 'fa-pen-to-square', category: 'form', kind: 'form' },
  { type: 'select', label: 'セレクト', icon: 'fa-caret-down', category: 'form', kind: 'form' },
  { type: 'checkbox', label: 'チェック', icon: 'fa-square-check', category: 'form', kind: 'form' },
  { type: 'radio', label: 'ラジオ', icon: 'fa-circle-dot', category: 'form', kind: 'form' },
  { type: 'video', label: '動画', icon: 'fa-circle-play', category: 'media', kind: 'media' },
  { type: 'map', label: '地図', icon: 'fa-map-location-dot', category: 'media', kind: 'media' },
  { type: 'iframe', label: 'iframe', icon: 'fa-window-maximize', category: 'media', kind: 'media' },
  { type: 'icon', label: 'アイコン', icon: 'fa-icons', category: 'basic', kind: 'media' },
  { type: 'tabs', label: 'タブ', icon: 'fa-folder-tree', category: 'advanced', kind: 'layout' },
  { type: 'accordion', label: 'アコーディオン', icon: 'fa-chevron-down', category: 'advanced', kind: 'layout' },
  { type: 'modal', label: 'モーダル', icon: 'fa-window-restore', category: 'advanced', kind: 'interactive' },
  { type: 'carousel', label: 'カルーセル', icon: 'fa-images', category: 'advanced', kind: 'interactive' },
  { type: 'spacer', label: '余白', icon: 'fa-arrows-up-down', category: 'basic', kind: 'layout' },
  { type: 'shape', label: '図形', icon: 'fa-circle', category: 'basic', kind: 'layout' },
  { type: 'code', label: 'コード', icon: 'fa-code', category: 'advanced', kind: 'interactive' },
  { type: 'section-link', label: 'ページ遷移', icon: 'fa-arrow-right', category: 'advanced', kind: 'interactive' },
];

export const componentTypeToLabel = (type) => COMPONENT_DEFS.find(d => d.type === type)?.label ?? type;

export const createComponent = (type, x = 80, y = 80) => {
  const id = uid('el');
  const common = {
    id, type, x, y, w: 240, h: 80,
    text: componentTypeToLabel(type),
    html: '',
    styles: {},
    attrs: {},
    events: [],
    animation: { preset: 'none', duration: 0.6, delay: 0 },
    children: [],
    parentId: null,
    zIndex: 1,
    locked: false,
    hidden: false,
  };
  switch(type){
    case 'heading1':
      return { ...common, w: 520, h: 86, text: '見出しテキスト', styles: { fontSize: 36, fontWeight: 800, color: '#172033', lineHeight: 1.25 } };
    case 'heading2':
      return { ...common, w: 420, h: 62, text: '見出しテキスト', styles: { fontSize: 28, fontWeight: 700, color: '#172033', lineHeight: 1.3 } };
    case 'text':
      return { ...common, w: 520, h: 72, text: 'ここに本文を入力します。複数行の説明文、補足情報、キャプションなどに使えます。', styles: { fontSize: 16, fontWeight: 400, color: '#334155', lineHeight: 1.8 } };
    case 'button':
      return { ...common, w: 180, h: 48, text: 'ボタン', styles: { backgroundColor: '#3b82f6', color: '#fff', borderRadius: 14, fontSize: 16, fontWeight: 700, border: 'none', textAlign: 'center' }, attrs: { href: '#' } };
    case 'link':
      return { ...common, w: 160, h: 32, text: 'リンクテキスト', styles: { color: '#2563eb', fontSize: 16, textDecoration: 'underline' }, attrs: { href: '#' } };
    case 'image':
      return { ...common, w: 360, h: 240, src: 'https://images.unsplash.com/photo-1516321318423-f06f85e504b3?auto=format&fit=crop&w=900&q=80', alt: 'image', styles: { objectFit: 'cover', borderRadius: 16 } };
    case 'divider':
      return { ...common, w: 360, h: 2, styles: { backgroundColor: '#dbe3ee' } };
    case 'section':
      return { ...common, w: 1200, h: 420, text: 'セクション', styles: { backgroundColor: '#fff', border: '1px solid #dbe3ee', borderRadius: 20, boxShadow: '0 10px 30px rgba(15,23,42,.06)', padding: 24 }, isContainer: true };
    case 'container':
      return { ...common, w: 900, h: 280, text: 'コンテナ', styles: { backgroundColor: '#fff', border: '1px solid #dbe3ee', borderRadius: 18, padding: 20 }, isContainer: true };
    case 'columns':
      return { ...common, w: 1000, h: 300, styles: { backgroundColor: '#fff', border: '1px solid #dbe3ee', borderRadius: 18, padding: 20 }, columns: 2, isContainer: true };
    case 'grid':
      return { ...common, w: 1000, h: 320, styles: { backgroundColor: '#fff', border: '1px solid #dbe3ee', borderRadius: 18, padding: 20 }, columns: 3, gap: 16, isContainer: true };
    case 'navbar':
      return { ...common, w: 1200, h: 72, styles: { backgroundColor: '#fff', borderBottom: '1px solid #dbe3ee', padding: '0 20px' }, isContainer: true };
    case 'footer':
      return { ...common, w: 1200, h: 120, styles: { backgroundColor: '#0f172a', color: '#fff', borderRadius: 18, padding: 24 }, text: 'フッター', isContainer: true };
    case 'breadcrumbs':
      return { ...common, w: 360, h: 28, text: 'Home / Section / Page', styles: { fontSize: 13, color: '#64748b' } };
    case 'form':
      return { ...common, w: 760, h: 260, styles: { backgroundColor: '#fff', border: '1px solid #dbe3ee', borderRadius: 18, padding: 20 }, isContainer: true };
    case 'input':
      return { ...common, w: 280, h: 44, text: '', placeholder: '入力', styles: { border: '1px solid #cbd5e1', borderRadius: 12, padding: '12px 14px', backgroundColor: '#fff' }, attrs: { placeholder: '入力' } };
    case 'textarea':
      return { ...common, w: 360, h: 120, text: '', placeholder: '複数行入力', styles: { border: '1px solid #cbd5e1', borderRadius: 12, padding: '12px 14px', backgroundColor: '#fff' }, attrs: { placeholder: '複数行入力' } };
    case 'select':
      return { ...common, w: 220, h: 44, text: '', styles: { border: '1px solid #cbd5e1', borderRadius: 12, backgroundColor: '#fff' }, options: ['選択肢1', '選択肢2', '選択肢3'] };
    case 'checkbox':
      return { ...common, w: 180, h: 28, text: 'チェック項目', styles: { fontSize: 15, color: '#334155' } };
    case 'radio':
      return { ...common, w: 180, h: 28, text: 'ラジオ項目', styles: { fontSize: 15, color: '#334155' } };
    case 'video':
      return { ...common, w: 560, h: 315, src: 'https://www.youtube.com/embed/dQw4w9WgXcQ', styles: { borderRadius: 18 } };
    case 'map':
      return { ...common, w: 560, h: 315, src: 'https://www.google.com/maps?q=Tokyo&output=embed', styles: { borderRadius: 18 } };
    case 'iframe':
      return { ...common, w: 560, h: 315, src: 'https://example.com', styles: { borderRadius: 18 } };
    case 'icon':
      return { ...common, w: 48, h: 48, iconClass: 'fa-solid fa-star', styles: { color: '#3b82f6', fontSize: 28 } };
    case 'tabs':
      return { ...common, w: 920, h: 320, styles: { backgroundColor: '#fff', border: '1px solid #dbe3ee', borderRadius: 18, padding: 16 }, tabItems: ['タブ1', 'タブ2', 'タブ3'], isContainer: true };
    case 'accordion':
      return { ...common, w: 760, h: 260, styles: { backgroundColor: '#fff', border: '1px solid #dbe3ee', borderRadius: 18, padding: 16 }, items: ['質問1', '質問2', '質問3'], isContainer: true };
    case 'modal':
      return { ...common, w: 320, h: 160, styles: { backgroundColor: '#fff', border: '1px solid #dbe3ee', borderRadius: 18, padding: 20 }, isContainer: true };
    case 'carousel':
      return { ...common, w: 920, h: 300, styles: { backgroundColor: '#fff', border: '1px solid #dbe3ee', borderRadius: 18, padding: 16 }, slides: ['Slide 1', 'Slide 2', 'Slide 3'], isContainer: true };
    case 'spacer':
      return { ...common, w: 200, h: 40, styles: { backgroundColor: 'transparent' } };
    case 'shape':
      return { ...common, w: 120, h: 120, styles: { backgroundColor: '#bfdbfe', borderRadius: '999px' } };
    case 'code':
      return { ...common, w: 640, h: 220, text: '<div>カスタムHTML</div>', styles: { backgroundColor: '#0f172a', color: '#e2e8f0', borderRadius: 16, padding: 16, fontFamily: 'var(--mono)', fontSize: 13 }, codeLanguage: 'html' };
    case 'section-link':
      return { ...common, w: 240, h: 48, text: '別ページへ移動', styles: { backgroundColor: '#fff', color: '#172033', border: '1px solid #dbe3ee', borderRadius: 14, fontSize: 15, fontWeight: 700 }, attrs: { href: '#page:Top' } };
    default:
      return common;
  }
};

export const defaultMasterComponents = () => ([
  { id: uid('el'), type: 'navbar', x: 0, y: 0, w: 1440, h: 72, text: 'サイト名', styles: { backgroundColor: '#fff', borderBottom: '1px solid #dbe3ee', padding: '0 24px', fontWeight: 700 }, children: [], parentId: null, zIndex: 10, locked: false, hidden: false, isContainer: true },
  { id: uid('el'), type: 'footer', x: 0, y: 0, w: 1440, h: 120, text: 'フッター', styles: { backgroundColor: '#0f172a', color: '#fff', padding: 24, borderRadius: 0 }, children: [], parentId: null, zIndex: 10, locked: false, hidden: false, isContainer: true }
]);

export const componentDefMap = Object.fromEntries(COMPONENT_DEFS.map(d => [d.type, d]));
