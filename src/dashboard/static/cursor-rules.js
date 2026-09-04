// cursor-rules.js - pure, DOM-free, dynamic-imported by the ring at boot.
const UNUSABLE = /::|&/;   // a pseudo-element is a box closest() can never return
const STATE_PSEUDO = /:(?:hover|active|focus|focus-visible|focus-within|visited|link|target)\b/g;

// clickable with no cursor declaration anywhere: the browser draws the pointer itself
export const SEMANTIC_POINTER = [
  'a[href]', 'area[href]', 'button', 'summary', 'select', 'label[for]',
  'input[type="checkbox"]', 'input[type="radio"]', 'input[type="range"]',
  'input[type="color"]', 'input[type="file"]', 'input[type="submit"]',
  'input[type="reset"]', 'input[type="button"]',
  '[role="button"]', '[role="link"]', '[role="tab"]',
  '[role="menuitem"]', '[role="option"]', '[role="switch"]',
].join(', ');
export const SEMANTIC_BLOCKED = ':disabled, [aria-disabled="true"]';

// split on the commas separating selectors, not the ones inside :is() or an attribute value
export function splitSelectorList(text) {
  const parts = [];
  let depth = 0, quote = '', start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === quote && text[i - 1] !== '\\') quote = ''; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) { parts.push(text.slice(start, i)); start = i + 1; }
  }
  parts.push(text.slice(start));
  return parts.map(s => s.trim()).filter(Boolean);
}

/* Every selector any rule gives one of `values` for `prop`, de-duplicated. It NARROWS a
   walk, never decides one: the computed style still has the last word, so a selector
   whose rule lives under a media query the viewport does not match costs one match and
   nothing else. A state pseudo is stripped so `.x:hover { position: sticky }` still names
   `.x`. The alternative, reading `getComputedStyle` for every element in the document,
   forces rendering inside any `content-visibility` subtree it crosses, which Chrome
   reports and this system's collapsed rows all carry. */
export function collectPropSelectors(sheets, prop, values) {
  const found = new Set();
  const visit = rules => {
    for (const rule of rules || []) {
      if (rule.selectorText && rule.style && values.includes(rule.style[prop])) {
        for (const part of splitSelectorList(rule.selectorText)) {
          if (UNUSABLE.test(part)) continue;
          const clean = part.replace(STATE_PSEUDO, '').trim();
          if (clean) found.add(clean);
        }
      }
      if (rule.cssRules) visit(rule.cssRules);                 // @media, @supports, nesting
    }
  };
  for (const sheet of sheets || []) {
    try { visit(sheet.cssRules); } catch { /* cross-origin sheet */ }
  }
  return [...found];
}

// `inert` is the `cursor: default` set: it lets a rule that switches a clickable class back off
// (a current breadcrumb, a readonly field) outrank the pointer entry it was written to override.
export function collectCursorSelectors(sheets) {
  const buckets = { pointer: new Set(), inert: new Set(), blocked: new Set() };
  const bucketFor = c => c === 'pointer' ? buckets.pointer
    : c === 'default' ? buckets.inert
    : c === 'not-allowed' ? buckets.blocked : null;
  const visit = rules => {
    for (const rule of rules || []) {
      const bucket = rule.selectorText && rule.style ? bucketFor(rule.style.cursor) : null;
      if (bucket) for (const part of splitSelectorList(rule.selectorText)) {
        if (UNUSABLE.test(part)) continue;
        const clean = part.replace(STATE_PSEUDO, '').trim();   // folds `.x{default} .x:hover{pointer}`
        if (!clean) continue;
        for (const b of Object.values(buckets)) b.delete(clean); // document order stands in for the cascade
        bucket.add(clean);
      }
      if (rule.cssRules) visit(rule.cssRules);                 // @media, @supports, CSS nesting
    }
  };
  for (const sheet of sheets || []) {
    try { visit(sheet.cssRules); } catch { /* cross-origin sheet, nothing worth a broken boot */ }
  }
  return { pointer: [...buckets.pointer], inert: [...buckets.inert], blocked: [...buckets.blocked] };
}
