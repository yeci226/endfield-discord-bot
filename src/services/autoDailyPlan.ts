/**
 * Pure decisions for auto daily sign-in. No Discord, no database, no network.
 * "Today" and "hour" are Asia/Taipei (UTC+8, no daylight saving).
 */

export const MAX_AUTO_DAILY_ATTEMPTS = 6;
const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export type AutoDailyStatus = "done" | "retry" | "failed";

/** Stored at `autoDailyState.<userId>`. */
export interface AutoDailyState {
  date: string; // YYYY-MM-DD, Asia/Taipei
  status: AutoDailyStatus;
  attempts: number;
  lastError?: string;
  nextAttemptAt?: number; // epoch ms
}

export type AttendanceKind = "signed" | "already" | "token_expired" | "error";

const toMs = (now: number | Date): number =>
  now instanceof Date ? now.getTime() : now;

/** "YYYY-MM-DD" in Asia/Taipei. */
export function taipeiDate(now: number | Date): string {
  return new Date(toMs(now) + TAIPEI_OFFSET_MS).toISOString().slice(0, 10);
}

/** 0-23 in Asia/Taipei. */
export function taipeiHour(now: number | Date): number {
  return new Date(toMs(now) + TAIPEI_OFFSET_MS).getUTCHours();
}

/** Epoch ms of the next top of the hour (Asia/Taipei hours are whole UTC hours). */
export function nextHourStart(now: number | Date): number {
  const ms = toMs(now);
  return Math.floor(ms / HOUR_MS) * HOUR_MS + HOUR_MS;
}

/**
 * Should this user be processed now?
 * Runs when today is not finished, the configured hour has been reached (so missed hours
 * are caught up after downtime), fewer than MAX attempts were made and the retry time has
 * come. A day that ended unfinished is not carried over: the new day starts from scratch.
 */
export function planAutoDaily(
  now: number | Date,
  config: { time: number },
  state: AutoDailyState | null | undefined,
): "run" | "skip" {
  const ms = toMs(now);
  const today = taipeiDate(ms);
  if (taipeiHour(ms) < Number(config.time)) return "skip";
  if (!state || state.date !== today) return "run";
  if (state.status === "done" || state.status === "failed") return "skip";
  if (state.attempts >= MAX_AUTO_DAILY_ATTEMPTS) return "skip";
  if (typeof state.nextAttemptAt === "number" && ms < state.nextAttemptAt)
    return "skip";
  return "run";
}

export function isTokenExpiredError(error: any): boolean {
  return error?.code === 10000 || error?.message === "TokenExpired";
}

/** Result of processRoleAttendance (or an error converted to the same shape). */
export interface AttendanceResultLike {
  signedNow?: boolean;
  hasToday?: boolean;
  error?: boolean;
  errorKind?: "token_expired" | "error";
  message?: string;
}

export function classifyAttendance(
  result: AttendanceResultLike | null | undefined,
): AttendanceKind {
  if (!result) return "error";
  if (result.signedNow) return "signed";
  if (result.hasToday) return "already";
  if (result.errorKind === "token_expired") return "token_expired";
  return "error";
}

export interface RunSummary {
  signed: number;
  already: number;
  /** Real failures (not token related). */
  error: number;
  /** Token looks dead but this is the first time we saw it: confirm on the next attempt. */
  tokenExpiredPending: number;
  /** Token dead and seen dead before: the user has been (or is being) told. */
  tokenExpiredConfirmed: number;
}

/**
 * The state to store after a run. `attempts` already includes this run.
 * - nothing failed                      -> done
 * - only confirmed dead tokens failed   -> failed (nothing to retry; the user must /login)
 * - anything else failed                -> retry at the next full hour, failed after MAX
 */
export function nextAutoDailyState(
  today: string,
  now: number | Date,
  attempts: number,
  summary: RunSummary,
  lastError?: string,
): AutoDailyState {
  const retryable = summary.error + summary.tokenExpiredPending;
  if (retryable === 0 && summary.tokenExpiredConfirmed === 0) {
    return { date: today, status: "done", attempts };
  }
  if (retryable === 0) {
    return {
      date: today,
      status: "failed",
      attempts,
      lastError: lastError || "token_expired",
    };
  }
  if (attempts >= MAX_AUTO_DAILY_ATTEMPTS) {
    return { date: today, status: "failed", attempts, lastError };
  }
  return {
    date: today,
    status: "retry",
    attempts,
    lastError,
    nextAttemptAt: nextHourStart(now),
  };
}
