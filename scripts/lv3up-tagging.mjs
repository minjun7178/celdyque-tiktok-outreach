#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchProfile } from './browser-profile.mjs';
import { applyLv3TagUnion } from './lv3-source-filter.mjs';
import { visibleCreatorTable, setFiftyPerPage,
  activePageNumber } from './gen-tagging.mjs';
// Reused review sessions import this runner with a fresh query; reload the
// stateless selection contract with the same query as well.
const { MIN_LEVEL, MAX_LEVEL, eligibleLevel, TAG_PREFIX, TAG_PATTERN, parseRow, createState, classify, nextPart, pageCandidates, commitPending, verifyPending, audit, auditPrepared, planPrepared, digest, finalize } =
  await import(new URL('./lv3up-core.mjs'+new URL(import.meta.url).search,import.meta.url));

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const folder = path.join(root, '.local', `${TAG_PREFIX}-tagging`);
const fastMode = new URL(import.meta.url).searchParams.get('fast') === '1';
const lv3SourceUnion = new URL(import.meta.url).searchParams.get('source') === 'lv3tags';
const stateFile = path.join(folder, 'current.json');
const shopId = '8651858975596646872';
const sourceUrl = `https://affiliate-global.tiktok.com/affiliate/assets/creator-management?shop_id=${shopId}&shop_region=US`;
const timeout = 30_000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (condition, message) => { if (!condition) throw new Error(message); };

