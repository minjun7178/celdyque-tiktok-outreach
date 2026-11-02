import assert from 'node:assert/strict';
import test from 'node:test';
import {parseLevel,parseRow,createState,classify,nextPart,pageCandidates,commitPending,verifyPending,audit,auditPrepared,planPrepared,finalize} from '../scripts/lv3up-core.mjs';
const row=(rowIndex,level=3,tags='GEN1 VIP1')=>parseRow({rowIndex,creatorText:'Lv.'+level+' · Gold',tagsText:tags,selectable:true});
const add=(state,rows)=>{const p=nextPart(rows,state);state.pending_apply={tag:p.name,before:p.before,row_indices:p.rows.map(r=>r.rowIndex)};commitPending(state);};

test('a missing batch-selection checkbox is an explicit mode error, never an unavailable creator',async()=>{
 const {chromium}=await import('playwright-core');const {readRows}=await import('../scripts/lv3up-tagging.mjs');
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{const page=await browser.newPage();await page.setContent('<table><thead><tr><th>Creator name</th><th>Tags</th><th>GMV</th></tr></thead><tbody><tr><td><span data-tid="m4b_tag">Lv.4</span></td><td>lv3up1</td><td>$0</td></tr></tbody></table>');
 await assert.rejects(readRows(page),/BATCH_MODE_LOST/);
 await page.locator('tbody td').first().evaluate(e=>e.insertAdjacentHTML('afterbegin','<input type="checkbox" disabled>'));
 const snapshot=await readRows(page);assert.equal(snapshot.rows[0].selectable,false);
 }finally{await browser.close();}
});

test('Lv3 union filter rejects unrelated or unapproved selected tags before membership writes',async()=>{
 const {validateLv3UnionOptions,validateSelectedSourceTags}=await import('../scripts/lv3-source-filter.mjs');
 assert.deepEqual(validateLv3UnionOptions(['All','lv3up3','lv3up2','lv3up1'],['lv3up1','lv3up2']),['lv3up3']);
 assert.throws(()=>validateLv3UnionOptions(['All','GEN1','lv3up1'],['lv3up1']),/non-Lv3/);
 assert.throws(()=>validateSelectedSourceTags(['All','GEN1','lv3up1'],['lv3up1']),/scope/);
 assert.doesNotThrow(()=>validateSelectedSourceTags(['lv3up2','lv3up1'],['lv3up1','lv3up2']));
});

test('Lv3 source union accepts the documented empty tags without deselecting the live search scope',async()=>{
 const {chromium}=await import('playwright-core');const {applyLv3TagUnion}=await import('../scripts/lv3-source-filter.mjs');
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{const page=await browser.newPage();await page.setContent(`<button disabled>Reset</button><div role="combobox" onclick="popup.hidden=false">Creator tags<input></div><ul id="popup" class="core-select-popup-inner" role="listbox" hidden><li role="option" onclick="document.querySelectorAll('[role=option]').forEach(e=>e.setAttribute('aria-selected','true'));document.querySelector('#tags').textContent='lv3up1'">All</li>${['lv3up3','lv3up2','lv3up1'].map(name=>'<li role="option" aria-selected="false">'+name+'</li>').join('')}</ul><div>Total rows: 100</div><table><thead><tr><th>Creator name</th><th>Tags</th><th>GMV</th></tr></thead><tbody><tr><td>Lv.4</td><td id="tags">-</td><td>$0</td></tr></tbody></table>`);
 await applyLv3TagUnion(page,['lv3up1','lv3up2'],['lv3up3']);
 assert.equal(await page.locator('[role=option][aria-selected=true]').count(),4);
 assert.equal(await page.locator('input').inputValue(),'');
 }finally{await browser.close();}
});

