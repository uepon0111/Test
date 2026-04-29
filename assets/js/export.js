
import { escapeHtml, slugify, downloadBlob, clone } from './utils.js';

const nl = '\n';

function styleObjectToCss(obj = {}) {
  const map = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === '' || v == null) continue;
    const key = k.replace(/[A-Z]/g, m => '-' + m.toLowerCase());
    map.push(`  ${key}: ${String(v)};`);
  }
  return map.join('\n');
}

function componentToHtml(el, project, page, depth = 0) {
  if (!el || el.hidden) return '';
  const id = el.id;
  const attrs = [
    `data-id="${id}"`,
    `data-type="${el.type}"`,
    `style="${buildInlineStyle(el, depth)}"`,
  ];
  if (el.attrs?.href) attrs.push(`href="${escapeHtml(el.attrs.href)}"`);
  if (el.attrs?.target) attrs.push(`target="${escapeHtml(el.attrs.target)}"`);
  if (el.attrs?.placeholder) attrs.push(`placeholder="${escapeHtml(el.attrs.placeholder)}"`);
  if (el.attrs?.alt) attrs.push(`alt="${escapeHtml(el.attrs.alt)}"`);
  if (el.attrs?.src) attrs.push(`src="${escapeHtml(el.attrs.src)}"`);
  if (el.animation?.preset && el.animation.preset !== 'none') attrs.push(`data-aos="${escapeHtml(el.animation.preset)}"`);
  const children = (el.children || []).map(ch => componentToHtml(ch, project, page, depth + 1)).join(nl);
  switch (el.type) {
    case 'heading1': return `<h1 ${attrs.join(' ')}>${escapeHtml(el.text || '')}</h1>`;
    case 'heading2': return `<h2 ${attrs.join(' ')}>${escapeHtml(el.text || '')}</h2>`;
    case 'text': return `<p ${attrs.join(' ')}>${escapeHtml(el.text || '')}</p>`;
    case 'button': return `<a ${attrs.join(' ')} class="site-button">${escapeHtml(el.text || 'Button')}</a>`;
    case 'link': return `<a ${attrs.join(' ')}>${escapeHtml(el.text || 'Link')}</a>`;
    case 'image': return `<img ${attrs.join(' ')} />`;
    case 'divider': return `<hr ${attrs.join(' ')} />`;
    case 'input': return `<input ${attrs.join(' ')} type="text" />`;
    case 'textarea': return `<textarea ${attrs.join(' ')}>${escapeHtml(el.text || '')}</textarea>`;
    case 'select': return `<select ${attrs.join(' ')}>${(el.options || []).map(o => `<option>${escapeHtml(o)}</option>`).join('')}</select>`;
    case 'checkbox': return `<label ${attrs.join(' ')}><input type="checkbox" /> ${escapeHtml(el.text || '')}</label>`;
    case 'radio': return `<label ${attrs.join(' ')}><input type="radio" name="${escapeHtml(el.id)}" /> ${escapeHtml(el.text || '')}</label>`;
    case 'video': return `<iframe ${attrs.join(' ')} src="${escapeHtml(el.src || '')}" allowfullscreen></iframe>`;
    case 'map': return `<iframe ${attrs.join(' ')} src="${escapeHtml(el.src || '')}"></iframe>`;
    case 'iframe': return `<iframe ${attrs.join(' ')} src="${escapeHtml(el.src || '')}"></iframe>`;
    case 'icon': return `<i ${attrs.join(' ')} class="${escapeHtml(el.iconClass || 'fa-solid fa-star')}"></i>`;
    case 'code': return `<div ${attrs.join(' ')}>${el.text ? el.text : ''}</div>`;
    case 'spacer': return `<div ${attrs.join(' ')}></div>`;
    case 'shape': return `<div ${attrs.join(' ')}></div>`;
    default:
      return `<section ${attrs.join(' ')}>${escapeHtml(el.text || '')}${children ? nl + children : ''}</section>`;
  }
}

function buildInlineStyle(el, depth) {
  const s = { ...(el.styles || {}) };
  const map = [];
  map.push('position:absolute');
  map.push(`left:${Math.round(el.x || 0)}px`);
  map.push(`top:${Math.round(el.y || 0)}px`);
  map.push(`width:${Math.max(1, Math.round(el.w || 100))}px`);
  map.push(`height:${Math.max(1, Math.round(el.h || 40))}px`);
  map.push(`z-index:${el.zIndex || 1}`);
  if (el.type === 'divider') {
    map.push('height:2px');
  }
  for (const [k, v] of Object.entries(s)) {
    if (v === '' || v == null) continue;
    const key = k.replace(/[A-Z]/g, m => '-' + m.toLowerCase());
    map.push(`${key}:${String(v)}`);
  }
  if (el.type === 'heading1' || el.type === 'heading2' || el.type === 'text') {
    map.push('white-space:pre-wrap');
  }
  if (el.type === 'image' || el.type === 'video' || el.type === 'map' || el.type === 'iframe') {
    map.push('border:0');
  }
  return map.join(';');
}