async function save(state) {
  state.updated_at = new Date().toISOString();
  const temp = `${stateFile}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(state, null, 2) + '\n');
  await renameCheckpoint(temp,stateFile);
}

async function renameCheckpoint(from,to,{rename=fs.rename,wait=sleep}={}){
  for(let attempt=0;attempt<8;attempt++){
    try{return await rename(from,to);}catch(error){
      if(!['EPERM','EACCES','EBUSY'].includes(error.code)||attempt===7)throw error;
      await wait(Math.min(50*2**attempt,500));
    }
  }
}

async function auth(page) {
  assert(!/account\/login|passport\/|session_expire/i.test(page.url()), 'AUTH_REQUIRED: Login expired');
  const challenge = page.getByText(/verify to continue|drag the puzzle|verification code|verify your identity/i).filter({ visible: true });
  assert(!(await challenge.count()), 'AUTH_REQUIRED: CAPTCHA or account verification');
}

async function readRows(page) {
  assert(!/account\/login|passport\/|session_expire/i.test(page.url()), 'AUTH_REQUIRED: Login expired');
  const table = page.getByRole('table').filter({hasText:'Creator name'}).filter({hasText:'GMV'}).filter({visible:true}).first();
  const capture = await table.evaluate(element => {
    if(/verify to continue|drag the puzzle|verification code|verify your identity/i.test(document.body.innerText))return {error:'AUTH_REQUIRED: CAPTCHA or account verification'};
    const headers = [...element.querySelectorAll('thead th, thead td, [role="columnheader"]')]
      .map(cell => cell.innerText.replace(/\s+/g, ' ').trim().toLowerCase());
    const creator = headers.findIndex(text => text.includes('creator name'));
    const tags = headers.findIndex(text => /^tags?$/.test(text));
    if (creator < 0 || tags < 0) return { error: `Unrecognized headers: ${headers.join('|')}` };
    const rows = [...element.querySelectorAll('tbody tr, [role="row"]')].filter(row => row.getClientRects().length);
    return { selectionControls:rows.filter(row=>row.querySelector('input[type="checkbox"], [role="checkbox"]')).length, rows: rows.map((row, index) => {
      const cells = [...row.querySelectorAll('td, [role="cell"]')].filter(cell => cell.closest('tr,[role="row"]') === row);
      if (!cells[creator] || !cells[tags]) return null;
      const box = row.querySelector('input[type="checkbox"], [role="checkbox"]');
      const badges=[...cells[creator].querySelectorAll('[data-tid="m4b_tag"]')];
      const levelBadge=badges.find(badge=>/\bLv\.?\s*\d+/i.test(badge.innerText));
      return { rowIndex: index, creatorText:levelBadge?.innerText || '', refreshText:cells[creator].innerText,
        tagsText: cells[tags].innerText,
        selectable: Boolean(box) && !box.disabled && box.getAttribute('aria-disabled') !== 'true'
          && !box.closest('[aria-disabled="true"]') };
    }).filter(Boolean) };
  });
  assert(!capture.error, capture.error);
  assert(capture.selectionControls>0, 'BATCH_MODE_LOST: creator row checkboxes are absent; restore batch mode before classification');
  assert(capture.rows?.length >= 1 && capture.rows.length <= 50, 'Creator table empty or page size exceeds 50');
  // Only a transient page fingerprint is used to wait for table refresh.
  // Creator names and IDs are neither extracted as identifiers nor saved.
  return { table, rows: capture.rows.map(parseRow),
    pageFingerprint:digest(capture.rows.map(row=>row.refreshText+'|'+row.tagsText).join('\n')) };
}

async function settled(page, previousFingerprint=null) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeout) {
    await enterBatchTagMode(page);
    let snapshot;
    try{snapshot=await readRows(page);}catch(error){if(!String(error.message).includes('BATCH_MODE_LOST'))throw error;await sleep(100);continue;}
    const current = snapshot.pageFingerprint+'|'+snapshot.rows.map(row=>Number(row.selectable)).join('');
    if (last === current && snapshot.pageFingerprint !== previousFingerprint) return snapshot;
    last = current;
    await sleep(100);
  }
  throw new Error('Creator table did not settle');
}

async function pagination(page) {
  const nav=await page.evaluate(()=>{
    const visible=e=>e.getClientRects().length;
    const next=[...document.querySelectorAll('[aria-label="Next"], [class*="pagination-item-next"]')].filter(visible).at(-1);
    const active=[...document.querySelectorAll('.arco-pagination-item-active, [class*="pagination-item-active"]')].filter(visible).at(-1);
    return next?{hasNext:!(/disabled/i.test(next.className)||next.getAttribute('aria-disabled')==='true'),number:Number(active?.textContent.trim()||1)}:null;
  });
  assert(nav,'Next control absent; cannot prove complete pagination');return nav;
}

async function enterBatchTagMode(page) {
  await page.evaluate(async timeout=>{
    const visible=e=>e&&e.isConnected&&e.getClientRects().length;
    let clicked=false;const until=Date.now()+timeout;
    while(Date.now()<until){
      const table=[...document.querySelectorAll('table')].find(t=>visible(t)&&t.innerText.includes('Creator name')&&t.innerText.includes('GMV'));
      if(/\d+\s+creators? selected/i.test(document.body.innerText)&&table?.querySelector('tbody input[type="checkbox"], tbody [role="checkbox"]'))return;
      const button=[...document.querySelectorAll('button')].find(e=>visible(e)&&e.innerText.trim()==='Batch tag creators');
      if(!clicked&&button&&!button.disabled){clicked=true;button.click();}
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    throw Error('BATCH_MODE_NOT_READY: row checkboxes did not become available');
  },timeout);
}

async function exitBatchTagMode(page) {
  await page.evaluate(()=>{
    if(!/\d+\s+creators? selected/i.test(document.body.innerText))return;
    const button=[...document.querySelectorAll('button')].find(e=>e.getClientRects().length&&e.innerText.trim()==='Exit');
    if(!button)throw Error('Batch Exit button absent');button.click();
  });
  await page.getByRole('button',{name:'Batch tag creators',exact:true}).filter({visible:true}).first().waitFor({state:'visible',timeout});
}

async function advanceCreatorPage(page,currentPage,{attempts=3,waitMs=10_000}={}) {
  // Poll the rendered pagination in the page, avoiding a protocol round trip
  // for every read. Never issue another Next click after a successful advance.
  for(let attempt=0;attempt<attempts;attempt++) {
    assert(!/account\/login|passport\/|session_expire/i.test(page.url()),'AUTH_REQUIRED: Login expired');
    const result=await page.evaluate(async({currentPage,waitMs})=>{
      const visible=e=>e.getClientRects().length;
      const number=()=>Number([...document.querySelectorAll('[class*="pagination-item-active"]')].filter(visible).at(-1)?.textContent.trim()||1);
      if(/verify to continue|drag the puzzle|verification code|verify your identity/i.test(document.body.innerText))return {error:'AUTH_REQUIRED: CAPTCHA or account verification'};
      let actual=number();if(actual===currentPage+1)return {advanced:true};
      if(actual!==currentPage)return {error:`Unexpected pagination: ${currentPage} -> ${actual}`};
      const next=[...document.querySelectorAll('[aria-label="Next"], [class*="pagination-item-next"]')].filter(visible).at(-1);
      if(!next||/disabled/i.test(next.className)||next.getAttribute('aria-disabled')==='true')return {error:'Next became disabled unexpectedly'};
      next.click();const start=Date.now();
      while(Date.now()-start<waitMs){actual=number();if(actual===currentPage+1)return {advanced:true};if(actual!==currentPage)return {error:`Unexpected pagination: ${currentPage} -> ${actual}`};await new Promise(r=>setTimeout(r,100));}
      return {advanced:false};
    },{currentPage,waitMs});
    assert(!result.error,result.error);if(result.advanced)return;
    console.warn(`Page ${currentPage}: Next click not yet applied, retry ${attempt+1}/${attempts}`);
  }
  throw new Error(`PAGE_NAVIGATION_STALLED: still on page ${currentPage} after ${attempts} attempts`);
}

async function clearSelection(page) {
  const table=page.getByRole('table').filter({hasText:'Creator name'}).filter({hasText:'GMV'}).filter({visible:true}).first();
  const remaining=await table.evaluate(element=>{
    const header=element.querySelector('thead input[type="checkbox"]');
    if(header&&!header.disabled&&element.querySelector('tbody input[type="checkbox"]:checked')){
      header.click();
      if(element.querySelector('tbody input[type="checkbox"]:checked'))element.querySelector('thead input[type="checkbox"]')?.click();
    }
    for(let i=0;i<50;i++){const checked=element.querySelector('tbody input[type="checkbox"]:checked');if(!checked)break;checked.click();}
    return element.querySelectorAll('tbody input[type="checkbox"]:checked').length;
  });
  assert(remaining===0,'Selection not cleared');
}

async function selectPart(page, snapshot, part) {
  await clearSelection(page);
  const latest = await settled(page);
  for (const selected of part.rows) {
    const row = latest.rows.find(row => row.rowIndex === selected.rowIndex);
    assert(row && eligibleLevel(row.level) && row.selectable, 'Creator changed before selection');
    assert(!row.tags.some(tag => TAG_PATTERN.test(tag)), 'Creator already has a cohort tag');
  }
  // Ordinary checkbox clicks are batched into one DOM round trip. The actual
  // selection counter below remains authoritative before any Add.
  await latest.table.evaluate((element,{indices,minLevel,maxLevel})=>{
    const rows=()=>[...element.querySelectorAll('tbody tr')];
    const enabled=rows().map((r,i)=>({i,box:r.querySelector('input[type="checkbox"]')})).filter(r=>r.box&&!r.box.disabled);
    const header=element.querySelector('thead input[type="checkbox"]');
    // For dense pages select all once, then exclude every non-target row.
    // The exact final index set and counter are verified before Add.
    if(header&&!header.disabled&&indices.length>enabled.length/2){
      header.click();
      for(const {i} of enabled){const box=rows()[i].querySelector('input[type="checkbox"]');if(!indices.includes(i)&&box.checked)box.click();}
    }else{
      for(const index of indices){const box=rows()[index]?.querySelector('input[type="checkbox"]');if(!box||box.disabled||box.checked)throw Error('Checkbox changed before selection');box.click();}
    }
    const actual=rows().map((r,i)=>r.querySelector('input[type="checkbox"]')?.checked?i:null).filter(i=>i!==null);
    if(actual.length!==indices.length||actual.some(i=>!indices.includes(i)))throw Error('Checked rows differ from the intended selection');
  },{indices:part.rows.map(row=>row.rowIndex),minLevel:MIN_LEVEL,maxLevel:Number.isFinite(MAX_LEVEL)?MAX_LEVEL:999});
  const selectedText = page.getByText(/\d+\s+creators? selected/i).filter({ visible: true }).first();
  await selectedText.waitFor({state:'visible',timeout:5000});
  const count = Number(/(\d+)\s+creators? selected/i.exec(await selectedText.innerText())?.[1]);
  assert(count === part.rows.length, `Selection counter mismatch: ${count}/${part.rows.length}`);
}

async function verifyAndCommit(page, state) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const snapshot = await settled(page);
    if (verifyPending(snapshot.rows, state)) {
      const tag = state.pending_apply.tag, added = state.pending_apply.row_indices.length;
      commitPending(state);
      state.empty_tags=(state.empty_tags||[]).filter(name=>name!==tag);
      if(state.prepared_tags?.[tag])state.prepared_tags[tag].status='ASSIGNED';
      audit(state);
      await save(state);
      await clearSelection(page);
      console.log(JSON.stringify({event:'TAG_VERIFIED', tag, added, count:state.tags.find(item=>item.name===tag).count}));
      if (!fastMode && state.tags.find(item=>item.name===tag).count === 50) {
        await page.screenshot({path:path.join(folder,`${tag}-verified.png`),fullPage:false})
          .catch(error=>console.warn(`Screenshot unavailable after verified ${tag}: ${error.message}`));
      }
      return;
    }
    await sleep(500);
  }
  throw new Error('UNCERTAIN_APPLY: Add may have succeeded; refusing automatic retry');
}

async function createEmptyTag(page,tagName) {
  // Create separately from membership selection. This avoids losing the row
  // selection when TikTok rerenders the new-tag option inside Batch add tags.
  await clearSelection(page);await exitBatchTagMode(page);
  await page.getByText('Creator tags',{exact:true}).filter({visible:true}).first().locator('xpath=..').evaluate(e=>e.click());
  await page.getByText('Manage tags',{exact:true}).filter({visible:true}).last().evaluate(e=>e.click());
  const drawer=page.locator('[data-tid="m4b_drawer"]').filter({visible:true}).last();
  await drawer.getByText('Manage tags',{exact:true}).waitFor({state:'visible',timeout});
  assert(!(await drawer.getByText(tagName,{exact:true}).count()),`${tagName} already exists outside this checkpoint`);
  await drawer.getByRole('button',{name:'Create tag',exact:true}).click();
  const input=drawer.locator('#tagLabel_input');await input.fill(tagName);
  const row=input.locator('xpath=ancestor::tr[1]');
  const confirm=row.getByRole('button').filter({has:page.locator('svg.alliance-icon-NewApprove')});
  assert(await confirm.count()===1,'New tag confirmation is ambiguous');
  await confirm.click();await input.waitFor({state:'hidden',timeout});
  await drawer.getByText(tagName,{exact:true}).waitFor({state:'visible',timeout});
  await drawer.locator('.core-drawer-close-icon').click();await drawer.waitFor({state:'hidden',timeout});
  await page.keyboard.press('Escape');await enterBatchTagMode(page);
}

async function createTagBuffer(page,state,count=25,{persist=save}={}){
  const names=planPrepared(state,count);
  await clearSelection(page);await exitBatchTagMode(page);
  await page.getByText('Creator tags',{exact:true}).filter({visible:true}).first().locator('xpath=..').evaluate(e=>e.click());
  await page.getByText('Manage tags',{exact:true}).filter({visible:true}).last().evaluate(e=>e.click());
  const drawer=page.locator('[data-tid="m4b_drawer"]').filter({visible:true}).last();
  await drawer.getByText('Manage tags',{exact:true}).waitFor({state:'visible',timeout});
  const observed=await drawer.evaluate((e,prefix)=>[...e.querySelectorAll('*')].map(x=>x.textContent.trim()).filter(t=>new RegExp('^'+prefix+'[1-9]\\d*$').test(t)),TAG_PREFIX);
  const owned=new Set([...state.tags.map(t=>t.name),...(state.empty_tags||[])]);
  assert(observed.every(name=>owned.has(name)),'Unowned lv3up tag in Manage tags; review before creating');
  assert(names.every(name=>!observed.includes(name)),'Prepared tag name collision');
  for(const name of names){
    state.pending_tag_creation=name;await persist(state);
    await drawer.getByRole('button',{name:'Create tag',exact:true}).evaluate(e=>e.click());
    await drawer.locator('#tagLabel_input').fill(name);
    await drawer.evaluate(async(element,{name,timeout})=>{
      const visible=e=>e&&e.isConnected&&e.getClientRects().length;
      const wait=async(test)=>{const until=Date.now()+timeout;while(Date.now()<until){if(test())return;await new Promise(r=>setTimeout(r,100));}throw Error('New tag confirmation timed out');};
      const input=element.querySelector('#tagLabel_input'),row=input?.closest('tr');
      const confirm=row?.querySelector('svg.alliance-icon-NewApprove')?.closest('button');
      if(!confirm||input.value!==name)throw Error('New tag form mismatch');
      await wait(()=>!confirm.disabled);confirm.click();
      await wait(()=>!visible(input)&&[...element.querySelectorAll('*')].some(e=>visible(e)&&e.textContent.trim()===name));
    },{name,timeout});
    state.empty_tags=[...(state.empty_tags||[]),name];state.prepared_tags||={};
    state.prepared_tags[name]={status:'EMPTY',verified_at:new Date().toISOString()};state.pending_tag_creation=null;
    await persist(state);console.log(JSON.stringify({event:'BUFFER_TAG_CREATED',tag:name,prepared_empty:state.empty_tags.length}));
  }
  state.precreation_batches=[...(state.precreation_batches||[]),{first:names[0],last:names.at(-1),count:names.length,verified_at:new Date().toISOString()}];
  await persist(state);await drawer.locator('.core-drawer-close-icon').evaluate(e=>e.click());
  await drawer.waitFor({state:'hidden',timeout});await page.keyboard.press('Escape');await enterBatchTagMode(page);
  return names;
}

async function applyExistingTag(page,tagName){
  await page.getByRole('button',{name:'Batch add tags',exact:true}).filter({visible:true}).last().evaluate(e=>e.click());
  await page.locator('#tag_input_search_input').filter({visible:true}).first().fill(tagName);
  await page.evaluate(async({tagName,timeout})=>{
    const visible=e=>e&&e.isConnected&&e.getClientRects().length;
    const wait=async(test,label)=>{const until=Date.now()+timeout;while(Date.now()<until){const value=test();if(value)return value;await new Promise(r=>setTimeout(r,100));}throw Error(label);};
    if(/verify to continue|drag the puzzle|verification code|verify your identity/i.test(document.body.innerText))throw Error('AUTH_REQUIRED');
    const input=[...document.querySelectorAll('#tag_input_search_input')].find(visible);
    const dialog=input?.closest('[role="dialog"], [data-tid="m4b_drawer"], .core-modal, .arco-modal');
    if(!dialog)throw Error('Tag dialog absent');
    const option=await wait(()=>[...dialog.querySelectorAll('*')].filter(e=>visible(e)&&e.textContent.trim()===tagName&&![...e.children].some(c=>c.textContent.trim()===tagName)).at(-1),'Exact tag option absent');
    option.click();
    let fallback=false;const selectedAt=Date.now();
    const add=await wait(()=>{
      const button=[...dialog.querySelectorAll('button')].find(e=>visible(e)&&e.innerText.trim()==='Add');
      if(button&&!button.disabled)return button;
      if(!fallback&&Date.now()-selectedAt>500){fallback=true;for(let e=option.parentElement;e&&e!==dialog;e=e.parentElement){const box=e.querySelector('input[type="checkbox"]');if(box){if(!box.checked&&!box.disabled)box.click();break;}}}
      return null;
    },'Tag Add did not enable');
    add.click();await wait(()=>!visible(dialog),'Tag Add result not confirmed');
  },{tagName,timeout});
  // Add closes the dialog before TikTok asynchronously exits selection mode.
  // Observe that transition before entering again; the old counter is stale.
  await page.getByRole('button',{name:'Batch tag creators',exact:true}).filter({visible:true}).first().waitFor({state:'visible',timeout});
  await enterBatchTagMode(page);
}

async function seekPage(page,target){
  const original=(await pagination(page)).number;
  const before=(await readRows(page)).pageFingerprint;
  if(original===target)return settled(page);
  await exitBatchTagMode(page);
  const result=await page.evaluate(async target=>{
    const visible=e=>e.getClientRects().length;
    const current=()=>Number([...document.querySelectorAll('[class*="pagination-item-active"]')].filter(visible).at(-1)?.textContent.trim()||1);
    const control=label=>[...document.querySelectorAll('[aria-label]')].find(e=>visible(e)&&e.getAttribute('aria-label')===label);
    for(let step=0;step<100;step++){
      const n=current();if(n===target)return n;
      const forward=target>n;const exact=control('Page '+target),jump=Math.abs(target-n)>=5?control(forward?'Go forward 5 pages':'Go back 5 pages'):null;
      const button=exact||jump||control(forward?'Next':'Previous');if(!button||/disabled/i.test(button.className))throw Error('Cannot seek requested page');button.click();
      const until=Date.now()+30000;while(current()===n&&Date.now()<until)await new Promise(r=>setTimeout(r,100));
      const after=current();if(after===n||(forward?after>target||after<n:after<target||after>n))throw Error('Unexpected seek pagination');
    }throw Error('Seek exceeded 100 steps');
  },target);
  assert(result===target,'Seek target mismatch');await enterBatchTagMode(page);return settled(page,before);
}

async function tagCurrentPage(page,state,{maxTags=null,snapshot=null,refreshPage=null}={}) {
  const number=(await pagination(page)).number;
  snapshot ||= await settled(page);
  let remembered=state.page_selection?.page===number?state.page_selection.eligible_indices:[];
  while(true){
    // Filling a 50-person tag can disable the other checkboxes temporarily.
    // Keep the positively eligible row positions until their next tag is ready.
    const targets=pageCandidates(snapshot.rows,state,remembered);remembered=targets.indices;
    state.page_selection={page:number,eligible_indices:remembered};
    if(!targets.remaining.length){state.page_selection=null;break;}
    const part=nextPart(targets.remaining,state);
    if(maxTags&&Number(part.name.replace(TAG_PREFIX,''))>maxTags)break;
    if(part.create&&!(state.empty_tags||[]).includes(part.name)){
      await createTagBuffer(page,state,maxTags?Math.min(25,maxTags-state.tags.length):25);
    }
    let live=await settled(page);
    if(part.rows.some(r=>!live.rows.find(x=>x.rowIndex===r.rowIndex)?.selectable)){
      if(state.fail_fast)throw Error('FAIL_FAST: creator selection availability changed before Add');
      // Re-entering the adjacent page clears TikTok's temporary selection cap.
      const nav=await pagination(page),neighbor=nav.hasNext?number+1:number-1;
      if(neighbor>0){await seekPage(page,neighbor);live=await seekPage(page,number);}
      else {assert(refreshPage,'No adjacent page to refresh the batch selection');live=await refreshPage();}
    }
    await selectPart(page,snapshot,part);
    state.pending_apply={tag:part.name,before:part.before,page:number,row_indices:part.rows.map(r=>r.rowIndex),prepared_at:new Date().toISOString()};await save(state);
    await applyExistingTag(page,part.name);await verifyAndCommit(page,state);
    snapshot=await settled(page);
  }
  await save(state);return snapshot;
}

function options(args) {
  const command = args.shift() || 'status';
  assert(['plan','run','status'].includes(command), 'Expected plan, run or status');
  const result = { command, apply:false, maxTags:null, maxPages:null };
  while (args.length) {
    const flag=args.shift();
    if(flag==='--apply') result.apply=true;
    else if(flag==='--auto-continue') result.autoContinue=true;
    else if(flag==='--max-tags' || flag==='--max-pages') {
      const count=Number(args.shift());assert(Number.isSafeInteger(count)&&count>0,'Invalid limit');
      result[flag==='--max-tags'?'maxTags':'maxPages']=count;
    } else throw new Error(`Unknown option: ${flag}`);
  }
  assert(command!=='run'||result.apply,'Actual tagging requires --apply');
  return result;
}

async function main(args, prepared = null) {
  const opt=options([...args]);
  await fs.mkdir(folder,{recursive:true});
  let state;
  try {state=JSON.parse(await fs.readFile(stateFile,'utf8'));}
  catch(error){if(error.code!=='ENOENT')throw error;state=createState(shopId);}
  assert(state.workflow===`${TAG_PREFIX.toUpperCase()}_TAGGING`&&state.shop_id===shopId,'Wrong checkpoint');
  if(opt.command==='status') {
    const summary={status:state.status,pilot_verified:state.pilot_verified,page:state.current_page,
      tags:state.tags.map(({name,count})=>({name,count})),pending:state.pending_apply,error:state.error};
    console.log(JSON.stringify(summary,null,2));return;
  }
  assert(!['COMPLETE','NEEDS_REVIEW'].includes(state.status),`Checkpoint is ${state.status}; do not replay blindly`);
  assert(opt.command!=='run'||opt.maxTags||state.pilot_verified,'Run a two-tag pilot before a full run');
  const lock=await fs.open(path.join(folder,'run.lock'),'wx');
  let context,page;
  try {
    context=prepared?.context || await launchProfile();page=prepared?.page || context.pages()[0]||await context.newPage();page.setDefaultTimeout(timeout);
    assert(!prepared || page.context()===context,'Prepared page belongs to a different browser');
    // Verify the selected Seller identity before any creator tag change.
    if(!prepared) {
      await page.goto('https://seller-global-us.tiktok.com/homepage',{waitUntil:'domcontentloaded'});
      await page.getByText('CELDYQUE',{exact:true}).first().waitFor({state:'visible',timeout});await auth(page);
      await page.goto(sourceUrl,{waitUntil:'domcontentloaded'});
    } else {
      assert(new URL(page.url()).pathname==='/affiliate/assets/creator-management','Prepared page is not Manage creators');
      assert(lv3SourceUnion||await activePageNumber(page)===state.current_page,'Prepared page differs from resume checkpoint');
    }
    await visibleCreatorTable(page,timeout);await auth(page);
    if(lv3SourceUnion){
      const source=JSON.parse(await fs.readFile(path.join(root,'.local','lv3up-tagging','current.json'),'utf8'));
      assert(source.status==='COMPLETE'&&source.shop_id===shopId,'Approved Lv3 source is not complete');
      await applyLv3TagUnion(page,source.tags.map(tag=>tag.name),source.empty_tags||[]);
    }
    await setFiftyPerPage(page);
    assert(new URL(page.url()).searchParams.get('shop_id')===shopId,'Wrong Affiliate shop ID');
    const filters=await page.locator('input[type="text"]').evaluateAll(elements=>elements.filter(e=>e.getClientRects().length).map(e=>e.value));
    assert(filters.every(value=>!value||/^(?:50\/Page|Please Select|Select)$/.test(value)), 'Nonempty creator search or filters');
    await enterBatchTagMode(page,timeout);
    const totalText=await page.getByText(/Total rows:\s*[\d,]+/).last().innerText();
    const total=Number(totalText.match(/[\d,]+/)[0].replaceAll(',',''));
    assert(total>0,'Missing creator total');
    if(state.total!=null&&state.total!==total){if(!fastMode)throw Error('Creator total changed; review coverage before continuing');state.total_change={before:state.total,after:total};}
    state.total=total;
    let snapshot=await settled(page);
    if(opt.command==='plan') {
      console.log(JSON.stringify({mode:'READ_ONLY',shop_id:shopId,total,rows:snapshot.rows.length,
        ...classify(snapshot.rows,state).counts,[TAG_PREFIX]:classify(snapshot.rows,state).selected.length,
        levels:snapshot.rows.slice(0,3).map(({level})=>level)},null,2));
      return;
    }
    state.status='RUNNING';state.error=null;await save(state);
    const prepareCount=opt.maxTags?Math.max(0,Math.min(25,opt.maxTags-state.tags.length)):25;
    if(!(state.empty_tags||[]).length&&prepareCount)await createTagBuffer(page,state,prepareCount);
    const startPage=Math.max(1,Number(state.current_page)||1);
    if(startPage>1 && (!prepared||lv3SourceUnion)) {
      await seekPage(page,startPage);
      assert(await activePageNumber(page)===startPage,'Resume navigation did not reach the checkpoint page');
      snapshot=await settled(page);
    }
    console.log(JSON.stringify({event:'RESUME',page:startPage,reused_browser:Boolean(prepared),previously_verified:state.tags.reduce((n,t)=>n+t.count,0)}));
    state.status='RUNNING';state.error=null;state.schema_version=2;await save(state);
    const pageKeys=new Set();let pages=startPage-1,sessionPages=0;
    let rowsReviewed=state.pages.slice(0,startPage-1).reduce((n,p)=>n+p.rows,0);
    while(true) {
      const pageStartedAt=Date.now();
      const nav=await pagination(page);
      assert(nav.number===pages+1,'Page number is not sequential');
      if(state.pending_apply && nav.number===state.pending_apply.page) {
        await verifyAndCommit(page,state);snapshot=await settled(page);
      }
      const rowCount=snapshot.rows.length;
      const key=snapshot.pageFingerprint;assert(!pageKeys.has(key),'Repeated page detected');pageKeys.add(key);
      rowsReviewed+=rowCount;
      if(fastMode&&!classify(snapshot.rows,state).selected.length&&!state.page_selection?.eligible_indices?.length){
        state.page_selection=null;
      }else snapshot=await tagCurrentPage(page,state,{maxTags:opt.maxTags,snapshot});
      if(opt.autoContinue&&opt.maxTags&&state.tags.filter(tag=>tag.count===50).length>=opt.maxTags){
        state.pilot_verified=true;opt.maxTags=null;await save(state);
        console.log(JSON.stringify({event:'PILOT_VERIFIED_CONTINUING',prefix:TAG_PREFIX}));
        snapshot=await tagCurrentPage(page,state,{snapshot});
      }
      pages++;sessionPages++;state.current_page=nav.number;
      const final=classify(snapshot.rows,state);
      state.pages[nav.number-1]={page:nav.number,rows:rowCount,checked_at:new Date().toISOString(),...final.counts};
      console.log(JSON.stringify({event:'PAGE_COMPLETE',page:nav.number,total_pages:Math.ceil(total/50),
        eligible_remaining:final.selected.length,page_elapsed_ms:Date.now()-pageStartedAt,...audit(state)}));await save(state);
      if(opt.maxTags && state.tags.filter(tag=>tag.count===50).length>=opt.maxTags){
        state.pilot_verified=true;state.status='PAUSED';await save(state);return;
      }
      if(opt.maxPages&&sessionPages>=opt.maxPages){state.status='PAUSED';await save(state);return;}
      try {await fs.access(path.join(folder,'pause.request'));await fs.unlink(path.join(folder,'pause.request'));state.status='PAUSED';await save(state);return;}catch(error){if(error.code!=='ENOENT')throw error;}
      if(!nav.hasNext){
        if(!fastMode)assert(rowsReviewed===total,`Reviewed row count differs: ${rowsReviewed}/${total}`);
        assert(!state.pending_apply,'Uncertain application remains');
        assert(!state.pending_tag_creation,'Uncertain tag creation remains');auditPrepared(state);
        const check=finalize(state);state.status='COMPLETE';state.pilot_verified=true;state.completed_at=new Date().toISOString();
        state.coverage={total,rows_reviewed:rowsReviewed,pages,
          row_count_delta:rowsReviewed-total,
          excluded_unknown_level:state.pages.reduce((n,p)=>n+(p.unknown_level||0),0),
          excluded_unavailable:state.pages.reduce((n,p)=>n+p.unavailable,0),
          unused_precreated_tags:[...(state.empty_tags||[])]};
        await save(state);console.log(JSON.stringify({event:'COMPLETE',...check,coverage:state.coverage}));return;
      }
      await clearSelection(page);
      // Plain Next preserves batch mode (verified against the live UI).
      // Only Add requires the explicit exit/restore transition above.
      if(!fastMode)await exitBatchTagMode(page,timeout);
      const previousFingerprint=snapshot.pageFingerprint;
      await advanceCreatorPage(page,nav.number,{attempts:state.fail_fast?1:3});
      await enterBatchTagMode(page,timeout);
      snapshot=await settled(page,previousFingerprint);
    }
  }catch(error){
    if(opt.command==='run') {state.status=(state.pending_apply||state.pending_tag_creation)?'NEEDS_REVIEW':state.fail_fast?'STOPPED_ON_ERROR':'PAUSED';state.error=String(error.stack||error);if(state.fail_fast)state.stopped_at=new Date().toISOString();await save(state);}
    if(page){
      const diagnostic=await page.locator('body').innerText().catch(()=>'');
      await fs.writeFile(path.join(folder,'last-error-controls.json'),JSON.stringify({url:page.url(),
        selected:diagnostic.match(/.{0,20}(?:selected|Batch add tags|Tag creators).{0,50}/gi),
        buttons:await page.getByRole('button').allTextContents().catch(()=>[])},null,2));
      await page.screenshot({path:path.join(folder,'last-error.png'),fullPage:true}).catch(()=>{});
    }
    throw error;
  }finally{if(!prepared)await context?.close();await lock.close();await fs.unlink(path.join(folder,'run.lock'));}
}

export { readRows, clearSelection, enterBatchTagMode, exitBatchTagMode, selectPart, advanceCreatorPage, createEmptyTag, createTagBuffer, applyExistingTag, tagCurrentPage, seekPage, settled, renameCheckpoint, main as runLv3up };

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
}
