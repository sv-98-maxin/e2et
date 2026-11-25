import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendTraceEvent, cleanupExpiredTraces, redactHeaders, storeTraceBody, TRACE_TTL_MS } from '../daemon/trace.js';
import { traceDir, traceRoot } from '../daemon/session-meta.js';

describe('trace 安全存储', () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.E2ET_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-store-'));
    process.env.E2ET_HOME = home;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.E2ET_HOME;
    else process.env.E2ET_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('URL/header/JSON/form/text 全脱敏，blob 去重且权限收紧，未知二进制不落盘', () => {
    const id = 'secret-session';
    const secrets = [
      'url-secret', 'upper-secret', 'header-secret', 'array-secret', 'object-secret',
      'json-secret', 'nested-secret', 'form-secret', 'text-secret', 'bearer-secret', 'text-url-secret',
    ];
    appendTraceEvent(id, {
      t: 'request',
      id: 'r1',
      url: 'https://example.test/api?%74oken=url-secret&ToKeN=upper-secret&safe=1',
      req_headers: redactHeaders({
        Cookie: 'SID=header-secret',
        Location: 'https://example.test/next?%74oken=header-secret',
        Referer: ['https://example.test/a?TOKEN=array-secret'],
        Meta: { referrer: 'https://example.test/b?token=object-secret' },
      }),
    });

    const jsonBody = JSON.stringify({ password: 'json-secret', nested: { ToKeN: 'nested-secret', ok: 1 } });
    const json = storeTraceBody(id, jsonBody, 'application/json');
    const duplicate = storeTraceBody(id, jsonBody, 'application/json');
    const form = storeTraceBody(id, 'name=ok&csrf=form-secret', 'application/x-www-form-urlencoded');
    const text = storeTraceBody(id, 'EXAMPLE_SESSION=text-secret with spaces; authorization: Bearer bearer-secret; see https://example.test/?%74oken=text-url-secret', 'text/plain');
    const binary = storeTraceBody(id, Buffer.from([0, 1, 2, 3]).toString('base64'), 'application/octet-stream', true);

    expect(json.ref).toBe(duplicate.ref);
    expect(form.ref).toBeTruthy();
    expect(text.ref).toBeTruthy();
    expect(binary).toEqual({ omitted: 'unsupported_content_type' });

    const dir = traceDir(id);
    const blobs = path.join(dir, 'blobs');
    const files = fs.readdirSync(blobs);
    expect(files).toHaveLength(3);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(blobs).mode & 0o777).toBe(0o700);
    for (const file of files) expect(fs.statSync(path.join(blobs, file)).mode & 0o777).toBe(0o600);

    const all = [fs.readFileSync(path.join(dir, 'trace.jsonl'), 'utf8')]
      .concat(files.map((file) => fs.readFileSync(path.join(blobs, file), 'utf8')))
      .join('\n');
    for (const secret of secrets) expect(all).not.toContain(secret);
    expect(all).toContain('[REDACTED]');
  });

  it('session/trace/blobs/blob 任一级预置 symlink 都拒绝，外部目标不变', () => {
    const root = traceRoot();
    fs.mkdirSync(root, { recursive: true });

    const externalSession = path.join(home, 'external-session');
    fs.mkdirSync(externalSession);
    fs.writeFileSync(path.join(externalSession, 'sentinel'), 'session-safe');
    fs.symlinkSync(externalSession, path.join(root, 'session-link'), 'dir');
    expect(() => appendTraceEvent('session-link', { t: 'test' })).toThrow();
    expect(fs.readFileSync(path.join(externalSession, 'sentinel'), 'utf8')).toBe('session-safe');

    const traceId = 'trace-link';
    const traceSession = path.join(root, traceId);
    fs.mkdirSync(traceSession);
    const externalTrace = path.join(home, 'external-trace');
    fs.writeFileSync(externalTrace, 'trace-safe');
    fs.symlinkSync(externalTrace, path.join(traceSession, 'trace.jsonl'));
    expect(() => appendTraceEvent(traceId, { t: 'test' })).toThrow();
    expect(fs.readFileSync(externalTrace, 'utf8')).toBe('trace-safe');

    const blobsId = 'blobs-link';
    const blobsSession = path.join(root, blobsId);
    const externalBlobs = path.join(home, 'external-blobs');
    fs.mkdirSync(blobsSession);
    fs.mkdirSync(externalBlobs);
    fs.writeFileSync(path.join(externalBlobs, 'sentinel'), 'blobs-safe');
    fs.symlinkSync(externalBlobs, path.join(blobsSession, 'blobs'), 'dir');
    expect(() => storeTraceBody(blobsId, 'safe', 'text/plain')).toThrow();
    expect(fs.readdirSync(externalBlobs)).toEqual(['sentinel']);

    const blobId = 'blob-link';
    const blobDir = path.join(root, blobId, 'blobs');
    fs.mkdirSync(blobDir, { recursive: true });
    const externalBlob = path.join(home, 'external-blob');
    fs.writeFileSync(externalBlob, 'blob-safe');
    const sha = crypto.createHash('sha256').update('safe').digest('hex');
    fs.symlinkSync(externalBlob, path.join(blobDir, sha));
    expect(() => storeTraceBody(blobId, 'safe', 'text/plain')).toThrow();
    expect(fs.readFileSync(externalBlob, 'utf8')).toBe('blob-safe');
  });

  it('TTL 只删过期真实直接子目录，跳过当前/recent/文件/symlink', () => {
    const now = Date.now();
    const root = traceRoot();
    fs.mkdirSync(root, { recursive: true });
    const old = path.join(root, 'old');
    const current = path.join(root, 'current');
    const recent = path.join(root, 'recent');
    const outside = path.join(home, 'outside');
    const link = path.join(root, 'old-link');
    const plain = path.join(root, 'old-file');
    for (const dir of [old, current, recent, outside]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(plain, 'keep');
    fs.symlinkSync(outside, link, 'dir');
    const expired = new Date(now - TRACE_TTL_MS - 1000);
    fs.utimesSync(old, expired, expired);
    fs.utimesSync(current, expired, expired);
    fs.utimesSync(outside, expired, expired);
    fs.utimesSync(plain, expired, expired);

    expect(cleanupExpiredTraces('current', process.env, now)).toEqual(['old']);
    expect(fs.existsSync(old)).toBe(false);
    for (const kept of [current, recent, outside, link, plain]) expect(fs.existsSync(kept)).toBe(true);
  });
});
