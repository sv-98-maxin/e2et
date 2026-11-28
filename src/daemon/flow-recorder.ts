import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensurePrivateDir } from './trace.js';
import { e2etRoot } from './session-meta.js';
import type { CdpSession } from '../browser/daemon-client.js';
import { holdViewport, releaseViewport } from '../browser/viewport.js';
import { resolveViewport } from '../shared/viewport.js';

const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const FLOW_FRAME_MAX_BYTES = 2 * 1024 * 1024;
const FLOW_MAX_FRAMES = 1800;

/** 全页截图会临时缩放渲染表面，screencast 随之发出缩水帧；只有 JPEG 头里的真实尺寸可信。 */
function jpegSize(bytes: Buffer): { width: number; height: number } | undefined {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset++; continue; }
    const marker = bytes[offset + 1]!;
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    offset += 2 + bytes.readUInt16BE(offset + 2);
  }
  return undefined;
}

interface FlowFrame {
  file: string;
  t: number;
}

export interface FlowManifest {
  startedAt: number;
  endedAt: number;
  frames: FlowFrame[];
}

/** 采集会话全流程 JPEG 帧；只供报告回放，不参与动作判定。 */
export class FlowRecorder {
  private running = false;
  private stopped = false;
  private generation = 0;
  private starting: Promise<void> | null = null;
  private startedAt = 0;
  private frames: FlowFrame[] = [];
  private cdp: CdpSession | null = null;
  private heldCdp: CdpSession | null = null;
  private offFrame: (() => void) | null = null;
  private frameNumber = 0;
  private dir = '';

  constructor(
    private readonly sessionId: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly activeCdp: () => CdpSession | null,
    private readonly isStopped: () => boolean,
  ) {}

  async start(): Promise<void> {
    if (this.stopped || this.isStopped()) return;
    const cdp = this.activeCdp();
    if (!cdp) return;
    if (this.cdp === cdp) return this.starting ?? undefined;
    if (!this.running) {
      this.dir = path.join(e2etRoot(this.env), 'workspace', 'flow', this.sessionId);
      ensurePrivateDir(this.dir, true);
      this.running = true;
      this.startedAt = Date.now();
    }
    const previous = this.cdp;
    const generation = ++this.generation;
    this.cleanup();
    this.cdp = cdp;
    const starting = this.bind(cdp, generation, previous);
    this.starting = starting;
    return starting;
  }

  onActivePageChanged(): void {
    if (this.running) void this.start();
  }

  private current(cdp: CdpSession, generation: number): boolean {
    return this.running && !this.isStopped() && this.cdp === cdp && this.generation === generation && this.activeCdp() === cdp;
  }

  private async bind(cdp: CdpSession, generation: number, previous: CdpSession | null): Promise<void> {
    if (previous) {
      try { await previous.send('Page.stopScreencast'); } catch { /* 旧页面可能已关闭 */ }
      if (!this.current(cdp, generation)) return;
    }
    this.offFrame = cdp.on('Page.screencastFrame', params => this.onFrame(cdp, generation, params));
    for (const [method, params] of [
      ['Emulation.setFocusEmulationEnabled', { enabled: true }],
      ['Emulation.setIdleOverride', { isUserActive: true, isScreenUnlocked: true }],
      ['Page.setWebLifecycleState', { state: 'active' }],
    ] as const) {
      try { await cdp.send(method, params); } catch { /* 老版本 Chrome 不支持单个覆盖项时继续录制 */ }
      if (!this.current(cdp, generation)) return;
    }
    try {
      await cdp.send('Page.enable');
      if (!this.current(cdp, generation)) return;
      // screencast 只录视口，窗口比页面窄时右侧内容会整块丢失。
      try {
        await holdViewport(cdp);
        if (!this.current(cdp, generation)) { void releaseViewport(cdp); return; }
        this.heldCdp = cdp;
      } catch { /* 视口配置错误由截图路径报错，录制退化为窗口视口 */ }
      if (!this.current(cdp, generation)) return;
      const viewport = resolveViewport(this.env);
      await cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 70,
        maxWidth: viewport.width,
        maxHeight: viewport.height,
        everyNthFrame: 1,
      });
      if (!this.current(cdp, generation)) return;
    } catch {
      if (this.current(cdp, generation)) this.cleanup();
    }
  }

  private onFrame(cdp: CdpSession, generation: number, params: { data?: unknown; sessionId?: unknown; metadata?: { timestamp?: unknown } }): void {
    if (!this.current(cdp, generation)) return;
    const frameSession = typeof params.sessionId === 'number' ? params.sessionId : undefined;
    const data = typeof params.data === 'string' ? params.data : '';
    if (data && this.frames.length < FLOW_MAX_FRAMES) {
      try {
        const bytes = Buffer.from(data, 'base64');
        const viewport = resolveViewport(this.env);
        const size = jpegSize(bytes);
        if (bytes.length <= FLOW_FRAME_MAX_BYTES && size && size.width === viewport.width && size.height === viewport.height) {
          const file = `frame_${String(++this.frameNumber).padStart(6, '0')}.jpg`;
          const target = path.join(this.dir, file);
          const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW, 0o600);
          try { fs.writeFileSync(fd, bytes); } finally { fs.closeSync(fd); }
          const timestamp = typeof params.metadata?.timestamp === 'number' ? params.metadata.timestamp * 1000 : Date.now();
          this.frames.push({ file, t: Math.round(timestamp) });
        }
      } catch { /* 单帧失败不能中断业务动作 */ }
    }
    if (frameSession !== undefined) {
      void cdp.send('Page.screencastFrameAck', { sessionId: frameSession }).catch(() => {});
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.generation++;
    if (!this.running) return;
    this.running = false;
    const cdp = this.cdp;
    this.cleanup();
    if (cdp) {
      try { await cdp.send('Page.stopScreencast'); } catch { /* 页面可能已关闭 */ }
    }
    if (!this.frames.length) return;
    const manifest: FlowManifest = {
      startedAt: this.startedAt,
      endedAt: Date.now(),
      frames: this.frames,
    };
    try {
      const target = path.join(this.dir, 'manifest.json');
      const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | NO_FOLLOW, 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(manifest)); } finally { fs.closeSync(fd); }
    } catch { /* 报告会退化为只有关键截图 */ }
  }

  private cleanup(): void {
    this.offFrame?.();
    this.offFrame = null;
    if (this.heldCdp) {
      void releaseViewport(this.heldCdp);
      this.heldCdp = null;
    }
    this.cdp = null;
    this.starting = null;
  }
}