test('exact Lv4 excludes both lower and higher levels and cannot verify a Lv5 selection',async()=>{
 const core=await import('../scripts/lv3up-core.mjs?minLevel=4&maxLevel=4&fast=1');
 const state=core.createState('1');const result=core.classify([1,2,3,4,5,6].map((level,i)=>row(i,level,'lv3up1')),state);
 assert.deepEqual(result.selected.map(r=>r.level),[4]);assert.equal(state.workflow,'LV4ONLY_TAGGING');
 assert.equal(state.max_level,4);assert.equal(core.nextPart(result.selected,state).name,'lv4only1');
 state.pending_apply={tag:'lv4only1',before:0,row_indices:[0]};
 assert.equal(core.verifyPending([row(0,5,'lv4only1')],state),false);
 assert.equal(core.verifyPending([row(0,4,'lv4only1 lv3up1')],state),true);
});

test('exact Lv4 browser clicks only the Lv4 checkbox and never uses a mixed-level header',async()=>{
 const {chromium}=await import('playwright-core');
 const core=await import('../scripts/lv3up-core.mjs?minLevel=4&maxLevel=4&fast=1');
 const runner=await import('../scripts/lv3up-tagging.mjs?minLevel=4&maxLevel=4&fast=1');
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{const page=await browser.newPage();await page.setContent(`<span id="counter">0 creators selected</span><table><thead><tr><th>Creator name<input id="header" type="checkbox" onclick="this.dataset.used='yes'"></th><th>Tags</th><th>GMV</th></tr></thead><tbody>${[1,2,3,4,5,6].map(level=>'<tr><td><input type="checkbox"><span data-tid="m4b_tag">Lv.'+level+'</span></td><td>lv3up1</td><td>$0</td></tr>').join('')}</tbody></table><script>document.addEventListener('change',()=>counter.textContent=document.querySelectorAll('tbody input:checked').length+' creators selected')</script>`);
 const snapshot=await runner.readRows(page);const state=core.createState('1');
 await runner.selectPart(page,snapshot,core.nextPart(core.classify(snapshot.rows,state).selected,state));
 assert.deepEqual(await page.locator('tbody input').evaluateAll(inputs=>inputs.map(x=>x.checked)),[false,false,false,true,false,false]);
 assert.equal(await page.locator('#header').getAttribute('data-used'),null);
 }finally{await browser.close();}
});

test('Lv4 cohort excludes levels 1, 2 and 3, ignores old Lv3 membership, and isolates tag numbering',async()=>{
 const core=await import('../scripts/lv3up-core.mjs?minLevel=4&fast=1');
 const state=core.createState('1');
 const result=core.classify([row(0,1),row(1,2),row(2,3),row(3,4,'lv3up8 GEN1'),row(4,5),row(5,6)],state);
 assert.deepEqual(result.selected.map(r=>r.level),[4,5,6]);
 assert.equal(state.workflow,'LV4UP_TAGGING');assert.equal(core.nextPart(result.selected,state).name,'lv4up1');
 assert.deepEqual(core.planPrepared(state,2),['lv4up1','lv4up2']);
 state.pending_apply={tag:'lv4up1',before:0,row_indices:[3]};
 assert.equal(core.verifyPending([row(3,3,'lv4up1')],state),false);
 assert.equal(core.verifyPending([row(3,4,'lv4up1 lv3up8')],state),true);
});

