import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';

/** Caller explicitly supplies a migration file; never discover/execute arbitrary SQL files. */
async function applyMigration(pool: Pool, sqlFile: string, migrationId: string): Promise<void> {
  const sql = await readFile(sqlFile, 'utf8');
  const digest = createHash('sha256').update(sql).digest('hex');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(741917, 1)");
    await client.query('CREATE TABLE IF NOT EXISTS app_migrations (id text PRIMARY KEY, digest text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    const prior = await client.query<{digest: string}>('SELECT digest FROM app_migrations WHERE id = $1', [migrationId]);
    if (prior.rows[0]) {
      if (prior.rows[0].digest !== digest) throw new Error('Applied migration checksum differs');
    } else {
      await client.query(sql);
      await client.query('INSERT INTO app_migrations(id,digest) VALUES($1,$2)', [migrationId, digest]);
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function migratePrivateStorage(pool: Pool, sqlFile: string): Promise<void> {
  return applyMigration(pool, sqlFile, '001_private_storage');
}
/** Run after migratePrivateStorage. Shares its transaction advisory lock and checksum semantics. */
export async function migrateContactsStorage(pool: Pool, sqlFile: string): Promise<void> {
  return applyMigration(pool, sqlFile, '002_contacts_grants');
}
