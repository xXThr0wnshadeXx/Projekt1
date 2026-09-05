import { spawn } from 'node:child_process';

// One command owns both child processes. Fail together; never silently select a different frontend port.
if (process.env.VITE_AUTH_MODE && process.env.VITE_AUTH_MODE !== 'http') {
  console.error('This integrated run requires HTTP auth. Remove VITE_AUTH_MODE before starting.');
  process.exit(1);
}
const env={...process.env,VITE_AUTH_MODE:'http'};
const children=[spawn(process.execPath,['dist/packages/server/main.js'],{stdio:'inherit',env}),spawn(process.execPath,['node_modules/vite/bin/vite.js'],{stdio:'inherit',env})];
let closing=false;
function stop(code=0){if(closing)return;closing=true;for(const child of children)child.kill('SIGTERM');process.exitCode=code;}
for(const child of children){child.on('error',()=>stop(1));child.on('exit',code=>stop(code??1));}
process.on('SIGINT',()=>stop());process.on('SIGTERM',()=>stop());
