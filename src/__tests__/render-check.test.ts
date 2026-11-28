import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { renderIR } from '../render/render.js';
import type { IRv2 } from '../ir/schema.js';

const root = path.resolve(import.meta.dirname, '../..');
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));
describe('实际 render-check 脚本正负 guard', () => {
  it.each(['valid', 'reordered', 'empty', 'missing-test', 'schema', 'different'])('%s', kind => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-check-')); dirs.push(dir);
    fs.mkdirSync(path.join(dir, 'test/e2e/cases'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'test/e2e/__tests__'));
    const ir: IRv2 = {
      schema_version: 3, name: 'controlled', url: 'http://127.0.0.1/', covered_pages: [], env: 'pre',
      provenance: { session_id: 's_controlled', auth_source: 'imported', browser_source: 'managed', tool_version: '0.6.0', generated_at: '2026-10-27T00:00:00Z', mocked: false },
      steps: [{ id: 's1', intent: '打开', action: 'open', value: { literal: 'http://127.0.0.1/' }, wait: [{ url: { contains: '127.0.0.1' } }], trace_ref: 'a1' }],
    };
    const reordered = {
      steps: [{ trace_ref: 'a1', wait: [{ url: { contains: '127.0.0.1' } }], value: { literal: 'http://127.0.0.1/' }, action: 'open', intent: '打开', id: 's1' }],
      provenance: ir.provenance, env: ir.env, covered_pages: ir.covered_pages, url: ir.url, name: ir.name, schema_version: ir.schema_version,
    };
    if (kind !== 'empty') fs.writeFileSync(path.join(dir, 'test/e2e/cases/controlled.ir.json'), JSON.stringify(kind === 'schema' ? { schema_version: 99 } : kind === 'reordered' ? reordered : ir));
    if (kind !== 'missing-test') fs.writeFileSync(path.join(dir, 'test/e2e/__tests__/controlled.test.ts'), kind === 'different' ? 'wrong bytes' : renderIR(kind === 'reordered' ? reordered as unknown as IRv2 : ir));
    const result = spawnSync('bash', [path.join(root, 'scripts/render-check.sh'), dir], { encoding: 'utf8' });
    expect(result.status).toBe(['valid', 'reordered', 'empty'].includes(kind) ? 0 : 1);
    if (kind === 'empty') expect(result.stdout).toMatch(/未验证\/无正式case/);
    if (['valid', 'reordered'].includes(kind)) expect(result.stdout).toMatch(/render-check 通过/);
  });
});
