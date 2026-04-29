
import { uid } from './utils.js';

export const defaultLogicRule = () => ({
  id: uid('rule'),
  trigger: 'click',
  targetId: '',
  action: 'toggle-class',
  value: 'is-active',
  selector: '',
  customCode: '',
});

export const triggerOptions = [
  { value: 'click', label: 'クリック' },
  { value: 'dblclick', label: 'ダブルクリック' },
  { value: 'hover', label: 'ホバー' },
  { value: 'scroll', label: 'スクロール' },
  { value: 'load', label: 'ページ読み込み' },
  { value: 'submit', label: 'フォーム送信' },
  { value: 'input', label: '入力' },
];

export const actionOptions = [
  { value: 'show', label: '表示' },
  { value: 'hide', label: '非表示' },
  { value: 'toggle-class', label: 'クラス切替' },
  { value: 'navigate', label: 'ページ遷移' },
  { value: 'toggle-modal', label: 'モーダル開閉' },
  { value: 'scroll-animate', label: 'アニメーション' },
  { value: 'run-js', label: 'カスタムJS' },
];
