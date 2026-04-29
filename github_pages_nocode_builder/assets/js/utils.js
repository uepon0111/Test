
export const uid = (prefix = 'id') => `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
export const clone = (obj) => JSON.parse(JSON.stringify(obj));
export const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
export const px = (n) => `${Math.round(Number(n) || 0)}px`;
export const toNum = (v, fallback = 0) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
};
export const escapeHtml = (s = '') => String(s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');
export const slugify = (s='') => String(s).toLowerCase().replace(/[^\wぁ-んァ-ヶ一-龠]+/g, '-').replace(/^-+|-+$/g, '');
export const downloadBlob = (name, blob) => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
