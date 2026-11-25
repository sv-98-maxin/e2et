import { describe, expect, it } from 'vitest';
import * as crypto from 'node:crypto';
import { decryptChromeCookieValue } from '../browser/chrome-auth.js';

const KEY = crypto.pbkdf2Sync('test-password', 'saltysalt', 1003, 16, 'sha1');
const IV = Buffer.alloc(16, 0x20);

function encryptV10(prefixHost: string | null, value: string): Buffer {
  const body = prefixHost === null
    ? Buffer.from(value, 'utf-8')
    : Buffer.concat([crypto.createHash('sha256').update(prefixHost).digest(), Buffer.from(value, 'utf-8')]);
  const cipher = crypto.createCipheriv('aes-128-cbc', KEY, IV);
  return Buffer.concat([Buffer.from('v10'), cipher.update(body), cipher.final()]);
}

describe('decryptChromeCookieValue', () => {
  it('剥离 SHA256(host_key) 前缀', () => {
    expect(decryptChromeCookieValue('.example.invalid', encryptV10('.example.invalid', 'tfstk-value'), KEY)).toBe('tfstk-value');
  });

  it('无前缀的旧格式原样返回', () => {
    expect(decryptChromeCookieValue('.example.invalid', encryptV10(null, 'plain'), KEY)).toBe('plain');
  });

  it('v11 与错误密钥均返回 undefined', () => {
    const v11 = Buffer.concat([Buffer.from('v11'), encryptV10(null, 'cipher').subarray(3)]);
    expect(decryptChromeCookieValue('.example.invalid', v11, KEY)).toBeUndefined();
    expect(decryptChromeCookieValue('.example.invalid', encryptV10(null, 'cipher'), Buffer.alloc(16, 1))).toBeUndefined();
  });
});
