import { tursoHealth } from '../server/turso.js';

try {
  if (!await tursoHealth()) throw new Error('Turso returned an unexpected health response.');
  console.log('Turso connection OK.');
} catch (error) {
  console.error(`Turso connection failed: ${error.message}`);
  process.exitCode = 1;
}

