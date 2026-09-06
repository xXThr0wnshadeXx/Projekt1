import {defineConfig} from 'vite';
import {sites} from '@openai/sites-vite-plugin';
export default defineConfig({plugins:[sites()],build:{target:'es2022',lib:{entry:'server/worker.js',formats:['es'],fileName:()=> 'server/index.js'},outDir:'dist',emptyOutDir:true}});
