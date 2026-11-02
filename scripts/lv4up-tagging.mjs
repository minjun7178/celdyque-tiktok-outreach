#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const { runLv3up } = await import('./lv3up-tagging.mjs?minLevel=4&fast=1');
export const runLv4up = runLv3up;
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runLv4up(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
