import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_INVITATION_SHARE_MESSAGE,
  buildDuplicateInvitationUrl,
  classifyMessageOutcomes,
  createInvitationPlan,
  estimateBatchDuration,
  estimateMessagePipelineDuration,
  invitationPreparationRetryDecision,
  invitationConfirmation,
  messageReinviteDecision,
  messageVerificationTarget,
  parseCreatorCount,
  parseCreatorSelectionProgress,
  parseUsDate,
  recoverInterruptedStates,
  refreshPlanSummary,
  summarizeCreatorPageSelection,
  upgradeInvitationCheckpoint,
  validateSelectableCreatorCount,
  validateInvitationText,
  verifyInvitationText,
} from '../scripts/target-invitation-core.mjs';
import { parseOptions, selectDate, isFatalError, applyInvitationText, configureInvitationOffer, waitForMessageCompletion,waitInvitationEditorReady,verifyInvitationFields,openMessageCreators,completeMessageSelection,waitForInvitationSendResult } from '../scripts/target-invitation-runner.mjs';
import { chromium } from 'playwright-core';
import {buildVvipPlan,VVIP_PRODUCTS,VVIP_INVITATION,VVIP_MESSAGE,kstDate} from '../scripts/lv4-vvip-core.mjs';
import {configureInvitationProducts,verifyInvitationProducts} from '../scripts/invitation-products.mjs';
import {validateRecipientSelection} from '../scripts/target-invitation-core.mjs';

test('post-Send product overlap is resolved in place and never repeats Send',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage();await page.setContent(`<button onclick="window.resends=(window.resends||0)+1">Send</button><div id="blocked"><h2>50 creators are already invited to collaborate</h2><button onclick="blocked.hidden=true;options.hidden=false">Resolve</button></div><div id="options" hidden><label><input type="radio" name="policy">Move creators to this invitation</label><button onclick="options.hidden=true;confirmation.hidden=false">Resolve</button></div><div id="confirmation" hidden>Move 50 creators to this invitation?<button onclick="confirmation.hidden=true;success.hidden=false">Move</button></div><div id="success" hidden>Collab invite sent!</div>`);
  const evidence=[];await waitForInvitationSendResult(page,{invite_success_timeout_ms:2000,products:[{},{}]},label=>evidence.push(label));assert.equal(evidence.length,1);assert.equal(await page.evaluate(()=>window.resends||0),0);
  await page.setContent(`<button onclick="window.resends=1">Send</button><div id="blocked"><h2>34 creators are already invited to collaborate</h2><button onclick="blocked.hidden=true;confirmation.hidden=false">Resolve</button></div><div id="confirmation" hidden>Move 34 creators to this invitation?<button onclick="confirmation.hidden=true;success.hidden=false">Move</button></div><div id="success" hidden>Collab invite sent!</div>`);await waitForInvitationSendResult(page,{invite_success_timeout_ms:2000,products:[{},{}]});assert.equal(await page.evaluate(()=>window.resends||0),0);
  await page.setContent('<button onclick="window.resends=1">Send</button>');await assert.rejects(waitForInvitationSendResult(page,{invite_success_timeout_ms:150}),/UNCONFIRMED/);assert.equal(await page.evaluate(()=>window.resends||0),0);
 }finally{await browser.close();}
});

test('VVIP offer uses Lv4-and-up tags, both exact products, approved copy and 35 KST calendar days',()=>{
 const tags={workflow:'LV4UP_TAGGING',status:'COMPLETE',shop_id:'8651858975596646872',min_level:4,max_level:null,tags:[{name:'lv4up1',count:50},{name:'lv4up2',count:36}]};
 const before=structuredClone(tags);const result=buildVvipPlan(tags,{startDate:'2026-11-02'});
 assert.equal(result.config.valid_until,'12/07/2026');assert.equal(result.config.invitation_text,VVIP_INVITATION);assert.equal(VVIP_INVITATION.length,487);assert.equal(result.config.message_text,VVIP_MESSAGE);
 assert.deepEqual(result.config.products.map(p=>[p.id,p.standard_commission_rate,p.shop_ads_commission_rate]),[['1731757173019480536',50,15],['1732507686646485464',50,15]]);
 assert.equal(result.config.require_full_message_selection,false);assert.equal(result.config.require_full_creator_selection,false);assert.equal(result.config.fail_fast,false);assert.equal(result.config.continue_after_unconfirmed_invite,false);assert.equal(result.config.continue_after_uncertain_without_retry,true);assert.deepEqual(tags,before);
 assert.equal(kstDate(new Date('2026-11-01T15:00:00Z')),'2026-11-02');assert.throws(()=>buildVvipPlan({...tags,min_level:3}));
});

test('strict message selection blocks 44/50 before Share while legacy partial selection is preserved',()=>{
 assert.equal(validateRecipientSelection(44,50),44);assert.throws(()=>validateRecipientSelection(44,50,{requireFull:true}),/MESSAGE_SELECTION_INCOMPLETE/);
 assert.equal(validateRecipientSelection(36,36,{requireFull:true}),36);assert.throws(()=>validateRecipientSelection(0,50));
});

