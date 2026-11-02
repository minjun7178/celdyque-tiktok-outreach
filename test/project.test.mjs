import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {root,readJson,validateConfig,buildProjectPlan,configHash,assertNotCompleted,assertFreshStart,addDays,projectPath,formatSettings} from '../scripts/project-config.mjs';
const config=await readJson(path.join(root,'config.example.json'));
const tags=await readJson(path.join(root,'data/lv4up-tags.json'));
const records=await readJson(path.join(root,'data/completed-campaigns.json'));
test('portable configuration preserves both product offers and exact approved date and copy',()=>{
 validateConfig(config);assert.equal(config.invitation_name,'11.02');assert.equal(config.valid_until_iso,'2026-12-07');assert.equal(config.invitation_text.length,487);assert.equal(config.message_text.length,239);
 assert.deepEqual(config.products.map(p=>[p.id,p.standard_commission_rate,p.shop_ads_commission_rate]),[['1731757173019480536',50,15],['1732507686646485464',50,15]]);
 const plan=buildProjectPlan(config,tags);assert.equal(plan.tags.length,41);assert.equal(plan.tags.reduce((n,t)=>n+t.expected_count,0),2036);assert.equal(plan.config.invitation_name,'11.02');assert.equal(plan.config.valid_until,'12/07/2026');assert.equal(plan.config.continue_after_unconfirmed_invite,false);assert.equal(plan.config.reinvite_on_message_prepare_failure,false);assert.equal(plan.config.require_full_message_selection,false);assert.equal(plan.config.project_config_hash,configHash(config));
 assert.notEqual(configHash({...config,invitation_name:'changed'}),configHash(config));
});
test('completed campaign cannot be replayed after a fresh clone and dates cannot silently roll forward',()=>{
 assert.throws(()=>assertNotCompleted(config,records),/이미 완료/);assert.doesNotThrow(()=>assertNotCompleted({...config,campaign_id:'another-explicit-campaign'},records));
 const plan=buildProjectPlan(config,tags);assert.doesNotThrow(()=>assertFreshStart(config,plan,new Date('2026-11-01T23:00:00Z')));assert.throws(()=>assertFreshStart(config,plan,new Date('2026-11-02T23:00:00Z')),/시작일/);
 plan.tags[0].send_clicked_at='2026-11-02T01:00:00Z';assert.doesNotThrow(()=>assertFreshStart(config,plan,new Date('2026-11-02T23:00:00Z')));assert.throws(()=>assertFreshStart(config,plan,new Date('2026-12-08T00:00:00Z')),/만료/);
});
test('configuration rejects wrong account, inconsistent dates, duplicate products and scope escape',()=>{
 assert.throws(()=>validateConfig({...config,shop_id:'123'}),/CELDYQUE/);assert.throws(()=>validateConfig({...config,valid_until_iso:'2026-12-08'}),/일치/);assert.throws(()=>validateConfig({...config,products:[config.products[0],config.products[0]]}),/중복/);assert.throws(()=>projectPath('../outside.json'),/내부/);assert.throws(()=>validateConfig({...config,campaign_id:'../outside'}),/campaign_id/);assert.equal(addDays('2026-12-01',35),'2027-01-05');assert.throws(()=>addDays('2026-02-30',35),/유효/);
});
test('startup settings contain the full editable invitation, message, percentages and completion status',()=>{
 const text=formatSettings(config,records);for(const value of ['11.02','2026-12-07','Standard 50%','Shop Ads 활성화 15%',config.invitation_text,config.message_text,'재발송 금지','수정할 설정'])assert.ok(text.includes(value));
});
test('a relocated fresh install rejects the completed campaign before requiring Playwright or opening a browser',async()=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'celdyque-outreach-test-'));
 try{
  await fs.cp(path.join(root,'scripts'),path.join(temp,'scripts'),{recursive:true});await fs.copyFile(path.join(root,'config.example.json'),path.join(temp,'config.example.json'));await fs.mkdir(path.join(temp,'data'));await fs.copyFile(path.join(root,'data/completed-campaigns.json'),path.join(temp,'data/completed-campaigns.json'));await fs.writeFile(path.join(temp,'package.json'),'{"type":"module"}');
  const result=spawnSync(process.execPath,['scripts/project.mjs','run'],{cwd:temp,encoding:'utf8'});assert.equal(result.status,1);assert.match(result.stderr,/이미 완료한 캠페인/);
 }finally{assert.equal(path.dirname(temp),path.resolve(os.tmpdir()));assert.ok(path.basename(temp).startsWith('celdyque-outreach-test-'));await fs.rm(temp,{recursive:true,force:true});}
});
