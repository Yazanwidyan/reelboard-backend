import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { all, closeDatabase, get, openDatabase } from "../src/db/index.js";

// A database made before has_password existed gets the column on start,
// and its accounts keep working as password accounts.
test("an existing database gains has_password", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reelboard-migrate-"));
  const file = path.join(dir, "old.db");
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE users (
    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL,
    handle TEXT NOT NULL UNIQUE COLLATE NOCASE, display_name TEXT NOT NULL, bio TEXT NOT NULL DEFAULT '',
    avatar_uri TEXT, color TEXT NOT NULL, xp INTEGER NOT NULL DEFAULT 0, level INTEGER NOT NULL DEFAULT 1,
    top_ten TEXT NOT NULL DEFAULT '[]', pinned_collections TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL)`);
  old.exec(`INSERT INTO users (id, email, password_hash, handle, display_name, color, created_at)
            VALUES ('u_old', 'old@example.com', 'x', 'old', 'Old', '#fff', 1)`);
  old.close();

  try {
    openDatabase(file);
    assert.ok(all("PRAGMA table_info(users)").some((column) => column.name === "has_password"));
    assert.equal(get("SELECT has_password FROM users WHERE id = 'u_old'").has_password, 1);
  } finally {
    closeDatabase();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