test('a verified existing invitation can resume its message without repeating Send, but never after Share',()=>{
 const item={status:'MESSAGE_FAILED',invite_confirmation_status:'VERIFIED',message_resume_url:'https://affiliate-global.tiktok.com/existing-invitation'};
 const config={resume_verified_message_without_reinvite:true,reinvite_on_message_prepare_failure:false};
 assert.equal(messageReinviteDecision(item,config).action,'RESUME_EXISTING');
 assert.equal(messageReinviteDecision({...item,message_share_clicked_at:'already'},config).action,'SKIP_RESUME_UNAVAILABLE');
 assert.equal(messageReinviteDecision({...item,invite_confirmation_status:'UNCONFIRMED'},config).action,'SKIP_RESUME_UNAVAILABLE');
});

test('partial selection accepts 45/50 after one header click without toggling it back to zero',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{const page=await browser.newPage();await page.setContent(`<div role="dialog"><span id="count">0/50 creators selected</span><button role="checkbox" onclick="this.dataset.clicks=Number(this.dataset.clicks||0)+1;count.textContent=Number(this.dataset.clicks)%2?'45/50 creators selected':'0/50 creators selected'">Creators</button></div>`);const dialog=page.getByRole('dialog');const result=await completeMessageSelection(page,dialog,page.locator('#count'),50,true);assert.equal(result.selected,45);assert.equal(await page.getByRole('checkbox').getAttribute('data-clicks'),'1');await completeMessageSelection(page,dialog,page.locator('#count'),50,true);assert.equal(await page.getByRole('checkbox').getAttribute('data-clicks'),'1');}finally{await browser.close();}
});

test('existing invitation Share via chat opens messages without clicking invitation Send',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage();await page.setContent(`<table><tbody><tr><td>11.02<br>2 products<br>50 creators invited</td><td><button>View</button><button onclick="menu.hidden=false">More</button></td></tr></tbody></table><div id="menu" hidden><div onmouseover="chat.hidden=false">Share</div><button id="chat" hidden onclick="window.messageOpened=1">Share via chat</button></div><button onclick="window.invitationSent=1">Send</button>`);
  const chat={url:()=> 'https://affiliate-global.tiktok.com/seller/im?plan_id=verified',waitForLoadState:async()=>{}};
  const result=await openMessageCreators({pages:()=>[chat]},page,null,{existing_invitation_for_message:{name:'11.02',expected_count:50,product_count:2}});
  assert.equal(result,chat);assert.equal(await page.evaluate(()=>window.messageOpened),1);assert.equal(await page.evaluate(()=>window.invitationSent),undefined);
 }finally{await browser.close();}
});

test('editor waits for late template hydration and detects a later text or date overwrite',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage();await page.setContent(`<input placeholder="Invitation name"><input placeholder="End date"><textarea id="target_complete_details_message_input"></textarea><table><thead><tr><th>Standard commission rate</th></tr></thead><tbody></tbody></table><script>setTimeout(()=>{document.querySelector('tbody').innerHTML='<tr><td><input type="checkbox" value="1731757173019480536"></td></tr>';document.querySelector('textarea').value='Hydrated old template';document.querySelector('input').value=''},150)</script>`);
  const config={products:VVIP_PRODUCTS,invitation_name:'11.02 VVIP50',valid_until:'12/07/2026',invitation_text:VVIP_INVITATION};await waitInvitationEditorReady(page,config);
  await page.getByPlaceholder('Invitation name').fill(config.invitation_name);await page.getByPlaceholder('End date').fill(config.valid_until);await applyInvitationText(page,config.invitation_text);await verifyInvitationFields(page,config);
  await page.getByPlaceholder('End date').fill('12/03/2026');await assert.rejects(verifyInvitationFields(page,config),/만료일/);
 }finally{await browser.close();}
});

function vvipProductRow(product,{adsOn=false}={}){
 return `<tr><td><input type="checkbox" value="${product.id}">${product.name}</td><td><input placeholder="1.00-80.00" value="30.00"></td><td><button role="switch" aria-checked="${adsOn}" onclick="this.setAttribute('aria-checked',this.getAttribute('aria-checked')!=='true'?'true':'false');this.closest('tr').querySelector('.ads').hidden=this.getAttribute('aria-checked')!=='true'">Shop Ads</button></td><td><input class="ads" placeholder="1.00-80.00" value="25" ${adsOn?'':'hidden'}></td></tr>`;
}

test('two-product offer adds the missing exact Copper ID, sets both 50/15 and rejects later tampering',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage();const [volufiline,copper]=VVIP_PRODUCTS;
  await page.setContent(`<table id="products"><thead><tr><th>Product</th><th>Standard commission rate</th><th>Shop Ads commission</th><th>Shop Ads commission rate</th></tr></thead><tbody>${vvipProductRow(volufiline)}</tbody></table><button onclick="picker.hidden=false">Add products</button><div id="picker" role="dialog" hidden><h2>Add from shop</h2><table><tbody><tr><td>${copper.name}<input type="checkbox" value="${copper.id}" onchange="counter.textContent='1/100 products selected'"></td></tr></tbody></table><span id="counter">0/100 products selected</span><button id="add-product">Add</button></div>`);
  await page.locator('#add-product').evaluate((button,markup)=>{button.onclick=()=>{document.querySelector('#products tbody').insertAdjacentHTML('beforeend',markup);document.querySelector('#picker').hidden=true;};},vvipProductRow(copper,{adsOn:true}));
  const proof=await configureInvitationProducts(page,VVIP_PRODUCTS);assert.equal(proof.products.length,2);assert.deepEqual(proof.products.map(p=>[p.standard_commission_rate,p.shop_ads_commission_rate,p.shop_ads_enabled]),[[50,15,true],[50,15,true]]);
  await page.getByPlaceholder('1.00-80.00').last().fill('20');await assert.rejects(verifyInvitationProducts(page,VVIP_PRODUCTS),/OFFER_MISMATCH/);
 }finally{await browser.close();}
});

