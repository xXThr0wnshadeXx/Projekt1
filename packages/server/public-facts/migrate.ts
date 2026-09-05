import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import type {Pool} from 'pg';

/** Explicit startup migration; same advisory lock/checksum registry as migrations 001-003. */
export async function migratePublicFactsStorage(pool: Pool, sqlFile: string): Promise<void> {
  const sql = await readFile(sqlFile, 'utf8'), digest = createHash('sha256').update(sql).digest('hex');
  const c = await pool.connect();
  try {
    await c.query('BEGIN'); await c.query('SELECT pg_advisory_xact_lock(741917,1)');
    const prior = (await c.query<{digest: string}>('SELECT digest FROM app_migrations WHERE id=$1', ['004_public_fact_staging'])).rows[0];
    if (prior) {if (prior.digest !== digest) throw new Error('Applied migration checksum differs');}
    else {await c.query(sql); await c.query('INSERT INTO app_migrations(id,digest) VALUES($1,$2)', ['004_public_fact_staging', digest]);}
    await c.query('COMMIT');
  } catch (error) {await c.query('ROLLBACK'); throw error;}
  finally {c.release();}
}
