import { Logger as BaseLogger } from "@bot/shared";

/** Extends shared Logger with Endfield's `log()` alias for backward compatibility. */
export class Logger extends BaseLogger {
  log(message: string): void {
    this.info(message);
  }
}
