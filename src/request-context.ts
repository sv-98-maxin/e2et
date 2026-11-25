import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  signal: AbortSignal;
  onProgress: (deadlineMs: number) => void;
  inputCleanups: Map<object, Map<string, () => Promise<void>>>;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

export async function releaseRequestInputs(): Promise<boolean> {
  const inputs = requestContext.getStore()?.inputCleanups;
  if (!inputs) return true;
  const releases = [...inputs.values()].flatMap((entries) => [...entries.values()]);
  inputs.clear();
  const results = await Promise.allSettled(releases.map(async (release) => release()));
  return results.every((result) => result.status === 'fulfilled');
}
