import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { IRv2 } from '../../ir/schema.js';
import { irDigest, renderIR } from '../../render/render.js';
import { loadStaticCase, parseTestHeader } from '../snapshot.js';

const dirs: string[] = [];

afterEach(() => dirs.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));

function writeCase(value: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'case-snapshot-'));
  dirs.push(dir);
  const file = path.join(dir, 'case.ir.json');
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
  return file;
}

function reorderedIr(): Record<string, unknown> {
  return {
    steps: [{
      trace_ref: 'a1',
      intent: '打开页面',
      action: 'open',
      id: 's1',
      value: { literal: 'http://127.0.0.1/' },
      wait: [{ url: { contains: '127.0.0.1' } }],
    }],
    provenance: {
      mocked: false,
      generated_at: '2026-10-27T00:00:00Z',
      tool_version: '0.6.0',
      browser_source: 'managed',
      auth_source: 'imported',
      session_id: 's_snapshot',
    },
    env: 'pre',
    covered_pages: [],
    url: 'http://127.0.0.1/',
    name: 'snapshot-case',
    schema_version: 3,
  };
}

describe('loadStaticCase IR identity', () => {
  it('结构等价时保留原 IR 键序，文件摘要、render header 与 runtime 输入一致', () => {
    const file = writeCase(reorderedIr());
    const raw = fs.readFileSync(file);
    const snapshot = loadStaticCase(file);
    expect(snapshot && 'ir' in snapshot).toBe(true);
    if (!snapshot || !('ir' in snapshot)) return;

    const expected = createHash('sha256').update(raw).digest('hex');
    expect(Object.keys(snapshot.ir)).toEqual(Object.keys(JSON.parse(raw.toString())));
    expect(Object.keys(snapshot.ir.steps[0]!)).toEqual(Object.keys(JSON.parse(raw.toString()).steps[0]));
    expect(irDigest(snapshot.ir)).toBe(expected);
    expect(parseTestHeader(Buffer.from(renderIR(snapshot.ir)))?.irDigest).toBe(expected);
  });

  it('default/strip 改变结构时仍使用 schema 输出', () => {
    const input = reorderedIr();
    delete input.covered_pages;
    input.unknown_top = true;
    (input.provenance as Record<string, unknown>).unknown_nested = true;
    ((input.steps as Array<Record<string, unknown>>)[0]!).unknown_step = true;
    const snapshot = loadStaticCase(writeCase(input));
    expect(snapshot && 'ir' in snapshot).toBe(true);
    if (!snapshot || !('ir' in snapshot)) return;

    const ir = snapshot.ir as IRv2 & Record<string, unknown>;
    expect(ir.covered_pages).toEqual([]);
    expect(ir).not.toHaveProperty('unknown_top');
    expect(ir.provenance).not.toHaveProperty('unknown_nested');
    expect(ir.steps[0]).not.toHaveProperty('unknown_step');
  });

  it('schema transform 与 strict 校验仍在 snapshot 前生效', () => {
    const missingValue = reorderedIr();
    (missingValue.steps as Array<Record<string, unknown>>)[0]!.checks = [{
      assert: { api: { path: '/x', nav: 1, call_index: 1 }, expect: [{ path: 'ok', op: 'eq' }] },
    }];
    expect(loadStaticCase(writeCase(missingValue))).toMatchObject({ load_error: { code: 'SCHEMA' } });

    const unknownLocator = reorderedIr();
    Object.assign((unknownLocator.steps as Array<Record<string, unknown>>)[0]!, { locator: { unknown: true } });
    expect(loadStaticCase(writeCase(unknownLocator))).toMatchObject({ load_error: { code: 'SCHEMA' } });
  });
});
