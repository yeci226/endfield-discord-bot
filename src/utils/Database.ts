import Database from "better-sqlite3";

export interface DatabaseTransaction {
  get<T = any>(key: string): T | null;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  keys(prefix: string): string[];
}

export class CustomDatabase {
  private db: Database.Database;

  /** Synchronous, atomic read-modify-write. Never await inside the callback. */
  public transaction<T>(callback: (store: DatabaseTransaction) => T): T {
    return this.db
      .transaction(() => {
        const result = callback({
          get: <V = any>(key: string): V | null => {
            const row = this.db
              .prepare("SELECT json FROM json WHERE ID = ?")
              .get(key) as { json: string } | undefined;
            return row ? JSON.parse(row.json) : null;
          },
          set: (key, value) => {
            this.db
              .prepare("INSERT OR REPLACE INTO json (ID, json) VALUES (?, ?)")
              .run(key, JSON.stringify(value));
          },
          delete: (key) => {
            this.db.prepare("DELETE FROM json WHERE ID = ?").run(key);
          },
          keys: (prefix) =>
            (
              this.db
                .prepare("SELECT ID FROM json WHERE ID >= ? AND ID < ?")
                .all(prefix, prefix + "\uffff") as { ID: string }[]
            ).map((row) => row.ID),
        });
        if (result && typeof (result as any).then === "function")
          throw new Error("Database transaction callbacks must be synchronous");
        return result;
      })
      .immediate();
  }