function collectAllComponents(page) {
  const out = [];
  const walk = (nodes, parentId = null) => {
    for (const n of nodes || []) {
      out.push(n);
      if (n.children?.length) walk(n.children, n.id);
    }
  };
  walk(page.components || []);
  return out;
}

function walkNodes(nodes, fn) {
  for (const n of nodes || []) {
    fn(n);
    if (n.children?.length) walkNodes(n.children, fn);
  }
}

function generateCss(page, project) {
  const lines = [];
  lines.push(`:root{ --accent:${project.settings.accent || '#3b82f6'}; }`);
  lines.push(`html,body{margin:0;padding:0;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#172033;background:#fff;}`);
  lines.push(`*{box-sizing:border-box}`);
  lines.push(`#site-root{position:relative;min-height:${Math.max(page.height || 2000, 1000)}px;width:100%;overflow:hidden;background:${project.settings.pageBg || '#fff'};}`);
  lines.push(`.site-page{position:relative;width:min(${page.width || 1440}px,100%);margin:0 auto;min-height:${page.height || 2000}px;}`);
  lines.push(`.site-button{text-decoration:none;display:inline-flex;align-items:center;justify-content:center;cursor:pointer}`);
  lines.push(`.site-grid{display:grid;}`);
  lines.push(`.site-hidden{display:none !important}`);
  lines.push(`.site-master-header,.site-master-footer{width:100%;position:relative}`);
  lines.push(`.site-master-header{z-index:50}`);
  lines.push(`.site-master-footer{z-index:50}`);
  for (const el of collectAllComponents(page)) {
    lines.push(`[data-id="${el.id}"]{${styleObjectToCss(el.styles)}}`);
    if (el.type === 'button' || el.type === 'link') {
      lines.push(`[data-id="${el.id}"]{display:inline-flex;align-items:center;justify-content:center;text-decoration:none}`);
    }
    if (el.animation?.preset && el.animation.preset !== 'none') {
      lines.push(`[data-id="${el.id}"]{opacity:0}`);
    }
  }
  lines.push(project.pages.map(p => `#page-${p.id}{display:${p.id === project.currentPageId ? 'block' : 'none'};}`).join('\n'));
  lines.push(page.css || '');
  return lines.filter(Boolean).join('\n');
}

function buildExportJs(project, page) {
  const rules = JSON.stringify(project.logicRules || [], null, 2);
  const custom = page.js || '';
  return `(() => {${nl}
  const rules = ${rules};${nl}
  function byId(id){ return document.querySelector('[data-id="'+id+'"]'); }${nl}
  function show(el){ if(el) el.classList.remove('site-hidden'); if(el) el.style.display=''; }${nl}
  function hide(el){ if(el) el.classList.add('site-hidden'); if(el) el.style.display='none'; }${nl}
  function toggleClass(el, cls){ if(el) el.classList.toggle(cls); }${nl}
  function runCustom(code, ctx){ try{ new Function('ctx','el','page','project', code)(ctx, ctx.el, ctx.page, ctx.project); }catch(e){ console.error(e); } }${nl}
  function applyAnimation(el, preset, duration, delay){ if(!el || !window.gsap || preset === 'none') return; gsap.fromTo(el,{opacity:0, y: preset.includes('up') ? 28 : preset.includes('down') ? -28 : 0, x: preset.includes('left') ? 28 : preset.includes('right') ? -28 : 0},{opacity:1, x:0, y:0, duration: duration || 0.7, delay: delay || 0, ease:'power2.out'}); }${nl}
  window.addEventListener('DOMContentLoaded', () => {${nl}
    document.querySelectorAll('[data-aos]').forEach(el => { if(window.AOS) AOS.init({ once: true, duration: 700 }); });${nl}
    document.querySelectorAll('[data-id]').forEach(el => { const preset = el.getAttribute('data-aos'); if(preset) { el.style.opacity = '0'; setTimeout(() => applyAnimation(el, preset, 0.7, 0), 20); } });${nl}
    rules.forEach(rule => {${nl}
      const el = byId(rule.targetId);${nl}
      if(!el) return;${nl}
      const handler = (ev) => {${nl}
        const ctx = { el, event: ev, page: document, project: window.__PROJECT__ || {} };${nl}
        if(rule.action === 'show') show(el);${nl}
        else if(rule.action === 'hide') hide(el);${nl}
        else if(rule.action === 'toggle-class') toggleClass(el, rule.value || 'is-active');${nl}
        else if(rule.action === 'navigate') location.href = rule.value || '#';${nl}
        else if(rule.action === 'toggle-modal') toggleClass(el, 'is-open');${nl}
        else if(rule.action === 'scroll-animate' && window.gsap) gsap.to(el, { opacity:1, y:0, duration:0.7 });${nl}
        else if(rule.action === 'run-js') runCustom(rule.customCode || '', ctx);${nl}
      };${nl}
      const map = { click:'click', dblclick:'dblclick', hover:['mouseenter','mouseleave'], scroll:'scroll', load:'load', submit:'submit', input:'input' };${nl}
      if(rule.trigger === 'hover'){ el.addEventListener('mouseenter', handler); }${nl}
      else if(rule.trigger === 'scroll'){ window.addEventListener('scroll', handler, { passive:true }); }${nl}
      else if(rule.trigger === 'load'){ handler(new Event('load')); }${nl}
      else { el.addEventListener(map[rule.trigger] || 'click', handler); }${nl}
    });${nl}
    ${custom}${nl}
  });${nl}
})();`;
}

