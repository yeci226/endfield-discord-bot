import crypto from "crypto";
import { Logger } from "../utils/Logger";
import { ExtendedClient } from "../structures/Client";
import type { CustomDatabase } from "../utils/Database";

export const CAPTCHA_TTL_MS = 15 * 60 * 1000;
export const CAPTCHA_POLL_MS = 1000;
const SESSION_KEY = (sid: string) => `captcha_session:${sid}`;
const RESULT_KEY = (sid: string) => `captcha_result:${sid}`;

/**
 * Bridge between the web callback (which may run on another cluster process)
 * and the Discord command waiting for the Geetest result. All state lives in
 * the shared database, nothing in memory:
 *
 * 1. /login: createSession() -> sessionId, shows the verify link, then
 *    waitForResult(sessionId) (polls the database).
 * 2. Browser POSTs /callback -> submitResult() writes `captcha_result:<sid>`.
 * 3. waitForResult() reads it once, deletes the rows and resolves.
 */
export class VerificationClient {
  private static logger = new Logger("VerificationClient");
  private static db: CustomDatabase | null = null;

  constructor(client?: ExtendedClient) {
    if (client?.db) VerificationClient.db = client.db;
  }

  private static getDb(db?: CustomDatabase): CustomDatabase {
    const d = db ?? VerificationClient.db;
    if (!d) throw new Error("VerificationClient has no database bound");
    return d;
  }

  /** Creates a pending captcha session and returns its unguessable id. */
  public static createSession(userId?: string, db?: CustomDatabase): string {
    const sid = crypto.randomBytes(18).toString("base64url");
    VerificationClient.getDb(db).setWithTtl(
      SESSION_KEY(sid),
      { userId: userId ?? null, createdAt: Date.now() },
      CAPTCHA_TTL_MS,
    );
    return sid;
  }

  /**
   * Called by the web callback. Returns false (and stores nothing) when the
   * session does not exist / expired / already has a result.
   */
  public static submitResult(
    sessionId: string,
    result: unknown,
    db?: CustomDatabase,
  ): boolean {
    const d = VerificationClient.getDb(db);
    if (typeof sessionId !== "string" || !d.getFresh(SESSION_KEY(sessionId)))
      return false;
    if (d.getFresh(RESULT_KEY(sessionId)) !== null) return false;
    d.setWithTtl(RESULT_KEY(sessionId), result, CAPTCHA_TTL_MS);
    VerificationClient.logger.success("Result stored for a captcha session");
    return true;
  }

  /**
   * Polls the database until the result arrives (then deletes it) or rejects
   * on timeout. Leaves no timers or listeners behind.
   */
  public static waitForResult<T = any>(
    sessionId: string,
    timeoutMs: number = CAPTCHA_TTL_MS,
    db?: CustomDatabase,
    pollMs: number = CAPTCHA_POLL_MS,
  ): Promise<T> {
    const d = VerificationClient.getDb(db);
    return new Promise<T>((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const cleanup = () => {
        void d.delete(RESULT_KEY(sessionId));
        void d.delete(SESSION_KEY(sessionId));
      };
      const tick = () => {
        try {
          const found = d.getFresh<T>(RESULT_KEY(sessionId));
          if (found !== null) {
            cleanup();
            return resolve(found);
          }
          if (Date.now() >= deadline) {
            cleanup();
            return reject(new Error("Captcha verification timed out"));
          }
          setTimeout(tick, Math.min(pollMs, deadline - Date.now()));
        } catch (e) {
          reject(e);
        }
      };
      tick();
    });
  }

  /**
   * Dummy methods for compatibility with index.ts initialization
   */
  public start() {
    VerificationClient.logger.info("Verification bridge started (database)");
  }

  public stop() {
    VerificationClient.logger.info("Verification bridge stopped");
  }
}