test('Lv4 browser selection never checks a Lv3 row even when its existing Lv3 tag is present',async()=>{
 const {chromium}=await import('playwright-core');
 const core=await import('../scripts/lv3up-core.mjs?minLevel=4&fast=1');
 const runner=await import('../scripts/lv3up-tagging.mjs?minLevel=4&fast=1');
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{const page=await browser.newPage();await page.setContent(`<span id="counter">0 creators selected</span><table><thead><tr><th>Creator name</th><th>Tags</th><th>GMV</th></tr></thead><tbody>${[1,2,3,4,5].map(level=>'<tr><td><input type="checkbox"><span data-tid="m4b_tag">Lv.'+level+'</span></td><td>lv3up1</td><td>$0</td></tr>').join('')}</tbody></table><script>document.addEventListener('change',()=>counter.textContent=document.querySelectorAll('tbody input:checked').length+' creators selected')</script>`);
 const snapshot=await runner.readRows(page);const state=core.createState('1');
 await runner.selectPart(page,snapshot,core.nextPart(core.classify(snapshot.rows,state).selected,state));
 assert.deepEqual(await page.locator('tbody input').evaluateAll(inputs=>inputs.map(x=>x.checked)),[false,false,false,true,true]);
 }finally{await browser.close();}
});
test('checkpoint rename retries Windows read locks but preserves other failures',async()=>{
 const {renameCheckpoint}=await import('../scripts/lv3up-tagging.mjs');let calls=0;const waits=[];
 await renameCheckpoint('temp','current',{rename:async()=>{if(++calls<3)throw Object.assign(Error('locked'),{code:'EPERM'});},wait:async ms=>waits.push(ms)});
 assert.equal(calls,3);assert.deepEqual(waits,[50,100]);
 await assert.rejects(renameCheckpoint('temp','current',{rename:async()=>{throw Object.assign(Error('full'),{code:'ENOSPC'});},wait:async()=>assert.fail('Must not retry disk errors')}),/full/);
});
test('level badge parsing never infers a level from GMV or other numbers',()=>{assert.equal(parseLevel('Lv.3'),3);assert.equal(parseLevel('Lv.10'),10);assert.equal(parseLevel('GMV 300 / PPS 4.5'),null);assert.equal(parseLevel('Lv.2 Lv.3'),null);});
test('Lv.3+ selection requires no creator name or ID and includes GEN/VIP members',()=>{const r=classify([row(0,0),row(1,2),row(2,3),row(3,4)],createState('1'));assert.deepEqual(r.selected.map(r=>r.rowIndex),[2,3]);assert.equal(r.counts.low_level,2);assert.deepEqual(Object.keys(row(0)).sort(),['level','rowIndex','selectable','tags']);});
test('pagewise additions fill the same tag to 50 and begin the next tag',()=>{const s=createState('1');add(s,Array.from({length:7},(_,i)=>row(i)));assert.equal(nextPart([row(0)],s).name,'lv3up1');add(s,Array.from({length:43},(_,i)=>row(i)));assert.equal(nextPart([row(0)],s).name,'lv3up2');add(s,[row(0)]);assert.deepEqual(audit(s),{tags:2,creators:51});});
test('visible lv3up tags prevent reselection; multiple tags and foreign namespace stop',()=>{const s=createState('1');add(s,[row(0)]);assert.equal(classify([row(0,3,'lv3up1')],s).selected.length,0);assert.throws(()=>classify([row(0,3,'lv3up2')],s),/not owned/);assert.throws(()=>classify([row(0,3,'lv3up1 lv3up2')],s),/multiple/);assert.throws(()=>classify([row(0,2,'lv3up1')],s),/badge/);});
test('pending Add only commits after every selected row visibly has the tag',()=>{const s=createState('1');s.pending_apply={tag:'lv3up1',before:0,row_indices:[0,2]};assert.equal(verifyPending([row(0,3,'lv3up1'),row(2)],s),false);assert.equal(verifyPending([row(0,3,'lv3up1'),row(2,3,'lv3up1')],s),true);assert.throws(()=>audit(s),/Uncertain/);commitPending(s);assert.equal(audit(s).creators,2);});
test('unknown badges and disabled eligible rows are counted explicitly',()=>{const r=classify([{...row(0),level:null},{...row(1),selectable:false}],createState('1'));assert.equal(r.counts.unknown_level,1);assert.equal(r.counts.unavailable,1);assert.equal(r.selected.length,0);});
test('filling a tag does not drop page candidates when remaining boxes become temporarily disabled',()=>{
 const s=createState('1');const initial=pageCandidates([row(0),row(1),{...row(2),selectable:false}],s);
 assert.deepEqual(initial.indices,[0,1]);s.tags=[{name:'lv3up1',count:50}];
 const after=[row(0,3,'lv3up1'),{...row(1),selectable:false},{...row(2),selectable:false}];
 assert.deepEqual(pageCandidates(after,s,initial.indices).remaining.map(r=>r.rowIndex),[1]);
 assert.throws(()=>pageCandidates([after[0],row(1,2),after[2]],s,initial.indices),/lost its/);
});
test('final output retains only tag counts, removing legacy member hashes',()=>{const s=createState('1');add(s,[row(0)]);s.tags[0].identity_hashes=['old-hash'];assert.deepEqual(finalize(s),{tags:1,creators:1});assert.equal(s.tags[0].identity_hashes,undefined);});
test('25-tag buffer starts after assigned and already prepared names, without adding creator counts',()=>{
 const s=createState('1');s.tags=Array.from({length:14},(_,i)=>({name:'lv3up'+(i+1),count:i===13?15:50}));
 const names=planPrepared(s);assert.equal(names[0],'lv3up15');assert.equal(names.at(-1),'lv3up39');
 s.empty_tags=names;s.prepared_tags=Object.fromEntries(names.map(name=>[name,{status:'EMPTY',verified_at:'2026-10-28T00:00:00Z'}]));
 assert.deepEqual(auditPrepared(s),{prepared_empty_tags:25});assert.equal(audit(s).creators,665);assert.equal(planPrepared(s,1)[0],'lv3up40');
 delete s.prepared_tags.lv3up20;assert.throws(()=>auditPrepared(s),/proof/);
});
test('actual browser custom checkboxes select only eligible rows without name extraction',async()=>{
 const {chromium}=await import('playwright-core');const {readRows,selectPart}=await import('../scripts/lv3up-tagging.mjs');const browser=await chromium.launch({channel:'chrome',headless:true});
 try{const page=await browser.newPage();await page.setContent('<style>input{opacity:0;width:0;height:0;position:absolute}</style><span id="counter">0 creators selected</span><table><thead><tr><th>Creator name</th><th>Tags</th><th>GMV</th></tr></thead><tbody><tr><td><input type="checkbox">display...<span data-tid="m4b_tag">Lv.3 · Gold</span></td><td>GEN1 VIP1</td><td>$0</td></tr><tr><td><input type="checkbox">anything<span data-tid="m4b_tag">Lv.2 · Gold</span></td><td>-</td><td>$100</td></tr></tbody></table><script>document.addEventListener("change",()=>document.querySelector("#counter").textContent=document.querySelectorAll("tbody input:checked").length+(document.querySelectorAll("tbody input:checked").length===1?" creator selected":" creators selected"))</script>');const snapshot=await readRows(page),s=createState('1');assert.equal(JSON.stringify(snapshot.rows).includes('display'),false);await selectPart(page,snapshot,nextPart(classify(snapshot.rows,s).selected,s));assert.equal(await page.locator('tbody input:checked').count(),1);assert.equal(await page.locator('tbody tr').nth(1).getByRole('checkbox').isChecked(),false);}finally{await browser.close();}
});
test('pagination retries an ignored click and never advances twice after success',async()=>{
 const {chromium}=await import('playwright-core');
 const {advanceCreatorPage}=await import('../scripts/lv3up-tagging.mjs');
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage();
  await page.setContent('<span class="core-pagination-item-active">84</span><button aria-label="Next" onclick="this.dataset.clicks=Number(this.dataset.clicks||0)+1;if(Number(this.dataset.clicks)>=2)document.querySelector(\'.core-pagination-item-active\').textContent=85">Next</button>');
  await advanceCreatorPage(page,84,{waitMs:50});
  assert.equal(await page.getByRole('button',{name:'Next',exact:true}).getAttribute('data-clicks'),'2');
  await advanceCreatorPage(page,84,{waitMs:50});
  assert.equal(await page.getByRole('button',{name:'Next',exact:true}).getAttribute('data-clicks'),'2');
  await assert.rejects(advanceCreatorPage(page,82,{waitMs:50}),/Unexpected pagination/);
 }finally{await browser.close();}
});