test('an extra unapproved product fails before any commission input is changed',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{const page=await browser.newPage();await page.setContent(`<table><thead><tr><th>Standard commission rate</th></tr></thead><tbody>${VVIP_PRODUCTS.map(p=>vvipProductRow(p)).join('')}${vvipProductRow({...VVIP_PRODUCTS[0],id:'9999999999999999999'})}</tbody></table>`);await assert.rejects(configureInvitationProducts(page,VVIP_PRODUCTS),/승인하지 않은 상품/);assert.equal(await page.getByPlaceholder('1.00-80.00').first().inputValue(),'30.00');}finally{await browser.close();}
});

const tagState = {
  status: 'FINALIZED',
  tags: Array.from({ length: 365 }, (_, index) => ({
    tag_name: `GEN${index + 1}`,
    actual_count: index === 364 ? 24 : 50,
  })),
};

test('message progress accumulates recipients when Chat replaces the visible conversation',async()=>{
 let reads=0;
 const chat={locator:()=>({innerText:async()=>{const handle=reads++===0?'creator_a':'creator_b';return `${handle}\nDear ${handle},\nhello`;}}),waitForTimeout:async ms=>new Promise(resolve=>setTimeout(resolve,ms))};
 const result=await waitForMessageCompletion(chat,['creator_a','creator_b'],2,{message_poll_ms:1,message_stabilize_ms:1,message_quiet_timeout_ms:50,message_total_timeout_ms:500,current_message_target:2});
 assert.equal(result.monitoring_status,'COMPLETE');assert.equal(result.delivered,2);assert.equal(result.unverified,0);
});

test('missing monitoring candidates never count as complete delivery for the full Share target',async()=>{
 const chat={locator:()=>({innerText:async()=>''}),waitForTimeout:async ms=>new Promise(resolve=>setTimeout(resolve,ms))};
 const result=await waitForMessageCompletion(chat,[],0,{message_poll_ms:1,message_stabilize_ms:1,message_quiet_timeout_ms:5,message_total_timeout_ms:100,current_message_target:2});
 assert.equal(result.monitoring_status,'QUIET_TIMEOUT_BEST_EFFORT');assert.equal(result.delivered,0);assert.equal(result.unverified,2);
});

test('fail-fast CLI enables immediate cancellation without changing legacy defaults',()=>{
 assert.equal(parseOptions(['run','--apply','--tag-family','lv4up','--fail-fast'])['--fail-fast'],true);
 assert.equal(parseOptions(['run','--apply'])['--fail-fast'],undefined);
});

test('fail-fast restriction takes precedence over an older matching message',()=>{
 const body="creator_one\nDear creator_one,\nPrevious message\nIt seems that you've sent too many messages to this creator consecutively.";
 assert.equal(classifyMessageOutcomes(body,['creator_one']).get('creator_one'),'DELIVERED');
 assert.equal(classifyMessageOutcomes(body,['creator_one'],DEFAULT_INVITATION_SHARE_MESSAGE,{restrictionFirst:true}).get('creator_one'),'RESTRICTED');
});

test('fail-fast stops on a visible limit even without identifiable monitoring recipients',async()=>{
 let reads=0;const chat={locator:()=>({innerText:async()=>{reads++;return "It seems that you've sent too many messages to this creator consecutively.";}}),waitForTimeout:async()=>{throw Error('Must stop before another poll');}};
 const result=await waitForMessageCompletion(chat,[],0,{fail_fast:true,current_message_target:2});
 assert.equal(reads,1);assert.equal(result.monitoring_status,'VISIBLE_RESTRICTION_STOP');assert.equal(result.unverified,2);assert.equal(result.restricted,0);
});

function plan(overrides = {}) {
  return createInvitationPlan({
    tagState,
    from: 'GEN3',
    to: 'GEN365',
    invitationName: '9.21',
    validUntil: '10/26/2026',
    templateId: '7687885932175591181',
    shopId: '8651858975596646872',
    now: new Date('2026-09-21T00:00:00Z'),
    ...overrides,
  });
}

const completedLv3up = {
  workflow: 'LV3UP_TAGGING', status: 'COMPLETE', shop_id: '8651858975596646872',
  tags: Array.from({ length: 86 }, (_, i) => ({ name: `lv3up${i + 1}`, count: i === 85 ? 9 : 50 })),
  empty_tags: ['lv3up87', 'lv3up88', 'lv3up89'],
};

test('Lv4 invitations use only the completed Lv4 checkpoint and separate default files',()=>{
 const tags={workflow:'LV4UP_TAGGING',status:'COMPLETE',shop_id:'8651858975596646872',tags:[{name:'lv4up1',count:50},{name:'lv4up2',count:7}]};
 const state=plan({tagState:tags,from:'lv4up1',to:'lv4up2'});
 assert.equal(state.tags.length,2);assert.equal(state.tags[1].expected_count,7);
 const opt=parseOptions(['run','--tag-family','lv4up','--apply']);
 assert.match(opt.checkpoint,/target-invitations-lv4up[\\/]current.json$/);
 assert.match(opt.tagState,/lv4up-tagging[\\/]current.json$/);
 assert.throws(()=>plan({tagState:completedLv3up,from:'lv4up1',to:'lv4up2'}),/체크포인트/);
});

