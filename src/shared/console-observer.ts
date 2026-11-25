import {
  normalizeConsoleLevel, safeConsoleText,
  type ConsoleEntry, type ConsoleLevel, type ConsoleSnapshot, type ConsoleSource,
} from './console.js';
import { redactText } from './url-safety.js';

export interface ConsoleObserverChannel {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  on(method: string, handler: (params: unknown) => void): () => void;
}

export interface ConsoleAttribution {
  nav?: string; action_id?: string; after_id?: string; group?: string;
}

interface RemoteObjectLike {
  type?: string; value?: unknown; unserializableValue?: string; description?: string;
}
interface ContextDescription { id: number; auxData?: { frameId?: string; isDefault?: boolean; type?: string }; }
interface StackFrame { functionName: string; url: string; lineNumber: number; columnNumber: number; }
interface ExceptionDetails {
  text?: string; exception?: RemoteObjectLike; executionContextId?: number;
  stackTrace?: { callFrames?: StackFrame[] };
}
interface LogEntryPayload { source: string; level: string; text: string; timestamp?: number; }

const MAX_ENTRIES = 1000;
const MAX_TEXT = 2000;

export class ConsoleObserver {
  private readonly entries: ConsoleEntry[] = [];
  private readonly contexts = new Map<number, { frameId?: string; isDefault: boolean }>();
  private readonly defaultContexts = new Map<string, number>();
  private readonly disposers: Array<() => void> = [];
  private seq = 0;
  private active = false;
  private truncated = false;

  constructor(
    private readonly channel: ConsoleObserverChannel,
    private readonly targetId: string,
    private readonly getAttribution: () => ConsoleAttribution,
    private readonly onEntry?: (entry: ConsoleEntry) => void,
  ) {}

  async start(): Promise<void> {
    if (this.active) return;
    this.listen('Runtime.executionContextCreated', (params) => {
      const { context } = params as { context: ContextDescription };
      const frameId = context.auxData?.frameId;
      const isDefault = context.auxData?.isDefault === true;
      this.contexts.set(context.id, { frameId, isDefault });
      if (isDefault && frameId) this.defaultContexts.set(frameId, context.id);
    });
    this.listen('Runtime.executionContextDestroyed', (params) => {
      const { executionContextId } = params as { executionContextId: number };
      this.contexts.delete(executionContextId);
      for (const [frameId, id] of this.defaultContexts) {
        if (id === executionContextId) this.defaultContexts.delete(frameId);
      }
    });
    this.listen('Runtime.executionContextsCleared', () => {
      this.contexts.clear();
      this.defaultContexts.clear();
    });
    this.listen('Runtime.consoleAPICalled', (params) => {
      const event = params as { type: string; args: RemoteObjectLike[]; executionContextId: number; timestamp?: number };
      let level: ConsoleLevel = 'log';
      let parsed = true;
      try {
        level = normalizeConsoleLevel(event.type);
      } catch {
        parsed = false;
      }
      this.record({
        level, source: 'console-api', text: safeConsoleText(event.args), ts: event.timestamp,
        frameId: this.frameOf(event.executionContextId), incomplete: !parsed,
      });
    });
    this.listen('Runtime.exceptionThrown', (params) => {
      const { exceptionDetails, timestamp } = params as { exceptionDetails: ExceptionDetails; timestamp?: number };
      const exception = exceptionDetails.exception;
      const description = exception ? safeConsoleText(exception) : '';
      const frames = exceptionDetails.stackTrace?.callFrames ?? [];
      const stack = frames
        .map((frame) => `at ${frame.functionName || '<anonymous>'} (${frame.url}:${frame.lineNumber + 1}:${frame.columnNumber + 1})`)
        .join('\n');
      const base = description || exceptionDetails.text || '<exception>';
      const text = stack && !exception?.description ? `${base}\n${stack}` : base;
      this.record({
        level: 'error', source: 'exception', text, ts: timestamp,
        frameId: this.frameOf(exceptionDetails.executionContextId),
      });
    });
    this.listen('Log.entryAdded', (params) => {
      const { entry } = params as { entry: LogEntryPayload };
      let level: ConsoleLevel = 'log';
      let parsed = true;
      try {
        level = normalizeConsoleLevel(entry.level);
      } catch {
        parsed = false;
      }
      this.record({ level, source: 'log-entry', text: `[${entry.source}] ${entry.text}`, ts: entry.timestamp, incomplete: !parsed });
    });
    try {
      await this.channel.send('Runtime.enable');
      await this.channel.send('Log.enable');
    } catch (error) {
      this.unlisten();
      throw error;
    }
    this.active = true;
  }

  getDefaultContext(frameId: string): number | undefined {
    return this.defaultContexts.get(frameId);
  }

  snapshot(): ConsoleSnapshot {
    return { active: this.active, truncated: this.truncated, entries: this.entries.map((entry) => ({ ...entry })) };
  }

  dispose(): void {
    this.unlisten();
    this.active = false;
  }

  private listen(method: string, handler: (params: unknown) => void): void {
    this.disposers.push(this.channel.on(method, handler));
  }

  private unlisten(): void {
    for (const off of this.disposers.splice(0)) off();
  }

  private frameOf(executionContextId?: number): string | undefined {
    return executionContextId === undefined ? undefined : this.contexts.get(executionContextId)?.frameId;
  }

  private record(input: {
    level: ConsoleLevel; source: ConsoleSource; text: string; ts?: number; frameId?: string; incomplete?: boolean;
  }): void {
    const attribution = this.getAttribution();
    const redacted = redactText(input.text);
    const text = redacted.length > MAX_TEXT ? redacted.slice(0, MAX_TEXT) : redacted;
    const entry: ConsoleEntry = {
      seq: ++this.seq,
      ts: typeof input.ts === 'number' && Number.isFinite(input.ts) ? Math.round(input.ts) : Date.now(),
      level: input.level, source: input.source, text, target_id: this.targetId,
      ...(input.frameId !== undefined ? { frame_id: input.frameId } : {}),
      ...(attribution.nav !== undefined ? { nav: attribution.nav } : {}),
      ...(attribution.action_id !== undefined ? { action_id: attribution.action_id } : {}),
      ...(attribution.after_id !== undefined ? { after_id: attribution.after_id } : {}),
      ...(attribution.group !== undefined ? { group: attribution.group } : {}),
    };
    // 解析失败也置 truncated，消费方据此判不完整而不是假绿。
    if (input.incomplete || redacted.length > MAX_TEXT) this.truncated = true;
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.shift();
      this.truncated = true;
    }
    this.onEntry?.({ ...entry });
  }
}
