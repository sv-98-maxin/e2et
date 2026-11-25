import type { Locator, TargetCandidate, WithinLocator } from './types.js';

export function parseDeclaredWaitLocator(raw: string): Locator | undefined {
  const match = /^(role|label|text|testid|css)=(.*)$/s.exec(raw);
  if (!match) return undefined;
  const payload = match[2];
  if (!payload.trim()) throw new Error('等待定位声明不能为空');
  switch (match[1]) {
    case 'role': {
      const separator = payload.indexOf(':');
      const role = separator < 0 ? payload : payload.slice(0, separator);
      const name = separator < 0 ? undefined : payload.slice(separator + 1);
      if (!/^[a-z]+$/.test(role) || name === '') throw new Error('等待 role 声明无效');
      return { role, ...(name !== undefined ? { name } : {}) };
    }
    case 'label': return { label: payload };
    case 'text': return { text: payload, normalize: true };
    case 'testid': return { testid: payload };
    case 'css': return { css: payload };
  }
}

export function candidateToLocator(candidate: TargetCandidate & { within?: Locator }): Locator | undefined {
  if (candidate.matches !== 1) return undefined;
  switch (candidate.by) {
    case 'role': {
      const scope = candidate.within;
      const within: WithinLocator | undefined = scope && ('role' in scope || 'row' in scope || 'label' in scope) ? scope : undefined;
      return { role: candidate.role ?? '', ...(candidate.name !== undefined ? { name: candidate.name } : {}), ...(within ? { within } : {}) };
    }
    case 'label': return candidate.name || candidate.value ? { label: (candidate.name ?? candidate.value)! } : undefined;
    case 'text': return candidate.value ? { text: candidate.value, normalize: true } : undefined;
    case 'css': return candidate.selector ? { css: candidate.selector } : undefined;
  }
}