test('select-all is used only when every enabled row belongs to the intended batch',async()=>{
 const {chromium}=await import('playwright-core');const {readRows,clearSelection,selectPart}=await import('../scripts/lv3up-tagging.mjs');const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage();await page.setContent(`<span id="counter">0 creators selected</span><table><thead><tr><th>Creator name<input id="header" type="checkbox" onclick="this.dataset.used='yes';document.querySelectorAll('tbody input:not(:disabled)').forEach(e=>e.checked=this.checked);update()"></th><th>Tags</th><th>GMV</th></tr></thead><tbody><tr><td><input type="checkbox" onchange="update()"><span data-tid="m4b_tag">Lv.3</span></td><td>-</td><td>$0</td></tr><tr><td><input type="checkbox" onchange="update()"><span data-tid="m4b_tag">Lv.4</span></td><td>GEN1</td><td>$0</td></tr><tr><td><input type="checkbox" disabled><span data-tid="m4b_tag">Lv.2</span></td><td>-</td><td>$0</td></tr></tbody></table><script>function update(){counter.textContent=document.querySelectorAll('tbody input:checked').length+' creators selected'}</script>`);
  const snapshot=await readRows(page),s=createState('1');await selectPart(page,snapshot,nextPart(classify(snapshot.rows,s).selected,s));
  assert.equal(await page.locator('#header').getAttribute('data-used'),'yes');assert.equal(await page.locator('tbody input:checked').count(),2);assert.equal(await page.locator('tbody input:disabled').isChecked(),false);
  await clearSelection(page);assert.equal(await page.locator('tbody input:checked').count(),0);assert.equal(await page.locator('#header').isChecked(),false);assert.equal(await page.locator('#counter').innerText(),'0 creators selected');
 }finally{await browser.close();}
});

