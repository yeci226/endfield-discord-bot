export interface ErrorLogger {
  error(...args: unknown[]): void;
}

export interface ErrorWebhook {
  send(payload: any): Promise<unknown>;
}

export interface ProcessLike {
  on(event: string, listener: (...args: any[]) => void): unknown;
}

/** Flattens anything that can be thrown (including null/undefined) into printable text. */
export function describeError(reason: unknown): { message: string; stack: string } {
  if (reason instanceof Error)
    return { message: reason.message, stack: reason.stack || reason.message };
  if (reason && typeof reason === "object") {
    const r = reason as any;
    const message = typeof r.message === "string" ? r.message : safeJson(reason);
    return { message, stack: typeof r.stack === "string" ? r.stack : message };
  }
  const message = String(reason);
  return { message, stack: message };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** True at most once per windowMs for each distinct key. Bounded memory. */
export function createKeyThrottle(windowMs: number, maxKeys = 200) {
  const last = new Map<string, number>();
  return (key: string, now = Date.now()): boolean => {
    const prev = last.get(key);
    if (prev !== undefined && now - prev < windowMs) return false;
    if (last.size >= maxKeys) {
      for (const [k, t] of last) if (now - t >= windowMs) last.delete(k);
      if (last.size >= maxKeys) last.delete(last.keys().next().value as string);
    }
    last.set(key, now);
    return true;
  };
}

/**
 * uncaughtException: log, report (throttled), then exit(1) after a short delay
 * so the cluster manager respawns a clean process. unhandledRejection: log and
 * report (throttled) but keep running.
 */
export function installProcessErrorHandlers(opts: {
  logger: ErrorLogger;
  webhook?: ErrorWebhook | null;
  proc?: ProcessLike;
  exit?: (code: number) => void;
  exitDelayMs?: number;
  throttleMs?: number;
  now?: () => number;
}) {
  const proc = opts.proc ?? process;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const delay = opts.exitDelayMs ?? 1000;
  const allow = createKeyThrottle(opts.throttleMs ?? 30_000);
  const now = opts.now ?? Date.now;

  async function report(kind: string, reason: unknown): Promise<void> {
    const { message, stack } = describeError(reason);
    opts.logger.error(`${kind}: ${message}`);
    opts.logger.error(stack);
    if (!opts.webhook || !allow(`${kind}:${message}`, now())) return;
    try {
      await opts.webhook.send({
        embeds: [
          {
            title: `🚨 **${kind}**`,
            description: `\`\`\`${stack.slice(0, 3900)}\`\`\``,
            color: 0xff0000,
          },
        ],
      });
    } catch (e) {
      opts.logger.error("Failed to send webhook", e);
    }
  }

  const onRejection = (reason: unknown) => {
    void report("Unhandled Rejection", reason);
  };
  const onException = (error: unknown) => {
    // Schedule the exit first: nothing below may keep a broken process alive.
    const timer = setTimeout(() => exit(1), delay);
    (timer as any).unref?.();
    void report("Uncaught Exception", error);
  };
  proc.on("unhandledRejection", onRejection);
  proc.on("uncaughtException", onException);
  return { onRejection, onException };
}
