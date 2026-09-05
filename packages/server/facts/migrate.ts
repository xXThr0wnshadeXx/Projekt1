import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import type {Pool} from 'pg';

/** Apply after migrations 001/002. Same checksum registry and advisory lock as existing migrations. */
export async function migrateFactsStorage(pool: Pool, sqlFile: string): Promise<void> {
  const sql = await readFile(sqlFile, 'utf8'), digest = createHash('sha256').update(sql).digest('hex');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(741917, 1)');
    const prior = (await client.query<{digest: string}>('SELECT digest FROM app_migrations WHERE id=$1', ['003_fact_reviews'])).rows[0];
    if (prior) { if (prior.digest !== digest) throw new Error('Applied migration checksum differs'); }
    else {
      await client.query(sql);
      await client.query('INSERT INTO app_migrations(id,digest) VALUES($1,$2)', ['003_fact_reviews', digest]);
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