test('partially selected rows clear with at most two header toggles',async()=>{
 const {chromium}=await import('playwright-core');const {clearSelection}=await import('../scripts/lv3up-tagging.mjs');const browser=await chromium.launch({channel:'chrome',headless:true});
 try{const page=await browser.newPage();await page.setContent(`<span id="counter">1 creator selected</span><table><thead><tr><th>Creator name<input id="header" type="checkbox" onclick="this.dataset.clicks=Number(this.dataset.clicks||0)+1;document.querySelectorAll('tbody input').forEach(e=>e.checked=this.checked);counter.textContent=document.querySelectorAll('tbody input:checked').length+' creators selected'"></th><th>Tags</th><th>GMV</th></tr></thead><tbody><tr><td><input type="checkbox" checked></td><td>-</td><td>$0</td></tr><tr><td><input type="checkbox"></td><td>-</td><td>$0</td></tr></tbody></table><script>header.indeterminate=true</script>`);await clearSelection(page);assert.equal(await page.locator('tbody input:checked').count(),0);assert.equal(await page.locator('#counter').innerText(),'0 creators selected');assert.equal(await page.locator('#header').getAttribute('data-clicks'),'2');}finally{await browser.close();}
});

test('dense Lv3 pages use the header then exclude already tagged rows before Add',async()=>{
 const {chromium}=await import('playwright-core');const {readRows,selectPart}=await import('../scripts/lv3up-tagging.mjs');const browser=await chromium.launch({channel:'chrome',headless:true});
 try{const page=await browser.newPage();await page.setContent(`<span id="counter">0 creators selected</span><table><thead><tr><th>Creator name<input id="header" type="checkbox" onclick="this.dataset.used='yes';document.querySelectorAll('tbody input').forEach(e=>e.checked=this.checked);update()"></th><th>Tags</th><th>GMV</th></tr></thead><tbody>${[0,1,2].map(i=>'<tr><td><input type="checkbox" onchange="update()"><span data-tid="m4b_tag">Lv.3</span></td><td>'+(i===2?'lv3up1':'-')+'</td><td>$0</td></tr>').join('')}</tbody></table><script>function update(){counter.textContent=document.querySelectorAll('tbody input:checked').length+' creators selected'}</script>`);const s=createState('1');s.tags=[{name:'lv3up1',count:50}];const snapshot=await readRows(page);await selectPart(page,snapshot,nextPart(classify(snapshot.rows,s).selected,s));assert.equal(await page.locator('#header').getAttribute('data-used'),'yes');assert.equal(await page.locator('tbody input:checked').count(),2);assert.equal(await page.locator('tbody tr').nth(2).getByRole('checkbox').isChecked(),false);}finally{await browser.close();}
});

