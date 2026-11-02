import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {root} from './project-config.mjs';
export async function findChrome(){
 const candidates=process.platform==='win32'?[path.join(process.env.PROGRAMFILES||'C:/Program Files','Google/Chrome/Application/chrome.exe'),path.join(process.env['PROGRAMFILES(X86)']||'C:/Program Files (x86)','Google/Chrome/Application/chrome.exe'),path.join(process.env.LOCALAPPDATA||os.homedir()+'/AppData/Local','Google/Chrome/Application/chrome.exe')]:process.platform==='darwin'?['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']:['/opt/google/chrome/chrome','/usr/bin/google-chrome'];
 for(const file of candidates){try{await fs.access(file);return file;}catch{}}
 return null;
}
export async function doctor(){
 const [major,minor]=process.versions.node.split('.').map(Number);const nodeOk=major>22||(major===22&&minor>=14);let dependency=null;
 try{dependency=JSON.parse(await fs.readFile(path.join(root,'node_modules/playwright-core/package.json'),'utf8')).version;}catch{}
 const chrome=await findChrome();return {ok:nodeOk&&dependency==='1.63.0'&&Boolean(chrome),platform:process.platform,node:process.versions.node,node_ok:nodeOk,playwright_core:dependency,chrome,stack:'Node.js 22.14+ / JavaScript ESM / Playwright Core 1.63.0 / Google Chrome / PowerShell (Windows installer)',missing:[...(!nodeOk?['Node.js 22.14 이상']:[]),...(dependency!=='1.63.0'?['npm ci']:[]),...(!chrome?['Google Chrome']:[])]};
}
