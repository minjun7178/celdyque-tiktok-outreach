const assert=(condition,message)=>{if(!condition)throw Error(message);};
export function validateLv3UnionOptions(options,expected){
 const names=options.map(x=>x.trim()).filter(x=>x!=='All');
 assert(names.length>0&&names.every(x=>/^lv3up[1-9]\d*$/.test(x)),'Source search contains non-Lv3 tags');
 assert(expected.every(x=>names.includes(x)),'Some approved Lv3 source tags are missing');
 return names.filter(x=>!expected.includes(x));
}
export function validateSelectedSourceTags(selected,expected){
 const names=selected.map(x=>x.trim()).filter(x=>x!=='All');
 assert(names.length===expected.length&&names.every(x=>expected.includes(x)),'Selected source tag scope differs from the approved Lv3 cohort');
}
export async function applyLv3TagUnion(page,expected,emptyTags=[]){
 const reset=page.getByRole('button',{name:'Reset',exact:true});
 if(await reset.isEnabled())await reset.evaluate(e=>e.click());
 const control=page.getByRole('combobox').filter({hasText:'Creator tags'}).first();
 await control.click();await control.locator('input').last().fill('lv3up');
 const popup=page.locator('.core-select-popup-inner').filter({visible:true}).last();
 await popup.getByRole('option',{name:expected[0],exact:true}).waitFor({state:'attached'});
 const extras=validateLv3UnionOptions(await popup.getByRole('option').allTextContents(),expected);
 assert(extras.every(name=>emptyTags.includes(name)),'Unexpected extra source tag outside the prior Lv3 checkpoint');
 await popup.getByRole('option',{name:'All',exact:true}).click();
 const selectedScope=[...expected,...extras];
 const started=Date.now();
 while(true){
  const selected=await popup.locator('[role="option"][aria-selected="true"]').allTextContents();
  try{validateSelectedSourceTags(selected,selectedScope);break;}
  catch(error){if(Date.now()-started>5000)throw Error(error.message+'; selected='+JSON.stringify(selected));}
  await page.waitForTimeout(100);
 }
 await control.locator('input').last().fill('');await page.keyboard.press('Escape');
 await page.waitForFunction(names=>{
  const total=Number(document.body.innerText.match(/Total rows:\s*([\d,]+)/)?.[1]?.replaceAll(',','')||0);
  const table=[...document.querySelectorAll('table')].find(t=>t.innerText.includes('Creator name')&&t.innerText.includes('GMV'));
  const rows=[...(table?.querySelectorAll('tbody tr')||[])];
  return total>50&&rows.length>0&&rows.every(r=>r.querySelectorAll('td')[1]?.innerText.split(/[\s,|]+/).some(x=>names.includes(x)));
 },expected,{polling:100,timeout:30000});
 return {selected_source_tags:expected.length};
}
