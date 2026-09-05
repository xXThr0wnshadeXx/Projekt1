import { readFileSync, statSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export function browserEnvironment(env) {
  const result={VITE_AUTH_MODE:'http'};
  for (const key of ['PATH','HOME','TMPDIR','TEMP','TMP','LANG','LC_ALL','TERM','NO_COLOR','FORCE_COLOR','SystemRoot']) {
    if (env[key] !== undefined) result[key]=env[key];
  }
  return result;
}
export function privateEnvironment(path, inherited=process.env) {
  try {
    const info=statSync(path);
    if (!info.isFile() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) throw new Error();
    const values=parseEnv(readFileSync(path,'utf8'));
    // Private files configure the application, never Node code loading or browser-exposed values.
    if (Object.keys(values).some(key=>key.startsWith('VITE_') || key.startsWith('NODE_') && key!=='NODE_ENV')) throw new Error();
    return {...inherited,...values};
  } catch {
    throw new Error('Private environment could not be loaded: require an owned private file with valid application settings.');
  }
}
if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [mode,path='private-data/server.env',...extra]=process.argv.slice(2);
    if (!['dev','start'].includes(mode) || extra.length) throw new Error('Usage: private-env.mjs dev|start [env-file]');
    const env=privateEnvironment(path);
    if (mode==='start') env.NODE_ENV='production';
    const child=spawn(process.execPath,[mode==='dev'?'scripts/dev.mjs':'dist/packages/server/main.js'],{stdio:'inherit',env});
    child.on('error',()=>{console.error('Application process could not start.');process.exitCode=1;});
    child.on('exit',(code,signal)=>{process.exitCode=code??(signal?1:0);});
    for (const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>child.kill(signal));
  } catch(error) { console.error(error.message);process.exitCode=1; }
}
