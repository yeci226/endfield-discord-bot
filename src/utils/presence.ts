export interface PresenceUpdaterDeps {
  /** Sum of guilds over all clusters (one broadcastEval). */
  getTotal(): Promise<number>;
  /** Push the same presence text to every cluster (second broadcastEval). */
  push(total: number): Promise<void>;
  /** Re-push even when unchanged this often, so respawned clusters get a presence. */
  repushEveryMs?: number;
  now?: () => number;
}

/** Returns a tick function: pushes only when the total changed (or the re-push interval passed). */
export function createPresenceUpdater(deps: PresenceUpdaterDeps) {
  const repushEveryMs = deps.repushEveryMs ?? 10 * 60_000;
  const now = deps.now ?? Date.now;
  let lastTotal: number | null = null;
  let lastPushAt = 0;
  return async function tick(): Promise<"pushed" | "skipped" | "failed"> {
    let total: number;
    try {
      total = await deps.getTotal();
    } catch {
      return "failed";
    }
    if (!Number.isFinite(total) || total <= 0) return "failed";
    const t = now();
    if (total === lastTotal && t - lastPushAt < repushEveryMs) return "skipped";
    try {
      await deps.push(total);
    } catch {
      return "failed";
    }
    lastTotal = total;
    lastPushAt = t;
    return "pushed";
  };
}
