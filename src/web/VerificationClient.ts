import { EventEmitter } from "node:events";
import { Logger } from "../utils/Logger";
import { ExtendedClient } from "../structures/Client";

/**
 * VerificationClient handles the in-memory bridge between the Web callback
 * and the Discord command execution.
 *
 * Flow:
 * 1. Command starts -> VerificationClient.onResult(sessionId, callback)
 * 2. Web callback (Browser) -> WebManager -> VerificationClient.emitResult(sessionId, result)
 * 3. Command receives result and continues.
 */
export class VerificationClient {
  private static logger = new Logger("VerificationClient");
  private static events = new EventEmitter();

  constructor(client?: ExtendedClient) {
    // Client reference kept for potential future cross-cluster logic
  }

  /**
   * Register a listener for a verification result.
   */
  public static onResult(sessionId: string, callback: (result: any) => void) {
    VerificationClient.logger.info(
      `Registered listener for session: ${sessionId}`,
    );
    this.events.once(`result:${sessionId}`, callback);

    // Timeout registration cleanup after 15 minutes
    setTimeout(
      () => {
        this.events.removeAllListeners(`result:${sessionId}`);
      },
      15 * 60 * 1000,
    );
  }

  /**
   * Emit a verification result from the web callback.
   */
  public static emitResult(sessionId: string, result: any) {
    VerificationClient.logger.success(
      `Emitting result for session: ${sessionId}`,
    );
    this.events.emit(`result:${sessionId}`, result);
  }

  /**
   * Dummy methods for compatibility with index.ts initialization
   */
  public start() {
    VerificationClient.logger.info("Verification Bridge started (Local Mode)");
  }

  public stop() {
    VerificationClient.logger.info("Verification Bridge stopped");
  }
}
