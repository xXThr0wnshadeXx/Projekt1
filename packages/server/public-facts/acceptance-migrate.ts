import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import type {Pool} from 'pg';
export async function migratePublicClaimDecisions(pool: Pool, sqlFile: string): Promise<void> {
  const sql = await readFile(sqlFile, 'utf8'), digest = createHash('sha256').update(sql).digest('hex'), c = await pool.connect();
  try {
    await c.query('BEGIN'); await c.query('SELECT pg_advisory_xact_lock(741917,1)');
    const prior = (await c.query<{digest: string}>('SELECT digest FROM app_migrations WHERE id=$1', ['006_public_claim_decisions'])).rows[0];
    if (prior) {if (prior.digest !== digest) throw new Error('Applied migration checksum differs');}
    else {await c.query(sql); await c.query('INSERT INTO app_migrations(id,digest) VALUES($1,$2)', ['006_public_claim_decisions', digest]);}
    await c.query('COMMIT');
  } catch (error) {await c.query('ROLLBACK'); throw error;} finally {c.release();}
}
