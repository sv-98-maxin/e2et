import type { CdpSession } from './daemon-client.js';
import { resolveViewport } from '../shared/viewport.js';

/** 会话视口租约：截图和流程录制共用同一个 device metrics override，
 *  最后一个持有者释放时才清除，避免一方 clear 掉另一方正在用的视口。
 *  hold 前登记 pending 防止异步期间别的 release 提前 clear。 */
interface Lease { pending: number; confirmed: number; }
const leases = new WeakMap<CdpSession, Lease>();

export async function holdViewport(session: CdpSession): Promise<void> {
  const lease = leases.get(session) || { pending: 0, confirmed: 0 };
  lease.pending++;
  leases.set(session, lease);
  try {
    await session.send('Emulation.setDeviceMetricsOverride', { ...resolveViewport(), deviceScaleFactor: 1, mobile: false });
    lease.confirmed++;
  } finally {
    lease.pending--;
    // 最后一个 pending 失败后没人会再 release，这里兜底清掉残留 override。
    if (lease.confirmed === 0 && lease.pending === 0) {
      leases.delete(session);
      await session.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
    }
  }
}

export async function releaseViewport(session: CdpSession): Promise<void> {
  const lease = leases.get(session);
  if (!lease || lease.confirmed <= 0) return;
  lease.confirmed--;
  if (lease.confirmed > 0 || lease.pending > 0) {
    return;
  }
  leases.delete(session);
  await session.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
}
