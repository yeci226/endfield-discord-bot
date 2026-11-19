/**
 * Pure decisions for auto daily sign-in. No Discord, no database, no network.
 * "Today" and "hour" are Asia/Taipei (UTC+8, no daylight saving).
 */

export const MAX_AUTO_DAILY_ATTEMPTS = 6;
/** A dead login must be seen dead again at least this long after the first sighting. */
export const EXPIRED_CONFIRM_MS = 30 * 60 * 1000;
/** At most this many "login expired" DMs per hourly tick (day-one backlog protection). */
export const MAX_EXPIRED_DMS_PER_TICK = 40;
/** A tick stops starting new users after this long; the rest are picked up by the next tick. */
export const TICK_BUDGET_MS = 50 * 60 * 1000;
/** Only in the first hours of a new day may an unfinished previous day be caught up at once. */
export const ROLLOVER_CATCHUP_HOURS = 3;
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
  /** First time (epoch ms) each account (by account id) was seen with a dead login today. */
  expiredSeen?: Record<string, number>;
  /** The earliest value of `expiredSeen`. */
  expiredSeenAt?: number;
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
  if (taipeiHour(ms) < Number(config.time)) {
    return isRolloverCatchUp(ms, state) ? "run" : "skip";
  }
  if (!state || state.date !== today) return "run";
  if (state.status === "done" || state.status === "failed") return "skip";
  if (state.attempts >= MAX_AUTO_DAILY_ATTEMPTS) return "skip";
  if (typeof state.nextAttemptAt === "number" && ms < state.nextAttemptAt)
    return "skip";
  return "run";
}

/**
 * Day rollover: a user whose hour (say 23) was not reached before midnight would otherwise wait
 * a whole day. In the first hours of the new day, run once when the previous day is known to be
 * unfinished: its state is still `retry`, or the newest state is older than yesterday (the user
 * was not reached at all). No state at all proves nothing (a new user, or the first tick after
 * this feature shipped), so it never triggers a catch-up. The attempt is written for the NEW
 * day, so that day then counts as done and the user is not signed twice.
 */
export function isRolloverCatchUp(
  now: number | Date,
  state: AutoDailyState | null | undefined,
): boolean {
  const ms = toMs(now);
  if (taipeiHour(ms) >= ROLLOVER_CATCHUP_HOURS) return false;
  if (!state || typeof state.date !== "string") return false;
  const today = taipeiDate(ms);
  if (state.date >= today) return false;
  const yesterday = taipeiDate(ms - 24 * HOUR_MS);
  if (state.date === yesterday) return state.status === "retry";
  return state.date < yesterday;
}

/** True once a first "dead login" sighting is old enough to be confirmed. */
export function isExpiryConfirmed(
  seenAt: number | undefined | null,
  now: number | Date,
): boolean {
  return typeof seenAt === "number" && toMs(now) - seenAt >= EXPIRED_CONFIRM_MS;
}

/** Keep starting users only while the tick is within its time budget. */
export function shouldStartAnotherUser(
  tickStartedAt: number,
  now: number | Date,
): boolean {
  return toMs(now) - tickStartedAt < TICK_BUDGET_MS;
}

const TRANSIENT_CODES = new Set([
  "ECONNABORTED",
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EPIPE",
  "ERR_NETWORK",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/** A thrown error that looks like a network problem, timeout, HTTP 5xx or 429. */
export function isTransientError(error: any): boolean {
  const status = Number(error?.response?.status ?? error?.status);
  if (status === 429 || (status >= 500 && status < 600)) return true;
  if (TRANSIENT_CODES.has(String(error?.code || ""))) return true;
  return /timeout of|timed out|socket hang up/i.test(String(error?.message || ""));
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
  /** Transient failures (network, timeout, 5xx, 429, unknown login check): retry next hour. */
  error: number;
  /** Failures that retrying cannot fix (anything not transient). Default 0. */
  permanentError?: number;
  /** Token looks dead but this is the first time we saw it: confirm on the next attempt. */
  tokenExpiredPending: number;
  /** Token dead and seen dead before: the user has been (or is being) told. */
  tokenExpiredConfirmed: number;
}

/**
 * The state to store after a run. `attempts` already includes this run.
 * - nothing failed                                   -> done
 * - only permanent errors and/or confirmed dead
 *   logins failed                                    -> failed (retrying cannot help)
 * - a transient error or a not yet confirmed dead
 *   login                                            -> retry at the next full hour (a pending
 *                                                       dead login: after at least 30 minutes),
 *                                                       failed after MAX attempts
 * `expiredSeen` (account id -> first sighting) is kept only while a retry is pending.
 */
export function nextAutoDailyState(
  today: string,
  now: number | Date,
  attempts: number,
  summary: RunSummary,
  lastError?: string,
  expiredSeen?: Record<string, number>,
): AutoDailyState {
  const permanent = summary.permanentError ?? 0;
  const retryable = summary.error + summary.tokenExpiredPending;
  if (retryable === 0 && permanent === 0 && summary.tokenExpiredConfirmed === 0) {
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
  const seen = expiredSeen && Object.keys(expiredSeen).length ? expiredSeen : undefined;
  const base = toMs(now);
  return {
    date: today,
    status: "retry",
    attempts,
    lastError,
    nextAttemptAt: nextHourStart(
      summary.error > 0 ? base : base + EXPIRED_CONFIRM_MS,
    ),
    ...(seen
      ? { expiredSeen: seen, expiredSeenAt: Math.min(...Object.values(seen)) }
      : {}),
  };
}