test('dense mixed-level pages exclude ineligible rows before Add using fewer clicks',async()=>{
 const {chromium}=await import('playwright-core');const ui=await import('../scripts/lv3up-tagging.mjs?minLevel=4&fast=1');const core=await import('../scripts/lv3up-core.mjs?minLevel=4');
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage();await page.setContent(`<span id="counter">0 creators selected</span><table><thead><tr><th>Creator name<input id="header" type="checkbox" onclick="this.dataset.used='yes';document.querySelectorAll('tbody input').forEach(e=>e.checked=this.checked);update()"></th><th>Tags</th><th>GMV</th></tr></thead><tbody>${[4,5,6,2].map(level=>'<tr><td><input type="checkbox" onclick="window.rowClicks=(window.rowClicks||0)+1" onchange="update()"><span data-tid="m4b_tag">Lv.'+level+'</span></td><td>-</td><td>$0</td></tr>').join('')}</tbody></table><script>function update(){counter.textContent=document.querySelectorAll('tbody input:checked').length+' creators selected'}</script>`);
  const snapshot=await ui.readRows(page),state=core.createState('1');await ui.selectPart(page,snapshot,core.nextPart(core.classify(snapshot.rows,state).selected,state));
  assert.equal(await page.locator('#header').getAttribute('data-used'),'yes');assert.equal(await page.evaluate(()=>window.rowClicks),1);assert.equal(await page.locator('tbody input:checked').count(),3);assert.equal(await page.locator('tbody tr').last().getByRole('checkbox').isChecked(),false);
 }finally{await browser.close();}
});

test('new tag creation finishes before creator membership selection',async()=>{
 const {chromium}=await import('playwright-core');
 const {createEmptyTag}=await import('../scripts/lv3up-tagging.mjs');
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try {
  const page=await browser.newPage();
  await page.setContent(`<span id="counter">0 creators selected</span><button id="enter" style="display:none" onclick="counter.hidden=false;this.style.display='none'">Batch tag creators</button><button onclick="counter.hidden=true;enter.style.display='block'">Exit</button>
   <table><thead><tr><th>Creator name</th><th>Tags</th><th>GMV</th></tr></thead><tbody><tr><td><input type="checkbox"></td><td>GEN1</td><td>$0</td></tr></tbody></table>
   <div><span>Creator tags</span></div><span onclick="drawer.hidden=false">Manage tags</span>
   <div id="drawer" data-tid="m4b_drawer" hidden><h2>Manage tags</h2><span>GEN1</span><button onclick="draft.hidden=false">Create tag</button>
   <table><tbody><tr id="draft" hidden><td><input id="tagLabel_input"><button onclick="const t=document.createElement('span');t.textContent=tagLabel_input.value;drawer.append(t);draft.hidden=true"><svg class="alliance-icon-NewApprove"></svg></button><button>Cancel draft</button></td></tr></tbody></table>
   <span class="core-drawer-close-icon" onclick="drawer.hidden=true">Close</span></div>`);
  await createEmptyTag(page,'lv3up4');
  assert.equal(await page.locator('#drawer').getByText('lv3up4',{exact:true}).count(),1);
  assert.equal(await page.locator('#drawer').getByText('GEN1',{exact:true}).count(),1);
  assert.equal(await page.locator('tbody input[type="checkbox"]:checked').count(),0);
  assert.equal(await page.locator('#drawer').isVisible(),false);
  assert.equal(await page.locator('#counter').isVisible(),true);
 }finally{await browser.close();}
});