test('exact Lv4 invitations cannot use a Lv4-and-up or Lv3 checkpoint',()=>{
 const tags={workflow:'LV4ONLY_TAGGING',status:'COMPLETE',shop_id:'8651858975596646872',tags:[{name:'lv4only1',count:50}]};
 const state=plan({tagState:tags,from:'lv4only1',to:'lv4only1'});
 assert.equal(state.tags[0].tag_name,'lv4only1');
 const opt=parseOptions(['run','--tag-family','lv4only','--apply']);
 assert.match(opt.checkpoint,/target-invitations-lv4only[\\/]current.json$/);
 assert.match(opt.tagState,/lv4only-tagging[\\/]current.json$/);
 assert.throws(()=>plan({tagState:{...tags,workflow:'LV4UP_TAGGING'},from:'lv4only1',to:'lv4only1'}),/체크포인트/);
});

test('plans completed lv3up1-86 as 4259 creators without using empty tags or GEN memberships', () => {
  const before = structuredClone(completedLv3up);
  const state = plan({ tagState: completedLv3up, from: 'LV3UP1', to: 'lv3up86', shareToIm: true });
  assert.equal(state.tags.length, 86);
  assert.equal(state.tags.reduce((sum, tag) => sum + tag.expected_count, 0), 4259);
  assert.equal(state.tags[0].tag_name, 'lv3up1');
  assert.equal(state.tags.at(-1).tag_name, 'lv3up86');
  assert.equal(state.tags.at(-1).expected_count, 9);
  assert.equal(state.config.commission_rate, 30);
  assert.equal(state.config.shop_ads_commission_rate, 15);
  assert.equal(invitationConfirmation(state, state.tags), 'SEND INVITATIONS AND MESSAGES lv3up1-lv3up86 86');
  assert.deepEqual(completedLv3up, before);
  assert.throws(() => plan({ tagState: completedLv3up, from: 'lv3up1', to: 'lv3up87' }), /lv3up87/);
});

test('rejects mixed tag families, incomplete lv3up tagging, wrong shop and pending operations', () => {
  assert.throws(() => plan({ from: 'lv3up1', to: 'GEN86' }), /같은 태그/);
  assert.throws(() => plan({ from: 'VIP1', to: 'VIP6' }), /GEN1 또는 lv3up1/);
  const options = { from: 'lv3up1', to: 'lv3up86' };
  for (const override of [
    { status: 'RUNNING' }, { workflow: 'GEN_TAGGING' }, { shop_id: '123' },
    { pending_apply: { tag: 'lv3up86' } }, { pending_tag_creation: { name: 'lv3up87' } },
    { page_selection: { page: 366 } },
  ]) assert.throws(() => plan({ ...options, tagState: { ...completedLv3up, ...override } }));
});

test('lv3up CLI isolates source, invitation checkpoint and evidence from existing GEN runs', () => {
  const gen = parseOptions(['status']);
  for (const args of [['status', '--tag-family', 'lv3up'], ['run', '--tag-family', 'lv3up', '--apply']]) {
    const options = parseOptions(args);
    assert.match(options.checkpoint, /target-invitations-lv3up[\\/]current\.json$/);
    assert.match(options.tagState, /lv3up-tagging[\\/]current\.json$/);
    assert.match(options.evidenceDir, /target-invitations-lv3up[\\/]evidence$/);
    assert.notEqual(options.checkpoint, gen.checkpoint);
  }
  assert.throws(() => parseOptions(['status', '--tag-family', 'VIP']), /tag-family/);
});

test('calendar selects zero-padded 03 in the displayed target month and rejects disabled cells', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    for (const [initialMonth, disabled, moves] of [[10, false, 2], [12, false, 0], [12, true, 0]]) {
      await page.setContent(`<input placeholder="End date" readonly onclick="document.querySelector('.core-picker-container').style.display='block'">
        <div class="core-picker-container" style="display:none">
          <div class="core-picker-header-icon" onclick="navigate(-1)"><svg class="arco-icon-left"></svg></div>
          <div class="core-picker-header-value">${initialMonth}/2026</div>
          <div class="core-picker-header-icon" onclick="navigate(1)"><svg class="arco-icon-right"></svg></div>
          <div class="core-picker-cell" onclick="throw Error('Outside month clicked')"><div class="core-picker-date-value">03</div></div>
          <div class="core-picker-cell core-picker-cell-in-view ${disabled ? 'core-picker-cell-disabled' : ''}" onclick="selectDay()"><div class="core-picker-date-value">03</div></div>
        </div><script>
          var month=${initialMonth};window.navigationCount=0;
          function navigate(delta){month+=delta;window.navigationCount++;document.querySelector('.core-picker-header-value').textContent=month+'/2026';}
          function selectDay(){document.querySelector('input').value=String(month).padStart(2,'0')+'/03/2026';document.querySelector('.core-picker-container').style.display='none';}
        </script>`);
      if (disabled) await assert.rejects(selectDate(page, '12/03/2026'), /선택할 수 없습니다/);
      else {
        await selectDate(page, '12/03/2026');
        assert.equal(await page.getByPlaceholder('End date').inputValue(), '12/03/2026');
      }
      assert.equal(await page.evaluate(() => window.navigationCount), moves);
    }
  } finally { await browser.close(); }
});

