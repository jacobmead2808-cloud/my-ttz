// Tiny DOM helpers. Text is always set via textContent, never innerHTML, so user content is XSS-safe.

// Conditional UI (`cond ? el : null`) must never render the text "null"/"false": skip empty values.
for (const method of ['replaceChildren', 'append', 'prepend']) {
  const original = Element.prototype[method];
  Element.prototype[method] = function patched(...nodes) {
    return original.apply(this, nodes.filter((n) => n !== null && n !== undefined && n !== false));
  };
}

/**
 * h('div.card#id', { onclick, class, style, attrs... }, ...children)
 * Children may be strings, numbers, Nodes, arrays, null/false (skipped).
 */
export function h(tag, props, ...children) {
  if (props && (props instanceof Node || typeof props !== 'object' || Array.isArray(props))) {
    children.unshift(props);
    props = null;
  }
  const [name, ...rest] = tag.split(/(?=[.#])/);
  const el = document.createElement(name || 'div');
  for (const part of rest) {
    if (part[0] === '.') el.classList.add(part.slice(1));
    else if (part[0] === '#') el.id = part.slice(1);
  }
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class' || k === 'className') String(v).split(/\s+/).filter(Boolean).forEach((c) => el.classList.add(c));
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'ref' && typeof v === 'function') v(el);
      else if (k === 'value') el.value = v;
      else if (k in el && !['list', 'form', 'type', 'width', 'height'].includes(k) && typeof v !== 'string') el[k] = v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false || c === true) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function replace(el, ...children) {
  clear(el);
  return append(el, children);
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Render text with clickable #hashtags and @mentions (links handled by router). */
export function richText(text) {
  const frag = document.createDocumentFragment();
  const re = /(#[\p{L}\p{N}_]{1,50})|(@[a-zA-Z0-9_][a-zA-Z0-9_.]{1,23})|(https?:\/\/[^\s]+)/gu;
  let last = 0;
  const str = String(text || '');
  for (const m of str.matchAll(re)) {
    if (m.index > last) frag.appendChild(document.createTextNode(str.slice(last, m.index)));
    if (m[1]) frag.appendChild(h('a.tag-link', { href: `/tag/${encodeURIComponent(m[1].slice(1).toLowerCase())}` }, m[1]));
    else if (m[2]) {
      const name = m[2].slice(1).replace(/\.+$/, '');
      frag.appendChild(h('a.mention-link', { href: `/@${encodeURIComponent(name.toLowerCase())}` }, '@' + name));
      if (m[2].length - 1 > name.length) frag.appendChild(document.createTextNode(m[2].slice(name.length + 1)));
    } else if (m[3]) {
      let safe = null;
      try { const u = new URL(m[3]); if (u.protocol === 'http:' || u.protocol === 'https:') safe = u.href; } catch { /* ignore */ }
      frag.appendChild(safe ? h('a.ext-link', { href: safe, target: '_blank', rel: 'noopener noreferrer nofollow' }, m[3]) : document.createTextNode(m[3]));
    }
    last = m.index + m[0].length;
  }
  if (last < str.length) frag.appendChild(document.createTextNode(str.slice(last)));
  return frag;
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
