export const ELEMENT_PROPERTIES = [
  'text',
  'rect.x',
  'rect.y',
  'rect.top',
  'rect.right',
  'rect.bottom',
  'rect.left',
  'rect.width',
  'rect.height',
  'scrollWidth',
  'scrollHeight',
  'clientWidth',
  'clientHeight',
  'image.complete',
  'image.naturalWidth',
  'image.naturalHeight',
  'overflowX',
] as const;

export type ElementProperty = (typeof ELEMENT_PROPERTIES)[number];

export function readElementProperty(element: Element, property: ElementProperty): string | number | boolean {
  const rect = element.getBoundingClientRect();
  switch (property) {
    case 'text':
      return element.textContent ?? '';
    case 'rect.x':
    case 'rect.y':
    case 'rect.top':
    case 'rect.right':
    case 'rect.bottom':
    case 'rect.left':
    case 'rect.width':
    case 'rect.height':
      return rect[property.slice(5) as 'x' | 'y' | 'top' | 'right' | 'bottom' | 'left' | 'width' | 'height'];
    case 'scrollWidth':
    case 'scrollHeight':
    case 'clientWidth':
    case 'clientHeight':
      return element[property];
    case 'image.complete':
    case 'image.naturalWidth':
    case 'image.naturalHeight': {
      if (element.tagName !== 'IMG') throw new Error('UNSUPPORTED_PROPERTY: ' + property);
      const img = element as HTMLImageElement;
      if (property === 'image.complete') return img.complete;
      return property === 'image.naturalWidth' ? img.naturalWidth : img.naturalHeight;
    }
    case 'overflowX':
      return element.scrollWidth > element.clientWidth;
  }
}

export function readComputedStyle(element: Element, input: { property: string; pseudo?: 'before' | 'after' }): string {
  const view = element.ownerDocument.defaultView;
  if (!view) throw new Error('NO_DEFAULT_VIEW');
  return view.getComputedStyle(element, input.pseudo ? '::' + input.pseudo : undefined).getPropertyValue(input.property);
}

export interface UiScanCandidate {
  tag: string;
  text?: string;
  id?: string;
  url?: string;
  complete?: boolean;
  naturalWidth?: number;
  naturalHeight?: number;
  rectRight?: number;
  rectLeft?: number;
  rectWidth?: number;
  viewportWidth?: number;
}

export interface UiScanResult {
  candidates: UiScanCandidate[];
  total: number;
  truncated: boolean;
}

export function scanUi(
  root: Element,
  check: 'text-artifacts' | 'i18n' | 'overflow' | 'broken-images' | 'error-exposure',
): UiScanResult {
  const doc = root.ownerDocument;
  const view = doc.defaultView;
  if (!view) throw new Error('NO_DEFAULT_VIEW');
  const candidates: UiScanCandidate[] = [];
  let total = 0;
  const push = (candidate: UiScanCandidate): void => {
    total += 1;
    if (candidates.length < 100) candidates.push(candidate);
  };

  for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
    if (check === 'broken-images') {
      if (el.tagName !== 'IMG') continue;
      const img = el as HTMLImageElement;
      if (img.complete && img.naturalWidth > 0) continue;
      const candidate: UiScanCandidate = {
        tag: 'img',
        complete: img.complete,
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
      };
      const src = img.currentSrc || img.getAttribute('src') || '';
      if (src) candidate.url = src;
      if (img.id) candidate.id = img.id;
      push(candidate);
      continue;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (check === 'overflow') {
      const viewportWidth = doc.documentElement.clientWidth;
      if (rect.right <= viewportWidth + 1) continue;
      const candidate: UiScanCandidate = {
        tag: el.tagName.toLowerCase(),
        rectRight: rect.right,
        rectLeft: rect.left,
        rectWidth: rect.width,
        viewportWidth,
      };
      if (el.id) candidate.id = el.id;
      push(candidate);
      continue;
    }
    if (el.children.length > 0) continue;
    const text = (el.textContent ?? '').trim();
    if (!text) continue;
    if (view.getComputedStyle(el).visibility === 'hidden') continue;
    const hit =
      check === 'text-artifacts'
        ? text === 'undefined' || text === 'null' || text === 'NaN' || text === '[object Object]'
        : check === 'i18n'
          ? /^[a-z][a-zA-Z0-9_-]*(\.[a-zA-Z0-9_-]+)+$/.test(text)
          : /Exception/.test(text) || /stack trace/i.test(text) || /\bat\s+[^\s(]+\s*\(/.test(text) || /"errorCode"\s*:/.test(text);
    if (!hit) continue;
    const candidate: UiScanCandidate = { tag: el.tagName.toLowerCase(), text: text.slice(0, 200) };
    if (el.id) candidate.id = el.id;
    push(candidate);
  }

  return { candidates, total, truncated: total > candidates.length };
}