  constructor(filePath: string) {
    this.db = new Database(filePath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS json (
        ID TEXT PRIMARY KEY,
        json TEXT
      )
    `);
  }

  /**
   * Get a value from the database
   * @param key The key to retrieve
   * @returns The value, or null if not found
   */
  public async get<T = any>(key: string): Promise<T | null> {
    const row = this.db
      .prepare("SELECT json FROM json WHERE ID = ?")
      .get(key) as { json: string } | undefined;

    if (!row) return null;

    try {
      return JSON.parse(row.json) as T;
    } catch {
      return row.json as unknown as T;
    }
  }

  /**
   * Set a value in the database
   * @param key The key to set
   * @param value The value to store
   */
  public async set(key: string, value: any): Promise<void> {
    const serialized = JSON.stringify(value);
    this.db
      .prepare("INSERT OR REPLACE INTO json (ID, json) VALUES (?, ?)")
      .run(key, serialized);
  }

  /**
   * Delete a key from the database
   * @param key The key to delete
   */
  public async delete(key: string): Promise<void> {
    this.db.prepare("DELETE FROM json WHERE ID = ?").run(key);
  }

  /**
   * Get all entries in the database
   */
  public async all(): Promise<Array<{ id: string; value: any }>> {
    const rows = this.db.prepare("SELECT * FROM json").all() as Array<{
      ID: string;
      json: string;
    }>;
    return rows.map((row) => ({
      id: row.ID,
      value: JSON.parse(row.json),
    }));
  }

  /**
   * Find entries with a specific ID prefix
   * @param prefix The prefix to search for
   */
  public async findByPrefix<T = any>(
    prefix: string,
  ): Promise<Array<{ id: string; value: T }>> {
    const rows = this.db
      .prepare("SELECT * FROM json WHERE ID LIKE ?")
      .all(`${prefix}%`) as Array<{
      ID: string;
      json: string;
    }>;
    return rows.map((row) => ({
      id: row.ID,
      value: JSON.parse(row.json),
    }));
  }

  /**
   * Find only the IDs of entries with a specific ID prefix (no JSON parsing).
   * Much faster than findByPrefix when you only need keys.
   * @param prefix The prefix to search for
   */
  public findKeysByPrefix(prefix: string): string[] {
    const rows = this.db
      .prepare("SELECT ID FROM json WHERE ID LIKE ?")
      .all(`${prefix}%`) as Array<{ ID: string }>;
    return rows.map((row) => row.ID);
  }

  /**
   * Find entries with a specific ID prefix, extracting a single JSON path via SQLite json_extract.
   * Much faster than findByPrefix when you only need one field from large objects.
   * @param prefix The prefix to search for
   * @param jsonPath SQLite json_extract path, e.g. '$.info.nickname'
   */
  public findFieldByPrefix(
    prefix: string,
    jsonPath: string,
  ): Array<{ id: string; field: string | null }> {
    const rows = this.db
      .prepare(
        `SELECT ID, json_extract(json, ?) as field FROM json WHERE ID LIKE ?`,
      )
      .all(jsonPath, `${prefix}%`) as Array<{
      ID: string;
      field: string | null;
    }>;
    return rows.map((row) => ({ id: row.ID, field: row.field ?? null }));
  }

  /**
   * Find entries under an exact, literal ID prefix using SQLite's primary-key index.
   * The prefix is intentionally restricted to characters that are not GLOB metacharacters.
   * @param prefix A literal ASCII ID prefix
   * @param jsonPath SQLite json_extract path, e.g. '$.info.nickname'
   */
  public findFieldByGlobPrefix(
    prefix: string,
    jsonPath: string,
  ): Array<{ id: string; field: string | null }> {
    if (!/^[A-Za-z0-9_-]+$/.test(prefix)) {
      throw new Error("Prefix must be a safe literal prefix.");
    }
    const rows = this.db
      .prepare(
        `SELECT ID, json_extract(json, ?) as field FROM json WHERE ID GLOB ?`,
      )
      .all(jsonPath, `${prefix}*`) as Array<{
      ID: string;
      field: string | null;
    }>;
    return rows.map((row) => ({ id: row.ID, field: row.field ?? null }));
  }

  /**
   * Atomically claim a slot: sets key=value only if the stored value differs,
   * Returns true if this process claimed the slot (performed the write),
   * false if the key already held the same value (another process beat us).
   * Safe across concurrent SQLite processes because better-sqlite3 transactions
   * acquire an exclusive write lock.
   */
  public claimSlot(key: string, value: string): boolean {
    const serialized = JSON.stringify(value);
    return this.db.transaction(() => {
      const row = this.db
        .prepare("SELECT json FROM json WHERE ID = ?")
        .get(key) as { json: string } | undefined;
      if (row?.json === serialized) return false;
      this.db
        .prepare("INSERT OR REPLACE INTO json (ID, json) VALUES (?, ?)")
        .run(key, serialized);
      return true;
    })();
  }

  /**
   * Find entries with a specific ID prefix and return only IDs
   * @param prefix The prefix to search for
   */
  public async findIdsByPrefix(prefix: string): Promise<string[]> {
    const rows = this.db
      .prepare("SELECT ID FROM json WHERE ID LIKE ?")
      .all(`${prefix}%`) as Array<{ ID: string }>;
    return rows.map((row) => row.ID);
  }

  /** Store a value that expires ttlMs from now. Read it back with getFresh(). */
  public setWithTtl(key: string, value: unknown, ttlMs: number): void {
    this.db
      .prepare("INSERT OR REPLACE INTO json (ID, json) VALUES (?, ?)")
      .run(key, JSON.stringify({ v: value, exp: Date.now() + ttlMs }));
  }

  /**
   * Read a value stored by setWithTtl. Returns null (and deletes the row) once
   * expired. Rows that are not in the { v, exp } shape return null untouched.
   */
  public getFresh<T = any>(key: string): T | null {
    const row = this.db
      .prepare("SELECT json FROM json WHERE ID = ?")
      .get(key) as { json: string } | undefined;
    if (!row) return null;
    let parsed: any;
    try {
      parsed = JSON.parse(row.json);
    } catch {
      return null;
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.exp !== "number" ||
      !("v" in parsed)
    ) {
      return null;
    }
    if (parsed.exp > Date.now()) return parsed.v as T;
    this.db.prepare("DELETE FROM json WHERE ID = ?").run(key);
    return null;
  }

  /**
   * Delete every row whose ID starts with the literal prefix (no LIKE
   * wildcards). Returns the number of rows deleted.
   */
  public deleteByPrefix(prefix: string): number {
    if (!prefix) throw new Error("Prefix must not be empty.");
    return this.db
      .prepare("DELETE FROM json WHERE ID >= ? AND ID < ?")
      .run(prefix, prefix + "￿").changes;
  }

  /**
   * Atomic read-modify-write of one key in an IMMEDIATE transaction.
   * Returning null from fn deletes the row. fn must be synchronous; if it
   * throws, nothing is written and the error is rethrown.
   */
  public update<T = any>(
    key: string,
    fn: (current: T | null) => T | null,
  ): T | null {
    return this.transaction((store) => {
      const next = fn(store.get<T>(key));
      if (next && typeof (next as any).then === "function")
        throw new Error("Database update callbacks must be synchronous");
      if (next === null) store.delete(key);
      else store.set(key, next);
      return next;
    });
  }

  private keyLocks = new Map<string, Promise<unknown>>();

  /** In-process mutex per key. Different keys never wait for each other. */
  public withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.keyLocks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.keyLocks.set(key, tail);
    tail.then(() => {
      if (this.keyLocks.get(key) === tail) this.keyLocks.delete(key);
    });
    return run;
  }

  /** Close the underlying connection. */
  public close(): void {
    this.db.close();
  }
}
