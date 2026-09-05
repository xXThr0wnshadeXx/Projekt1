import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';

/** Caller explicitly supplies a migration file; never discover/execute arbitrary SQL files. */
export async function migratePrivateStorage(pool: Pool, sqlFile: string): Promise<void> {
  const sql = await readFile(sqlFile, 'utf8');
  const digest = createHash('sha256').update(sql).digest('hex');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(741917, 1)");
    await client.query('CREATE TABLE IF NOT EXISTS app_migrations (id text PRIMARY KEY, digest text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    const prior = await client.query<{digest: string}>("SELECT digest FROM app_migrations WHERE id = '001_private_storage'");
    if (prior.rows[0]) {
      if (prior.rows[0].digest !== digest) throw new Error('Applied migration checksum differs');
    } else {
      await client.query(sql);
      await client.query("INSERT INTO app_migrations(id,digest) VALUES('001_private_storage',$1)", [digest]);
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
