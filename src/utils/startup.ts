export interface StartupLogger {
  info(msg: string): void;
  error(msg: string, err?: unknown): void;
}

type HookFn = () => void | Promise<void>;

interface OneShot {
  name: string;
  fn: HookFn;
}
interface Periodic {
  name: string;
  intervalMs: number;
  fn: HookFn;
}

export class StartupHooks {
  private names = new Set<string>();
  private oneShots: OneShot[] = [];
  private periodics: Periodic[] = [];
  private timers: NodeJS.Timeout[] = [];
  private state: "pending" | "primary" | "secondary" = "pending";

  constructor(private logger: StartupLogger) {}

  /** Runs once on the primary cluster (cluster id 0) after ready. */
  onPrimary(name: string, fn: HookFn): void {
    this.claimName(name);
    const hook = { name, fn };
    if (this.state === "pending") this.oneShots.push(hook);
    else if (this.state === "primary") void this.runOnce(hook);
  }

  /** Runs every intervalMs on the primary cluster after ready; first run after one interval. */
  every(name: string, intervalMs: number, fn: HookFn): void {
    this.claimName(name);
    const hook = { name, intervalMs, fn };
    if (this.state === "pending") this.periodics.push(hook);
    else if (this.state === "primary") this.startPeriodic(hook);
  }

  /** Called once from the ready event. Non-primary clusters do nothing. Never throws. */
  async run(isPrimary: boolean): Promise<void> {
    if (this.state !== "pending") return;
    this.state = isPrimary ? "primary" : "secondary";
    const oneShots = this.oneShots;
    const periodics = this.periodics;
    this.oneShots = [];
    this.periodics = [];
    if (!isPrimary) return;
    for (const hook of oneShots) await this.runOnce(hook);
    for (const hook of periodics) this.startPeriodic(hook);
  }

  /** Clears all intervals. */
  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  private claimName(name: string): void {
    if (this.names.has(name))
      throw new Error(`Startup hook already registered: ${name}`);
    this.names.add(name);
  }

  private async runOnce(hook: { name: string; fn: HookFn }): Promise<void> {
    try {
      await hook.fn();
    } catch (err) {
      this.logError(hook.name, err);
    }
  }

  private startPeriodic(hook: Periodic): void {
    let running = false;
    const timer = setInterval(async () => {
      if (running) return;
      running = true;
      try {
        await hook.fn();
      } catch (err) {
        this.logError(hook.name, err);
      } finally {
        running = false;
      }
    }, hook.intervalMs);
    timer.unref();
    this.timers.push(timer);
  }

  private logError(name: string, err: unknown): void {
    try {
      this.logger.error(`Startup hook "${name}" failed`, err);
    } catch {
      // logging must never throw
    }
  }
}
