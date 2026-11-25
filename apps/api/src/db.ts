import crypto from "node:crypto";
import { Pool } from "pg";

export function createDbPool(connectionString?: string): Pool {
  return new Pool({
    connectionString:
      connectionString ??
      process.env.DATABASE_URL ??
      "postgresql://aagame:aagame_dev_password@127.0.0.1:5432/aa_game_maker",
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

export async function runMigrations(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS blobs (
      sha256 TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      forked_from_release_id TEXT,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      mode TEXT NOT NULL DEFAULT 'singleplayer',
      orientation TEXT NOT NULL DEFAULT 'responsive',
      config_schema JSONB NOT NULL DEFAULT '[]'::jsonb,
      current_snapshot_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS snapshots (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      parent_snapshot_id TEXT,
      file_manifest JSONB NOT NULL,
      spec_json JSONB,
      assets_json JSONB,
      commit_summary TEXT NOT NULL DEFAULT 'Snapshot',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS releases (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      mode TEXT NOT NULL DEFAULT 'singleplayer',
      orientation TEXT NOT NULL DEFAULT 'responsive',
      client_bundle TEXT NOT NULL,
      sim_bundle TEXT NOT NULL,
      client_bundle_url TEXT,
      room_bundle_url TEXT,
      cover_url TEXT,
      spec_json JSONB NOT NULL,
      config_schema JSONB NOT NULL DEFAULT '[]'::jsonb,
      config_values JSONB NOT NULL DEFAULT '{}'::jsonb,
      assets_json JSONB NOT NULL DEFAULT '{"version":1,"assets":[]}'::jsonb,
      play_count INTEGER NOT NULL DEFAULT 0,
      like_count INTEGER NOT NULL DEFAULT 0,
      remix_count INTEGER NOT NULL DEFAULT 0,
      is_public BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS release_likes (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      release_id TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, release_id)
    );

    CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_snapshots_project ON snapshots(project_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_releases_public ON releases(is_public, created_at DESC);
  `);
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, keyHex] = stored.split(":");
  if (!salt || !keyHex) return false;
  const derived = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(keyHex, "hex");
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

export function sha256(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Store project files using content-addressed SHA-256 deduplication.
 */
export async function storeFilesAsManifest(
  pool: Pool,
  files: Record<string, string>,
): Promise<Record<string, string>> {
  const manifest: Record<string, string> = {};
  for (const [filePath, content] of Object.entries(files)) {
    const hash = sha256(content);
    manifest[filePath] = hash;
    await pool.query(
      `INSERT INTO blobs (sha256, content, byte_size)
       VALUES ($1, $2, $3)
       ON CONFLICT (sha256) DO NOTHING`,
      [hash, content, Buffer.byteLength(content, "utf8")],
    );
  }
  return manifest;
}

export async function loadFilesFromManifest(
  pool: Pool,
  manifest: Record<string, string>,
): Promise<Record<string, string>> {
  const hashes = Array.from(new Set(Object.values(manifest)));
  if (hashes.length === 0) return {};
  const res = await pool.query<{ sha256: string; content: string }>(
    `SELECT sha256, content FROM blobs WHERE sha256 = ANY($1::text[])`,
    [hashes],
  );
  const byHash = new Map(res.rows.map((r) => [r.sha256, r.content]));
  const files: Record<string, string> = {};
  for (const [filePath, hash] of Object.entries(manifest)) {
    const content = byHash.get(hash);
    if (content !== undefined) files[filePath] = content;
  }
  return files;
}
