import { readFile } from 'node:fs/promises';
import { createTursoClient } from '../server/turso.js';

try {
  const client = createTursoClient();
  const schema = await readFile(new URL('../db/turso-schema.sql', import.meta.url), 'utf8');
  await client.executeMultiple(schema);
  console.log('Turso schema applied.');
  client.close();
} catch (error) {
  console.error(`Turso setup failed: ${error.message}`);
  process.exitCode = 1;
}

