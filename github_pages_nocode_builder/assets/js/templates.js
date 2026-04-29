
import { uid } from './utils.js';

const baseText = (text, x, y, w = 360, h = 60, extra = {}) => ({
  id: uid('el'),
  type: 'text',
  x, y, w, h,
  text,
  styles: { fontSize: 18, fontWeight: 500, color: '#172033', lineHeight: 1.6, textAlign: 'left', ...extra.styles },
  attrs: {},
  events: [],
  animation: { preset: 'none', duration: 0.6, delay: 0 },
  children: [],
  parentId: null,
  zIndex: 1,
  locked: false,
  hidden: false,
});

const baseButton = (label, x, y) => ({
  id: uid('el'),
  type: 'button',
  x, y, w: 180, h: 48,
  text: label,
  styles: { backgroundColor: '#3b82f6', color: '#fff', borderRadius: 14, fontSize: 16, fontWeight: 700, borderWidth: 0 },
  attrs: { href: '#', target: '_self' },
  events: [],
  animation: { preset: 'none', duration: 0.6, delay: 0 },
  children: [],
  parentId: null,
  zIndex: 2,
  locked: false,
  hidden: false,
});

const section = (label, y, h = 420) => ({
  id: uid('el'),
  type: 'container',
  x: 80, y, w: 1200, h,
  text: label,
  styles: { backgroundColor: '#ffffff', borderRadius: 20, border: '1px solid #dbe3ee', boxShadow: '0 10px 30px rgba(15,23,42,.06)', padding: 24 },
  attrs: {},
  events: [],
  animation: { preset: 'none', duration: 0.6, delay: 0 },
  children: [],
  parentId: null,
  zIndex: 1,
  locked: false,
  hidden: false,
  isContainer: true,
});

export const templates = {
  blank: () => ({
    title: '空白プロジェクト',
    pages: [{ id: uid('page'), name: 'Top', slug: 'index', width: 1440, height: 2400, components: [], css: '', js: '', head: '', bodyClass: '' }],
    components: [],
  }),
  portfolio: () => {
    const hero = section('Hero', 60, 520);
    hero.children.push(
      { ...baseText('個人の作品と実績を紹介するポートフォリオ', 36, 44, 520, 80, { fontSize: 34, fontWeight: 800 }) , parentId: hero.id, zIndex: 2},
      { ...baseText('Web制作・デザイン・フロントエンド開発など、強みをひと目で伝える構成です。', 36, 126, 560, 70, { fontSize: 18, color: '#475569' }) , parentId: hero.id},
      { ...baseButton('作品を見る', 36, 240), parentId: hero.id },
      { ...baseButton('問い合わせる', 228, 240), parentId: hero.id, styles: { backgroundColor: '#fff', color: '#172033', border: '1px solid #dbe3ee', borderRadius: 14, fontSize: 16, fontWeight: 700 } },
    );
    return {
      title: 'ポートフォリオ',
      pages: [{
        id: uid('page'), name: 'Top', slug: 'index', width: 1440, height: 2600, components: [
          hero,
          { ...section('Works', 650, 860), children: [
            { ...baseText('Works', 36, 34, 300, 40, { fontSize: 28, fontWeight: 800 }) , parentId: null },
          ]},
        ], css: '', js: '', head: '', bodyClass: ''
      }],
      components: [],
    };
  },
  lp: () => {
    const hero = section('LP Hero', 50, 560);
    hero.children.push(
      { ...baseText('商品の魅力を短時間で伝えるランディングページ', 40, 54, 780, 96, { fontSize: 32, fontWeight: 800 }) , parentId: hero.id},
      { ...baseText('CTA、実績、FAQ、フォームなどの定番構成をベースに編集できます。', 40, 154, 700, 80, { fontSize: 18, color: '#475569' }) , parentId: hero.id},
      { ...baseButton('資料請求', 40, 272), parentId: hero.id },
      { ...baseButton('デモを見る', 240, 272), parentId: hero.id, styles: { backgroundColor: '#fff', color: '#172033', border: '1px solid #dbe3ee', borderRadius: 14, fontSize: 16, fontWeight: 700 } },
    );
    return {
      title: 'ランディングページ',
      pages: [{ id: uid('page'), name: 'Top', slug: 'index', width: 1440, height: 3000, components: [hero], css: '', js: '', head: '', bodyClass: '' }],
      components: [],
    };
  },
  corporate: () => ({ title: 'コーポレート', pages: [{ id: uid('page'), name: 'Top', slug: 'index', width: 1440, height: 2600, components: [section('Header', 40, 180), section('About', 260, 460), section('Service', 760, 520)], css: '', js: '', head: '', bodyClass: '' }], components: [] }),
  blog: () => ({ title: 'ブログ風', pages: [{ id: uid('page'), name: 'Top', slug: 'index', width: 1440, height: 2600, components: [section('Blog', 48, 520)], css: '', js: '', head: '', bodyClass: '' }], components: [] }),
  ec: () => ({ title: 'EC風', pages: [{ id: uid('page'), name: 'Top', slug: 'index', width: 1440, height: 2800, components: [section('Products', 50, 860)], css: '', js: '', head: '', bodyClass: '' }], components: [] }),
};

export const defaultTemplateKeys = Object.keys(templates);
