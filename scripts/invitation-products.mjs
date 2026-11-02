const assert=(ok,message)=>{if(!ok)throw Error('OFFER_MISMATCH: '+message);};

function validateProducts(products){
 assert(Array.isArray(products)&&products.length>0,'상품 설정이 없습니다.');
 assert(products.every(p=>/^\d{19}$/.test(p.id)),'상품 ID가 올바르지 않습니다.');
 assert(new Set(products.map(p=>p.id)).size===products.length,'상품 ID가 중복됐습니다.');
 for(const product of products)for(const key of ['standard_commission_rate','shop_ads_commission_rate'])assert(Number.isFinite(product[key])&&product[key]>=1&&product[key]<=80,'커미션 범위를 확인하세요.');
}

async function productTable(page){
 let table=page.getByRole('table').filter({hasText:'Standard commission rate'}).filter({visible:true});
 if(!await table.count())await page.getByText('Choose products',{exact:true}).last().click();
 await table.waitFor({state:'visible'});assert(await table.count()===1,'상품 표가 명확하지 않습니다.');return table;
}

async function selectedIds(table){
 return table.locator('tbody tr').evaluateAll(rows=>rows.map(row=>row.querySelector('input[type="checkbox"][value]')?.value).filter(Boolean));
}

function verifyIdSet(ids,products,{allowMissing=false}={}){
 assert(new Set(ids).size===ids.length,'초대 상품 ID가 중복됐습니다.');
 assert(ids.every(id=>products.some(p=>p.id===id)),'승인하지 않은 상품이 초대장에 포함됐습니다.');
 if(!allowMissing)assert(ids.length===products.length&&products.every(p=>ids.includes(p.id)),'두 상품 ID가 모두 포함되지 않았습니다.');
}

export async function ensureInvitationProducts(page,products){
 validateProducts(products);const table=await productTable(page);const initial=await selectedIds(table);verifyIdSet(initial,products,{allowMissing:true});
 const missing=products.filter(p=>!initial.includes(p.id));
 if(missing.length){
  await page.getByRole('button',{name:'Add products',exact:true}).click();
  const picker=page.locator('[role="dialog"], [data-tid="m4b_drawer"], .core-modal, .arco-modal').filter({hasText:'Add from shop'}).filter({visible:true}).last();
  await picker.waitFor({state:'visible'});
  for(const product of missing){
   const box=picker.locator(`input[type="checkbox"][value="${product.id}"]`);await box.waitFor({state:'attached',timeout:60000});
   const row=box.locator('xpath=ancestor::tr[1]');assert((await row.innerText()).includes(product.name),'상품 ID와 상품명이 다릅니다: '+product.id);
   await box.evaluate(e=>{if(e.disabled)throw Error('OFFER_MISMATCH: 상품 선택 불가');if(!e.checked)e.click();});assert(await box.isChecked(),'상품 선택이 반영되지 않았습니다.');
  }
  const selected=await picker.getByText(/\d+\s*\/\s*100\s*products selected/i).innerText();
  assert(Number(selected.match(/\d+/)?.[0])===missing.length,'추가 상품 선택 인원이 다릅니다.');
  const add=picker.getByRole('button',{name:'Add',exact:true});assert(await add.isEnabled(),'상품 Add가 비활성입니다.');await add.click();await picker.waitFor({state:'hidden'});
  for(const product of products)await table.locator(`tbody input[type="checkbox"][value="${product.id}"]`).waitFor({state:'attached'});
 }
 verifyIdSet(await selectedIds(table),products);
 for(const product of products){const row=table.locator('tbody tr').filter({has:page.locator(`input[type="checkbox"][value="${product.id}"]`)});assert((await row.innerText()).includes(product.name),'상품 ID와 이름이 다릅니다: '+product.id);}
 return table;
}

export async function verifyInvitationProducts(page,products){
 validateProducts(products);const table=await productTable(page);verifyIdSet(await selectedIds(table),products);
 const result=[];
 for(const product of products){
  const row=table.locator('tbody tr').filter({has:page.locator(`input[type="checkbox"][value="${product.id}"]`)});assert(await row.count()===1,'상품 행이 명확하지 않습니다.');
  assert((await row.innerText()).includes(product.name),'상품 ID와 이름이 다릅니다: '+product.id);
  const rates=row.getByPlaceholder('1.00-80.00').filter({visible:true});assert(await rates.count()===2,'상품 커미션 입력칸이 두 개가 아닙니다.');
  const standard=Number(await rates.nth(0).inputValue()),ads=Number(await rates.nth(1).inputValue());
  const enabled=await row.getByRole('switch').getAttribute('aria-checked')==='true';
  assert(standard===product.standard_commission_rate&&ads===product.shop_ads_commission_rate&&enabled,`${product.id}: Standard ${standard}%, Shop Ads ${ads}%, enabled=${enabled}`);
  result.push({id:product.id,name:product.name,standard_commission_rate:standard,shop_ads_commission_rate:ads,shop_ads_enabled:enabled});
 }
 return {observed_at:new Date().toISOString(),products:result};
}

export async function configureInvitationProducts(page,products){
 const table=await ensureInvitationProducts(page,products);
 for(const product of products){
  const row=table.locator('tbody tr').filter({has:page.locator(`input[type="checkbox"][value="${product.id}"]`)});
  let rates=row.getByPlaceholder('1.00-80.00').filter({visible:true});await rates.first().fill(String(product.standard_commission_rate));await rates.first().press('Tab');
  const toggle=row.getByRole('switch');assert(await toggle.count()===1,'Shop Ads 스위치가 명확하지 않습니다.');if(await toggle.getAttribute('aria-checked')!=='true')await toggle.click();
  rates=row.getByPlaceholder('1.00-80.00').filter({visible:true});await rates.nth(1).fill(String(product.shop_ads_commission_rate));await rates.nth(1).press('Tab');
 }
 return verifyInvitationProducts(page,products);
}
