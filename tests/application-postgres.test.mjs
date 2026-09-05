import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {openPostgresStorage} from '../dist/packages/server/application.js';

test('real startup storage applies 001 then 002 then 003 and can probe', {skip:!process.env.STORAGE_TEST_DATABASE_URL},async()=>{
 const schema='composition_'+randomUUID().replaceAll('-','');
 const admin=new Pool({connectionString:process.env.STORAGE_TEST_DATABASE_URL});let db;
 try{
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url=new URL(process.env.STORAGE_TEST_DATABASE_URL);url.searchParams.set('options',`-c search_path=${schema}`);
  db=await openPostgresStorage(url.href);await db.migrate();await db.migrate();
  const applied=await admin.query(`SELECT id FROM ${schema}.app_migrations ORDER BY id`);
  assert.deepEqual(applied.rows.map(r=>r.id),['001_private_storage','002_contacts_grants','003_fact_reviews']);
  assert.equal(await db.probe(new AbortController().signal),true);assert.equal(await db.probe(AbortSignal.abort()),false);
 }finally{await db?.close();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}
});
