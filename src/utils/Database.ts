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
}