test('existing-tag UI applies once and returns to batch mode',async()=>{
 const {chromium}=await import('playwright-core');const {applyExistingTag}=await import('../scripts/lv3up-tagging.mjs');const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage();await page.setContent(`<span id="counter">1 creator selected</span><button id="enter" hidden onclick="this.hidden=true;counter.hidden=false;box.hidden=false;this.dataset.clicks=Number(this.dataset.clicks||0)+1">Batch tag creators</button><table><thead><tr><th>Creator name</th><th>Tags</th><th>GMV</th></tr></thead><tbody><tr><td><input id="box" type="checkbox"></td><td>-</td><td>$0</td></tr></tbody></table><button onclick="dialog.hidden=false">Batch add tags</button><div role="dialog" id="dialog" hidden><input id="tag_input_search_input" oninput="option.textContent=this.value"><span id="option" onclick="add.disabled=false"></span><button id="add" disabled onclick="this.dataset.applied=Number(this.dataset.applied||0)+1;dialog.hidden=true;setTimeout(()=>{counter.hidden=true;enter.hidden=false;box.hidden=true},150)">Add</button></div>`);
  await applyExistingTag(page,'lv3up10');assert.equal(await page.locator('#add').getAttribute('data-applied'),'1');assert.equal(await page.locator('#dialog').isVisible(),false);assert.equal(await page.locator('#option').textContent(),'lv3up10');
  assert.equal(await page.locator('#enter').getAttribute('data-clicks'),'1');assert.equal(await page.locator('#counter').isVisible(),true);assert.equal(await page.locator('#box').isVisible(),true);
 }finally{await browser.close();}
});

test('bulk tag creation uses one Manage tags visit and keeps empty tags outside creator counts',async()=>{
 const {chromium}=await import('playwright-core');const {createTagBuffer}=await import('../scripts/lv3up-tagging.mjs');const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage();await page.setContent(`<span id="counter">0 creators selected</span><button id="enter" style="display:none" onclick="counter.hidden=false;this.style.display='none'">Batch tag creators</button><button onclick="counter.hidden=true;enter.style.display='block'">Exit</button><table><thead><tr><th>Creator name</th><th>Tags</th><th>GMV</th></tr></thead><tbody><tr><td><input type="checkbox"></td><td>GEN1</td><td>$0</td></tr></tbody></table><div><span>Creator tags</span></div><span id="open" onclick="drawer.hidden=false;this.dataset.visits=Number(this.dataset.visits||0)+1">Manage tags</span><div id="drawer" data-tid="m4b_drawer" hidden><h2>Manage tags</h2><span>GEN1</span><button onclick="draft.hidden=false">Create tag</button><table><tbody><tr id="draft" hidden><td><input id="tagLabel_input"><button onclick="const t=document.createElement('span');t.textContent=tagLabel_input.value;drawer.append(t);draft.hidden=true"><svg class="alliance-icon-NewApprove"></svg></button></td></tr></tbody></table><span class="core-drawer-close-icon" onclick="drawer.hidden=true">Close</span></div>`);
  const s=createState('1');await createTagBuffer(page,s,2,{persist:async()=>{}});
  assert.equal(await page.locator('#open').getAttribute('data-visits'),'1');assert.deepEqual(s.empty_tags,['lv3up1','lv3up2']);assert.equal(audit(s).creators,0);assert.equal(auditPrepared(s).prepared_empty_tags,2);assert.equal(s.pending_tag_creation,null);assert.equal(await page.locator('tbody input[type="checkbox"]:checked').count(),0);
 }finally{await browser.close();}
});
