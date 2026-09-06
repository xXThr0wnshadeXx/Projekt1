import {createHash} from 'node:crypto';import {readFile} from 'node:fs/promises';import type {Pool} from 'pg';
/** Independent of public-facts004; applies only the reserved discovery receipt table. */
async function apply(pool:Pool,path:string,id:string):Promise<void>{
 const sql=await readFile(path,'utf8'),digest=createHash('sha256').update(sql).digest('hex'),client=await pool.connect();
 try{await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(741917,1)');
  const prior=(await client.query('SELECT digest FROM app_migrations WHERE id=$1',[id])).rows[0];
  if(prior){if(prior.digest!==digest)throw new Error('Applied migration checksum differs');}
  else{await client.query(sql);await client.query('INSERT INTO app_migrations(id,digest) VALUES($1,$2)',[id,digest]);}
  await client.query('COMMIT');
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

export const migrateDiscoveryStorage=(pool:Pool,path:string)=>apply(pool,path,'005_discovery_receipts');
export const migrateDiscoveryStaging=(pool:Pool,path:string)=>apply(pool,path,'007_discovery_staging');