function buildHtml(project, page, inline = false) {
  const components = (page.components || []).map(el => componentToHtml(el, project, page)).join(nl);
  const pageHtml = `<!doctype html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(project.settings.title || page.name || 'Site')}</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css">
<link rel="stylesheet" href="https://unpkg.com/aos@2.3.4/dist/aos.css">
${inline ? `<style>\n${generateCss(page, project)}\n</style>` : `<link rel="stylesheet" href="./style.css">`}
</head>
<body>
<div id="site-root">
  <div class="site-page" id="page-${page.id}">
${components}
  </div>
</div>
<script>window.__PROJECT__ = ${JSON.stringify(project).replace(/</g,'\\u003c')};</script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/gsap.min.js"></script>
<script src="https://unpkg.com/aos@2.3.4/dist/aos.js"></script>
${inline ? `<script>\n${buildExportJs(project, page)}\n</script>` : `<script src="./script.js"></script>`}
</body>
</html>`;
  return pageHtml;
}

export function exportHtmlText(project, page, inline = false) {
  return buildHtml(project, page, inline);
}

export async function exportAsZip(project, page) {
  const zip = new JSZip();
  zip.file('index.html', buildHtml(project, page, false));
  zip.file('style.css', generateCss(page, project));
  zip.file('script.js', buildExportJs(project, page));
  zip.file('project.json', JSON.stringify(project, null, 2));
  const blob = await zip.generateAsync({ type: 'blob' });
  downloadBlob(`${slugify(project.settings.title || 'site')}.zip`, blob);
}

export function exportInlineHtml(project, page) {
  return new Blob([buildHtml(project, page, true)], { type: 'text/html' });
}

export function exportCssText(project, page) {
  return generateCss(page, project);
}

export function exportJsText(project, page) {
  return buildExportJs(project, page);
}

export async function previewInNewTab(project, page) {
  const blob = exportInlineHtml(project, page);
  const url = URL.createObjectURL(blob);
  const win = window.open(url, '_blank', 'noopener,noreferrer');
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return win;
}

export async function deployToGithub(options, project, page) {
  const { token, owner, repo, branch = 'gh-pages', pathPrefix = '' } = options;
  const files = [
    ['index.html', buildHtml(project, page, false)],
    ['style.css', generateCss(page, project)],
    ['script.js', buildExportJs(project, page)],
  ];
  const auth = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' };
  const fetchJson = async (url, init = {}) => {
    const res = await fetch(url, { ...init, headers: { ...(init.headers || {}), ...auth } });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  };
  let fullOwner = owner;
  let fullRepo = repo;
  if (options.createRepo) {
    const created = await fetchJson('https://api.github.com/user/repos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: repo, auto_init: true, private: false })
    });
    fullOwner = created.owner.login;
    fullRepo = created.name;
  }
  const base = `https://api.github.com/repos/${fullOwner}/${fullRepo}/contents`;
  for (const [name, content] of files) {
    const path = `${pathPrefix ? pathPrefix.replace(/\/+$/, '') + '/' : ''}${name}`;
    let sha = null;
    try {
      const existing = await fetchJson(`${base}/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`);
      sha = existing.sha;
    } catch {}
    await fetchJson(`${base}/${encodeURIComponent(path)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `Deploy ${name}`,
        content: btoa(unescape(encodeURIComponent(content))),
        branch,
        sha
      })
    });
  }
  return { owner: fullOwner, repo: fullRepo, branch };
}
