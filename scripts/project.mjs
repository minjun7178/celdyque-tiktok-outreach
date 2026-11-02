#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import {fileURLToPath} from 'node:url';
import {doctor} from './doctor.mjs';
import {root,readJson,writeJson,loadConfig,initConfig,projectPath,configHash,campaignFolder,checkpointPath,history,assertNotCompleted,buildProjectPlan,assertFreshStart,formatSettings} from './project-config.mjs';
import {kstDate} from './lv4-vvip-core.mjs';
export async function main(args=process.argv.slice(2)){
 const [command='start',...flags]=args;
 if(!['start','doctor','show','login','plan','preflight','run','status'].includes(command)||flags.length)throw Error('지원 명령: start, doctor, show, login, plan, preflight, run, status');
 if(command==='doctor'){const result=await doctor();console.log(JSON.stringify(result,null,2));if(!result.ok)process.exitCode=1;return result;}
 const c=command==='start'?await initConfig():await loadConfig();
 if(command==='start'||command==='show'){
  if(command==='start'){const result=await doctor();console.log(JSON.stringify(result,null,2));if(!result.ok){console.log('Windows: powershell -ExecutionPolicy Bypass -File .\\setup.ps1');process.exitCode=1;}}
  console.log(formatSettings(c,await history()));if(command==='start')console.log('\n설치 확인 → npm run login (사용자가 로그인·인증) → npm run config → 수정 요청 확인 → 별도 발송 요청 후 plan/preflight/send');return;
 }
 const cp=checkpointPath(c),folder=campaignFolder(c);
 if(command==='status'){try{const s=await readJson(cp);console.log(JSON.stringify({campaign_id:c.campaign_id,status:s.status,counts:s.counts,tags:s.tags.map(t=>({tag:t.tag_name,status:t.status,invited:t.selected_count,delivered:t.message_delivered_count,restricted:t.message_restricted_count,unverified:t.message_unverified_count}))},null,2));}catch(e){if(e.code!=='ENOENT')throw e;console.log(JSON.stringify({campaign_id:c.campaign_id,status:'NO_LOCAL_CHECKPOINT',completed_history:(await history()).filter(r=>r.campaign_id===c.campaign_id)},null,2));}return;}
 if(command==='plan'){
  assertNotCompleted(c,await history());const state=buildProjectPlan(c,await readJson(projectPath(c.tag_snapshot)));assertFreshStart(c,state);
  try{await fs.access(cp);throw Error('기존 체크포인트를 덮어쓰지 않습니다. status를 확인하거나 새 campaign_id를 지정하세요.');}catch(e){if(e.code!=='ENOENT')throw e;}
  await writeJson(cp,state);console.log(JSON.stringify({status:'PLAN_READY',checkpoint:cp,tags:state.tags.length,creators:state.tags.reduce((n,t)=>n+t.expected_count,0),send_clicks:0,share_clicks:0},null,2));return;
 }
 if(command==='run'){
  assertNotCompleted(c,await history());const state=await readJson(cp);assertFreshStart(c,state);
  if(state.config.project_config_hash!==configHash(c))throw Error('설정이 계획 이후 바뀌었습니다. 새 campaign_id로 계획·검증을 준비하세요.');
  const proof=await readJson(path.join(folder,'preflight.json'));if(proof.config_hash!==configHash(c)||proof.date_kst!==kstDate()||proof.status!=='PASS')throw Error('오늘의 현재 설정으로 preflight를 통과해야 합니다.');
  const {main:run}=await import('./target-invitation-runner.mjs');await run(['run','--tag-family',c.tag_family,'--checkpoint',cp,'--evidence-dir',path.join(folder,'evidence'),'--apply']);return;
 }
 const {launchProfile}=await import('./browser-profile.mjs');const context=await launchProfile();const page=context.pages()[0]||await context.newPage();page.setDefaultTimeout(30000);
 try{
  if(command==='login'){
   await page.goto('https://seller-global-us.tiktok.com/homepage',{waitUntil:'domcontentloaded'});console.log('열린 Chrome에서 CELDYQUE US 로그인·OTP·CAPTCHA를 직접 완료하세요.');
   const rl=readline.createInterface({input:process.stdin,output:process.stdout});try{await rl.question('로그인을 완료한 뒤 Enter: ');}finally{rl.close();}
   await page.getByText(c.shop_name,{exact:true}).first().waitFor({state:'visible',timeout:60000});
   const url=new URL('https://affiliate-global.tiktok.com/affiliate/collaboration/target-invitation');url.searchParams.set('shop_id',c.shop_id);url.searchParams.set('shop_region',c.shop_region);await page.goto(url.toString(),{waitUntil:'domcontentloaded'});
   if(/login|passport|session_expire/i.test(page.url()))throw Error('로그인 세션을 확인하지 못했습니다.');await page.getByText('Target collaboration',{exact:true}).first().waitFor({state:'visible',timeout:60000});
   console.log('CELDYQUE US 로그인과 Target Collaboration 접근 확인 완료.\n'+formatSettings(c,await history()));return;
  }
  const state=buildProjectPlan(c,await readJson(projectPath(c.tag_snapshot)));const evidence=path.join(folder,'preflight-'+Date.now());await fs.mkdir(evidence,{recursive:true});
  await page.addInitScript(()=>{window.__blockedWrites=0;document.addEventListener('click',event=>{const button=event.target.closest('button');if(button&&/^(?:Send|Share|Save draft)$/.test(button.innerText.trim())){event.preventDefault();event.stopImmediatePropagation();window.__blockedWrites++;}},true);});
  try{
   const {waitInvitationEditorReady,applyInvitationText,selectDate,configureInvitationOffer,verifyInvitationFields}=await import('./target-invitation-runner.mjs');
   await page.goto('https://seller-global-us.tiktok.com/homepage',{waitUntil:'domcontentloaded'});await page.getByText(c.shop_name,{exact:true}).first().waitFor({state:'visible',timeout:60000});
   await page.goto(state.config.duplicate_url,{waitUntil:'domcontentloaded'});await page.getByText('Create invitation',{exact:true}).first().waitFor({state:'visible',timeout:60000});if(new URL(page.url()).searchParams.get('shop_id')!==c.shop_id)throw Error('OFFER_MISMATCH: Shop ID가 다릅니다.');
   await waitInvitationEditorReady(page,state.config);await page.getByPlaceholder('Invitation name').fill(c.invitation_name);await applyInvitationText(page,c.invitation_text);await selectDate(page,state.config.valid_until);const offer=await configureInvitationOffer(page,state.config);await verifyInvitationFields(page,state.config);
   if(await page.evaluate(()=>window.__blockedWrites))throw Error('발송 버튼 접근이 차단됐습니다.');
   const proof={status:'PASS',date_kst:kstDate(),observed_at:new Date().toISOString(),config_hash:configHash(c),offer,send_clicks:0,share_clicks:0};await writeJson(path.join(folder,'preflight.json'),proof);await writeJson(path.join(evidence,'proof.json'),proof);await page.screenshot({path:path.join(evidence,'offer.png'),fullPage:true});console.log(JSON.stringify(proof,null,2));
  }catch(error){await fs.writeFile(path.join(evidence,'error.txt'),String(error.stack||error));await page.screenshot({path:path.join(evidence,'error.png'),fullPage:true}).catch(()=>{});throw error;}
 }finally{await context.close();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){main().catch(error=>{console.error(error.message);process.exitCode=1;});}
