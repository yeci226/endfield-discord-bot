export interface ReminderWizardSessionRecord {
  owner: string;
  expires: number;
}

export interface ReminderWizardSessionDatabase {
  get<T = any>(key: string): Promise<T | null>;
  set(key: string, value: any): Promise<void>;
  delete(key: string): Promise<void>;
  findByPrefix<T = any>(prefix: string): Promise<Array<{ id: string; value: T }>>;
}

const SESSION_PREFIX = "reminderWizard.session.v1.";
const sessionKey = (token: string) => `${SESSION_PREFIX}${token}`;

function isExpired(session: ReminderWizardSessionRecord, now: number): boolean {
  return !Number.isFinite(session?.expires) || session.expires <= now;
}

/**
 * Load wizard state from the shared SQLite store. Cluster workers keep separate
 * heaps, so an in-memory Map cannot be the source of truth for component events.
 */
export async function getReminderWizardSession<
  T extends ReminderWizardSessionRecord,
>(
  db: ReminderWizardSessionDatabase,
  token: string,
  now = Date.now(),
): Promise<T | undefined> {
  const key = sessionKey(token);
  const session = await db.get<T>(key);
  if (!session) return undefined;
  if (isExpired(session, now)) {
    await db.delete(key);
    return undefined;
  }
  return session;
}

export async function saveReminderWizardSession<
  T extends ReminderWizardSessionRecord,
>(
  db: ReminderWizardSessionDatabase,
  token: string,
  session: T,
): Promise<void> {
  await db.set(sessionKey(token), session);
}

export async function deleteReminderWizardSession(
  db: ReminderWizardSessionDatabase,
  token: string,
): Promise<void> {
  await db.delete(sessionKey(token));
}

export async function pruneExpiredReminderWizardSessions(
  db: ReminderWizardSessionDatabase,
  now = Date.now(),
): Promise<void> {
  const entries = await db.findByPrefix<ReminderWizardSessionRecord>(
    SESSION_PREFIX,
  );
  await Promise.all(
    entries
      .filter(({ value }) => isExpired(value, now))
      .map(({ id }) => db.delete(id)),
  );
}