test('a closed browser stops the run instead of failing every subsequent tag', () => {
  assert.equal(isFatalError(Error('page.goto: Target page, context or browser has been closed')), true);
  assert.equal(isFatalError(Error('AUTH_CHALLENGE: verification required')), true);
  assert.equal(isFatalError(Error('Creator tags result delayed')), false);
});

test('explicit invitation copy is preserved in plans and rejects over-limit text before sending', () => {
  const text = '30% Commission + Video Boosting!\nCELDYQUÉ 100% Volufiline';
  const state = plan({ invitationText: text });
  assert.equal(state.config.invitation_text, text);
  assert.equal(Object.hasOwn(plan().config, 'invitation_text'), false);
  assert.equal(validateInvitationText('x'.repeat(500)).length, 500);
  assert.throws(() => plan({ invitationText: 'x'.repeat(501) }), /1~500/);
  assert.throws(() => validateInvitationText('💙'.repeat(251)), /1~500/);
  assert.throws(() => validateInvitationText('   '), /1~500/);
});

test('invitation verification accepts only the observed emoji removal, never changed terms or truncation', () => {
  const expected = '💸 Earn 30% commission! 🚀\nVolufiline 💙';
  assert.deepEqual(verifyInvitationText(expected, expected), { text: expected, emoji_removed: false });
  const actual = ' Earn 30% commission! \nVolufiline ';
  assert.deepEqual(verifyInvitationText(expected, actual), { text: actual, emoji_removed: true });
  assert.throws(() => verifyInvitationText(expected, actual.replace('30%', '20%')), /확정 문구/);
  assert.throws(() => verifyInvitationText(expected, actual.slice(0, -4)), /확정 문구/);
  assert.throws(() => verifyInvitationText('💙', ''), /확정 문구/);
});

test('approved invitation copy overwrites only the invitation field and is never silently truncated', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<textarea id="target_complete_details_message_input" maxlength="500">Old copper peptide template</textarea><textarea id="other">Unchanged message</textarea>');
    await applyInvitationText(page, null);
    assert.equal(await page.locator('#target_complete_details_message_input').inputValue(), 'Old copper peptide template');
    const approved = '💸 30% Commission\nCELDYQUÉ 100% Volufiline';
    await applyInvitationText(page, approved);
    assert.equal(await page.locator('#target_complete_details_message_input').inputValue(), approved);
    assert.equal(await page.locator('#other').inputValue(), 'Unchanged message');
    await page.locator('#target_complete_details_message_input').evaluate(e => e.maxLength = 10);
    await assert.rejects(applyInvitationText(page, approved), /10자 한도/);
    assert.equal(await page.locator('#target_complete_details_message_input').inputValue(), approved);
  } finally { await browser.close(); }
});

