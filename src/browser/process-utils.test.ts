/**
 * isProcessAlive 回归：Linux zombie(STAT=Z) 不算存活；/proc 竞态；Darwin 不访问 /proc。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

// vi.hoisted 确保 mock 函数在 vi.mock factory 执行前已初始化
const { platformMock, readFileSyncMock } = vi.hoisted(() => ({
  platformMock: vi.fn(() => process.platform),
  readFileSyncMock: vi.fn(),
}));

vi.mock('node:os', () => ({
  default: { platform: platformMock },
  platform: platformMock,
}));
vi.mock('node:fs', () => ({
  default: {
    readFileSync: readFileSyncMock,
    existsSync: vi.fn(() => true),
  },
  readFileSync: readFileSyncMock,
  existsSync: vi.fn(() => true),
}));

import { isProcessAlive } from './process-utils.js';

let killSpy: ReturnType<typeof vi.spyOn> | null = null;

afterEach(() => {
  if (killSpy) { killSpy.mockRestore(); killSpy = null; }
  platformMock.mockReset();
  platformMock.mockReturnValue(process.platform);
  readFileSyncMock.mockReset();
});

describe('isProcessAlive', () => {
  it('pid=0 → false', () => {
    expect(isProcessAlive(0)).toBe(false);
  });

  it('PID 不存在（kill 抛 ESRCH）→ false', () => {
    killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('No such process');
      (err as any).code = 'ESRCH';
      throw err;
    });
    expect(isProcessAlive(999999)).toBe(false);
  });

  it('当前进程 → true（活态）', () => {
    platformMock.mockReturnValue('darwin');
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('Linux: /proc stat 状态 S → true', () => {
    platformMock.mockReturnValue('linux');
    readFileSyncMock.mockReturnValue(`${process.pid} (node) S 1 1 1 0 -1 ...`);
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(readFileSyncMock).toHaveBeenCalledWith(`/proc/${process.pid}/stat`, 'utf-8');
  });

  it('Linux: /proc stat 状态 Z → false（zombie 不算存活）', () => {
    platformMock.mockReturnValue('linux');
    readFileSyncMock.mockReturnValue('5555 (chrome) Z 1 5555 5555 ...');
    expect(isProcessAlive(process.pid)).toBe(false);
  });

  it('Linux: comm 含括号 → lastIndexOf 跳过 comm 内括号，正确取状态码', () => {
    platformMock.mockReturnValue('linux');
    readFileSyncMock.mockReturnValue('5555 (chrome (helper)) R 1 5555 5555 ...');
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('Linux: kill(0) 成功但 /proc 读取抛 ENOENT → false（进程退出竞态）', () => {
    platformMock.mockReturnValue('linux');
    const err = new Error('not found');
    (err as any).code = 'ENOENT';
    readFileSyncMock.mockImplementation(() => { throw err; });
    expect(isProcessAlive(process.pid)).toBe(false);
  });

  it('Linux: /proc 读取抛非 ENOENT 错误 → 保守 true', () => {
    platformMock.mockReturnValue('linux');
    const err = new Error('denied');
    (err as any).code = 'EACCES';
    readFileSyncMock.mockImplementation(() => { throw err; });
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('Darwin: 不读 /proc，纯 signal 0', () => {
    platformMock.mockReturnValue('darwin');
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(readFileSyncMock).not.toHaveBeenCalled();
  });
});