test('offer preparation enables Shop Ads at 15%, preserves standard 30%, and keeps product-level samples', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<button onclick="document.querySelector('table').hidden=false">Choose products</button>
      <table hidden><tbody><tr><td>Volufiline 10ml x2</td><td><input placeholder="1.00-80.00" value="30.00"></td>
      <td><button role="switch" aria-checked="false" onclick="this.setAttribute('aria-checked', this.getAttribute('aria-checked') === 'true' ? 'false' : 'true'); document.querySelector('#ads-rate').hidden = this.getAttribute('aria-checked') !== 'true'">Shop Ads</button></td>
      <td><input id="ads-rate" hidden placeholder="1.00-80.00" value=""></td></tr></tbody></table>
      <button onclick="document.querySelector('#samples').hidden=false">Set up free samples</button>
      <div id="samples" hidden><label><input name="sample" type="radio" value="follow">Use product-level sample settings</label>
      <label><input name="sample" type="radio" value="auto">Approve everyone in this invitation</label></div>`);
    const config = { expected_product_name: 'Volufiline 10ml x2', commission_rate: 30, sample_policy: 'PRODUCT_LEVEL' };
    await configureInvitationOffer(page, config);
    assert.equal(await page.locator('input[value="follow"]').isChecked(), true);
    assert.equal(await page.locator('input[value="auto"]').isChecked(), false);
    assert.equal(await page.getByPlaceholder('1.00-80.00').first().inputValue(), '30.00');
    assert.equal(await page.getByRole('switch').getAttribute('aria-checked'), 'true');
    assert.equal(await page.locator('#ads-rate').inputValue(), '15');
    await page.locator('#ads-rate').fill('25');
    await configureInvitationOffer(page, config);
    assert.equal(await page.locator('input[value="follow"]').isChecked(), true);
    assert.equal(await page.getByRole('switch').getAttribute('aria-checked'), 'true');
    assert.equal(await page.locator('#ads-rate').inputValue(), '15');
    await page.getByRole('switch').click();
    await configureInvitationOffer(page, {});
    assert.equal(await page.getByRole('switch').getAttribute('aria-checked'), 'true');
    assert.equal(await page.locator('#ads-rate').inputValue(), '15');
    await page.getByPlaceholder('1.00-80.00').first().fill('20.00');
    await assert.rejects(configureInvitationOffer(page, config), /OFFER_MISMATCH/);
    assert.equal(await page.getByPlaceholder('1.00-80.00').first().inputValue(), '20.00');
    assert.equal(isFatalError(Error('OFFER_MISMATCH: commission differs')), true);
  } finally { await browser.close(); }
});

test('builds the fixed GEN3-GEN365 invitation plan without stale outreach ledger input', () => {
  const state = plan();
  assert.equal(state.tags.length, 363);
  assert.equal(state.tags[0].tag_name, 'GEN3');
  assert.equal(state.tags.at(-1).tag_name, 'GEN365');
  assert.equal(state.tags.at(-1).expected_count, 24);
  assert.equal(state.config.invitation_name, '9.21');
  assert.equal(state.config.valid_until, '10/26/2026');
  assert.equal(state.config.commission_rate, 30);
  assert.equal(state.config.shop_ads_commission_rate, 15);
  assert.equal(state.config.overlap_policy, 'MOVE_TO_THIS_INVITATION');
  assert.equal(state.config.share_to_im, false);
  assert.equal(invitationConfirmation(state, state.tags), 'SEND INVITATIONS GEN3-GEN365 363');
});

test('supports a bounded pilot without changing tag names or invitation name', () => {
  const state = plan({ maxTags: 2 });
  assert.deepEqual(state.tags.map(item => item.tag_name), ['GEN3', 'GEN4']);
  assert.equal(state.config.to, 'GEN4');
  assert.equal(invitationConfirmation(state, state.tags), 'SEND INVITATIONS GEN3-GEN4 2');
});

test('builds a message-enabled pipeline plan with a distinct confirmation and estimate', () => {
  const state = plan({ maxTags: 2, shareToIm: true });
  assert.equal(state.schema_version, 4);
  assert.equal(state.config.invitation_prepare_retry_limit, 2);
  assert.equal(state.config.overlap_resolution_timeout_ms, 5_000);
  assert.equal(state.config.share_to_im, true);
  assert.equal(state.config.message_text, DEFAULT_INVITATION_SHARE_MESSAGE);
  assert.equal(state.config.message_dialog_timeout_ms, 20_000);
  assert.equal(state.config.message_dialog_reload_retries, 2);
  assert.equal(state.config.reinvite_on_message_prepare_failure, true);
  assert.equal(state.config.message_reinvite_limit, 2);
  assert.equal(state.config.invite_success_timeout_ms, 15_000);
  assert.equal(state.config.continue_after_unconfirmed_invite, true);
  assert.equal(state.config.unconfirmed_invite_retry_limit, 2);
  assert.equal(invitationConfirmation(state, state.tags), 'SEND INVITATIONS AND MESSAGES GEN3-GEN4 2');
  assert.deepEqual(state.estimate, { min_seconds: 440, max_seconds: 660 });
});

test('invitation preparation retries a fresh form twice, then fails only that tag', () => {
  const config = { invitation_prepare_retry_limit: 2 };
  assert.deepEqual(invitationPreparationRetryDecision(0, config), {
    action: 'RETRY_FRESH_FORM', used: 0, next: 1, limit: 2,
  });
  assert.deepEqual(invitationPreparationRetryDecision(1, config), {
    action: 'RETRY_FRESH_FORM', used: 1, next: 2, limit: 2,
  });
  assert.deepEqual(invitationPreparationRetryDecision(2, config), {
    action: 'FAIL_TAG_AND_CONTINUE', used: 2, limit: 2,
  });
  assert.deepEqual(invitationPreparationRetryDecision(0, config, { fatal: true }), {
    action: 'STOP_FATAL', used: 0, limit: 2,
  });
});

test('message preparation recovery uses bounded fresh invitation retries', () => {
  const config = {
    reinvite_on_message_prepare_failure: true,
    message_reinvite_limit: 2,
  };
  assert.deepEqual(messageReinviteDecision({ status: 'MESSAGE_FAILED' }, config), {
    action: 'REINVITE', used: 0, next: 1, limit: 2,
  });
  assert.deepEqual(messageReinviteDecision({ status: 'MESSAGE_FAILED', message_reinvite_count: 1 }, config), {
    action: 'REINVITE', used: 1, next: 2, limit: 2,
  });
  assert.deepEqual(messageReinviteDecision({ status: 'FAILED', message_reinvite_count: 1 }, config), {
    action: 'REINVITE', used: 1, next: 2, limit: 2,
  });
  assert.deepEqual(messageReinviteDecision({ status: 'MESSAGE_FAILED', message_reinvite_count: 2 }, config), {
    action: 'SKIP', used: 2, limit: 2,
  });
  assert.deepEqual(messageReinviteDecision({ status: 'MESSAGE_SHARE_CLICKED' }, config), {
    action: 'NONE', used: 0, limit: 2,
  });
  assert.deepEqual(messageReinviteDecision({ status: 'MESSAGE_FAILED' }, {
    ...config,
    reinvite_on_message_prepare_failure: false,
  }), { action: 'SKIP_RESUME_UNAVAILABLE', used: 0, limit: 2 });
});

test('legacy GEN178 checkpoint is upgraded without changing completed or pending tags', () => {
  const state = plan({ from: 'GEN1', to: 'GEN365', shareToIm: true });
  state.schema_version = 2;
  for (const key of [
    'invitation_prepare_retry_limit',
    'overlap_resolution_timeout_ms',
    'message_dialog_timeout_ms',
    'message_dialog_reload_retries',
    'reinvite_on_message_prepare_failure',
    'message_reinvite_limit',
    'invite_success_timeout_ms',
    'continue_after_unconfirmed_invite',
    'unconfirmed_invite_retry_limit',
  ]) delete state.config[key];
  for (let index = 0; index < 177; index += 1) state.tags[index].status = 'SENT';
  state.tags[177].status = 'MESSAGE_FAILED';
  state.tags[177].success_url = 'https://affiliate-global.tiktok.com/affiliate/collaboration/target-invitation/create?stale=1';

  const upgraded = recoverInterruptedStates(upgradeInvitationCheckpoint(state));
  assert.equal(upgraded.schema_version, 4);
  assert.equal(upgraded.checkpoint_upgrade, 'INVITATION_PREP_RECOVERY_V2');
  assert.equal(upgraded.config.invitation_prepare_retry_limit, 2);
  assert.equal(upgraded.config.overlap_resolution_timeout_ms, 5_000);
  assert.equal(upgraded.config.reinvite_on_message_prepare_failure, true);
  assert.equal(upgraded.config.message_reinvite_limit, 2);
  assert.equal(upgraded.config.message_dialog_timeout_ms, 20_000);
  assert.equal(upgraded.config.message_dialog_reload_retries, 2);
  assert.equal(upgraded.counts.sent, 177);
  assert.equal(upgraded.counts.message_failed, 1);
  assert.equal(upgraded.counts.pending, 187);
  assert.equal(upgraded.tags[177].status, 'MESSAGE_FAILED');
  assert.deepEqual(messageReinviteDecision(upgraded.tags[177], upgraded.config), {
    action: 'REINVITE', used: 0, next: 1, limit: 2,
  });
});

test('checkpoint upgrade preserves explicit recovery opt-outs', () => {
  const state = plan({ maxTags: 1, shareToIm: true });
  state.config.reinvite_on_message_prepare_failure = false;
  state.config.continue_after_unconfirmed_invite = false;
  upgradeInvitationCheckpoint(state);
  assert.equal(state.config.reinvite_on_message_prepare_failure, false);
  assert.equal(state.config.continue_after_unconfirmed_invite, false);
});

test('legacy invite-only checkpoint gains preparation retries without changing tag progress', () => {
  const state = plan({ maxTags: 3 });
  state.schema_version = 3;
  delete state.config.invitation_prepare_retry_limit;
  delete state.config.overlap_resolution_timeout_ms;
  state.tags[0].status = 'SENT';
  state.tags[1].status = 'FAILED';

  const upgraded = recoverInterruptedStates(upgradeInvitationCheckpoint(state));
  assert.equal(upgraded.schema_version, 4);
  assert.equal(upgraded.config.invitation_prepare_retry_limit, 2);
  assert.equal(upgraded.config.overlap_resolution_timeout_ms, 5_000);
  assert.deepEqual(upgraded.tags.map(item => item.status), ['SENT', 'FAILED', 'PENDING']);
});

test('rejects missing GEN tags and invalid dates', () => {
  assert.throws(() => plan({ tagState: { tags: tagState.tags.filter(item => item.tag_name !== 'GEN10') } }), /GEN10/);
  assert.throws(() => parseUsDate('2026-10-26'), /MM\/DD\/YYYY/);
  assert.throws(() => parseUsDate('02/30/2026'), /존재하지/);
});

test('builds only the public duplicate UI URL and validates counts', () => {
  const url = new URL(buildDuplicateInvitationUrl({
    templateId: '7687885932175591181',
    shopId: '8651858975596646872',
    shopRegion: 'us',
  }));
  assert.equal(url.origin, 'https://affiliate-global.tiktok.com');
  assert.equal(url.searchParams.get('enter_method'), 'duplicate');
  assert.equal(url.searchParams.get('shop_region'), 'US');
  assert.equal(parseCreatorCount('50/50 creators selected', 'creators selected'), 50);
  assert.equal(parseCreatorCount('24 / 50 creators in total', 'creators in total'), 24);
  assert.deepEqual(parseCreatorSelectionProgress('49 / 49 creators selected'), { selected: 49, total: 49 });
  assert.deepEqual(parseCreatorSelectionProgress('48/48 creators selected'), { selected: 48, total: 48 });
  assert.deepEqual(parseCreatorSelectionProgress('0 / 49 creators selected'), { selected: 0, total: 49 });
  assert.throws(() => parseCreatorSelectionProgress('49 / 48 creators selected'), /범위를 벗어났습니다/);
  assert.equal(messageVerificationTarget(50, 50), 50);
  assert.equal(messageVerificationTarget(50, 51), 50);
  assert.equal(messageVerificationTarget(50, 49), 49);
  assert.equal(messageVerificationTarget(50, 55), 50);
  assert.equal(messageVerificationTarget(50, 20), 20);
  assert.equal(messageVerificationTarget(50, 0), 0);
  assert.equal(validateSelectableCreatorCount(48), 48);
  assert.throws(() => validateSelectableCreatorCount(0), /1~50/);
  assert.throws(() => validateSelectableCreatorCount(51), /1~50/);
});

test('page selection accepts unavailable visible creators but rejects no progress or a decrease', () => {
  assert.deepEqual(summarizeCreatorPageSelection(20, 39, 20), {
    before: 20,
    after: 39,
    visible: 20,
    gained: 19,
    unavailable: 1,
    progressed: true,
  });
  assert.deepEqual(summarizeCreatorPageSelection(39, 49, 11), {
    before: 39,
    after: 49,
    visible: 11,
    gained: 10,
    unavailable: 1,
    progressed: true,
  });
  assert.equal(summarizeCreatorPageSelection(39, 39, 11).progressed, false);
  assert.throws(() => summarizeCreatorPageSelection(39, 20, 20), /감소했습니다/);
});

test('checkpoint recovery queues unconfirmed sends for duplicate retry when allowed', () => {
  const state = plan({ maxTags: 4 });
  state.tags[0].status = 'PREPARING';
  state.tags[1].status = 'READY';
  state.tags[2].status = 'SEND_CLICKED';
  state.tags[3].status = 'SENT';
  recoverInterruptedStates(state);
  assert.deepEqual(state.tags.map(item => item.status), ['PENDING', 'PENDING', 'FAILED', 'SENT']);
  assert.equal(state.counts.pending, 2);
  assert.equal(state.counts.failed, 1);
  assert.equal(state.counts.sent, 1);
  assert.equal(state.tags[2].invite_confirmation_status, 'RETRY_PENDING');
});

test('checkpoint recovery preserves an in-progress message recovery budget', () => {
  const state = plan({ maxTags: 1, shareToIm: true });
  state.tags[0].status = 'PREPARING';
  state.tags[0].message_reinvite_count = 1;
  state.tags[0].message_recovery_active = true;
  recoverInterruptedStates(state);
  assert.equal(state.tags[0].status, 'PENDING');
  assert.equal(state.tags[0].message_reinvite_count, 1);
  assert.equal(state.tags[0].message_recovery_active, true);
});

test('checkpoint recovery preserves uncertain sends when duplicate retry is disabled', () => {
  const state = plan({ maxTags: 2 });
  state.config.continue_after_unconfirmed_invite = false;
  state.tags[0].status = 'SEND_CLICKED';
  state.tags[1].status = 'UNCERTAIN';
  recoverInterruptedStates(state);
  assert.deepEqual(state.tags.map(item => item.status), ['UNCERTAIN', 'UNCERTAIN']);
  assert.equal(state.counts.uncertain, 2);
});

test('checkpoint recovery preserves invitations and never retries a clicked message Share', () => {
  const state = plan({ maxTags: 4, shareToIm: true });
  state.tags[0].status = 'MESSAGE_PREPARING';
  state.tags[1].status = 'MESSAGE_SHARE_CLICKED';
  state.tags[2].status = 'INVITE_SENT';
  state.tags[3].status = 'MESSAGE_UNCERTAIN';
  state.tags[3].selected_count = 50;
  state.tags[3].note = 'MESSAGE_STALLED: 47/50 결과 후 20초 동안 변화가 없습니다.';
  recoverInterruptedStates(state);
  assert.deepEqual(state.tags.map(item => item.status), ['INVITE_SENT', 'SENT', 'INVITE_SENT', 'SENT']);
  assert.equal(state.counts.invite_sent, 2);
  assert.equal(state.counts.sent, 2);
  assert.equal(state.tags[3].message_verified_count, 47);
  assert.equal(state.tags[3].message_unverified_count, 3);
  assert.equal(state.status, 'RUNNING');
});

test('classifies delivered and explicit TikTok message-limit outcomes without storing handles', () => {
  const text = [
    'creator_one',
    '12:09 PM',
    'Dear creator_one,',
    'We would love to collaborate.',
    'creator_two',
    '12:09 PM',
    "It seems that you've sent too many messages to this creator consecutively.",
    'unrelated_creator',
    'Dear unrelated_creator,',
  ].join('\n');
  const outcomes = classifyMessageOutcomes(text, ['@creator_one', '@creator_two']);
  assert.deepEqual([...outcomes.entries()], [
    ['creator_one', 'DELIVERED'],
    ['creator_two', 'RESTRICTED'],
  ]);
});

test('classifies the configured friendly message even when the greeting is not creator-specific', () => {
  const text = [
    'creator_one',
    '12:09 PM',
    'Hi [First Name]! 💙 We love your content and think you’d be a great fit for Celdyque ✨',
    'We’d love to collaborate with you on our [Product Name], featuring [key benefit / selling point].',
    'creator_two',
    '12:10 PM',
    "It seems that you've sent too many messages to this creator consecutively.",
  ].join('\n');
  const outcomes = classifyMessageOutcomes(
    text,
    ['@creator_one', '@creator_two'],
    DEFAULT_INVITATION_SHARE_MESSAGE,
  );
  assert.deepEqual([...outcomes.entries()], [
    ['creator_one', 'DELIVERED'],
    ['creator_two', 'RESTRICTED'],
  ]);
});

test('summary and duration remain deterministic', () => {
  const state = plan({ maxTags: 2 });
  state.tags.forEach(item => { item.status = 'SENT'; });
  refreshPlanSummary(state);
  assert.equal(state.status, 'COMPLETE');
  assert.deepEqual(estimateBatchDuration(3), { min_seconds: 48, max_seconds: 78 });
  assert.deepEqual(estimateMessagePipelineDuration(3), { min_seconds: 660, max_seconds: 990 });
});
