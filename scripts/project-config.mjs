import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createInvitationPlan,normalizeInvitationTag,validateInvitationText} from './target-invitation-core.mjs';
import {kstDate} from './lv4-vvip-core.mjs';
export const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const localConfig=path.join(root,'.local/config.json');
const assert=(value,message)=>{if(!value)throw Error(message);};
export const readJson=async file=>JSON.parse((await fs.readFile(file,'utf8')).replace(/^\uFEFF/,''));
export async function writeJson(file,value){await fs.mkdir(path.dirname(file),{recursive:true});const tmp=file+'.tmp';await fs.writeFile(tmp,JSON.stringify(value,null,2)+'\n');await fs.rename(tmp,file);}
export function projectPath(relative){const resolved=path.resolve(root,relative);assert(resolved.startsWith(root+path.sep),'프로젝트 내부 상대 경로만 사용하세요.');return resolved;}
export function addDays(iso,days){assert(/^\d{4}-\d{2}-\d{2}$/.test(iso),'시작일은 YYYY-MM-DD 형식입니다.');const date=new Date(iso+'T00:00:00Z');assert(Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===iso,'시작일이 유효하지 않습니다.');return new Date(date.getTime()+days*86400000).toISOString().slice(0,10);}
export function validateConfig(c){
 assert(c.schema_version===1,'지원하지 않는 설정 버전입니다.');
 assert(/^[a-z0-9][a-z0-9-]{1,79}$/.test(c.campaign_id),'campaign_id는 영문 소문자·숫자·하이픈으로 지정하세요.');
 assert(/^\d+$/.test(c.shop_id)&&/^\d+$/.test(c.template_id),'shop_id와 template_id가 필요합니다.');
 assert(c.shop_name==='CELDYQUE'&&c.shop_region==='US'&&c.shop_id==='8651858975596646872','이 프로젝트는 CELDYQUE US 계정용입니다.');
 assert(Number.isInteger(c.duration_days)&&c.duration_days>=1&&c.duration_days<=90,'기간은 1~90일입니다.');
 assert(addDays(c.start_date,c.duration_days)===c.valid_until_iso,'시작일·기간·만료일이 서로 일치하지 않습니다.');
 assert(typeof c.invitation_name==='string'&&c.invitation_name.trim().length>=1&&c.invitation_name.length<=30,'초대 이름은 1~30자입니다.');
 validateInvitationText(c.invitation_text);
 assert(typeof c.share_to_im==='boolean'&&typeof c.allow_partial_recipients==='boolean','메시지·부분 선택 여부는 boolean입니다.');
 assert(typeof c.message_text==='string'&&c.message_text.trim().length>=1&&c.message_text.length<=500,'메시지는 1~500자입니다.');
 assert([3,4].includes(c.minimum_creator_level)&&c.tag_family===`lv${c.minimum_creator_level}up`,'대상은 Lv3 이상 또는 Lv4 이상 태그여야 합니다.');
 const first=normalizeInvitationTag(c.from),last=normalizeInvitationTag(c.to);
 assert(first.prefix===c.tag_family&&last.prefix===c.tag_family&&first.number<=last.number,'태그 범위가 레벨 설정과 다릅니다.');
 projectPath(c.tag_snapshot);
 assert(Array.isArray(c.products)&&c.products.length>=1&&c.products.length<=20,'상품은 1~20개입니다.');
 assert(new Set(c.products.map(p=>p.id)).size===c.products.length,'상품 ID가 중복됩니다.');
 for(const p of c.products){assert(/^\d+$/.test(p.id)&&typeof p.name==='string'&&p.name.trim(),'상품 ID와 정확한 상품명이 필요합니다.');for(const key of ['standard_commission_rate','shop_ads_commission_rate'])assert(Number.isFinite(p[key])&&p[key]>=1&&p[key]<=80,'상품 커미션은 1~80%입니다.');}
 assert(c.sample_policy==='PRODUCT_LEVEL','기존 상품별 샘플 설정을 유지해야 합니다.');
 return c;
}
export async function loadConfig(){let c;try{c=await readJson(localConfig);}catch(e){if(e.code!=='ENOENT')throw e;c=await readJson(path.join(root,'config.example.json'));}return validateConfig(c);}
export async function initConfig(){try{await fs.access(localConfig);}catch(e){if(e.code!=='ENOENT')throw e;await fs.mkdir(path.dirname(localConfig),{recursive:true});await fs.copyFile(path.join(root,'config.example.json'),localConfig,fs.constants.COPYFILE_EXCL);}return loadConfig();}
export const configHash=c=>crypto.createHash('sha256').update(JSON.stringify(c)).digest('hex');
export const campaignFolder=c=>path.join(root,'.local/campaigns',c.campaign_id);
export const checkpointPath=c=>path.join(campaignFolder(c),'current.json');
export async function history(){return readJson(path.join(root,'data/completed-campaigns.json'));}
export function assertNotCompleted(c,records){assert(!records.some(r=>r.campaign_id===c.campaign_id),'이미 완료한 캠페인입니다. 이 설정을 다른 PC에서 다시 발송하지 않습니다. 새 발송 요청에 맞춰 campaign_id·날짜·범위를 먼저 정하세요.');}
export function buildProjectPlan(c,tags,{now=new Date()}={}){
 validateConfig(c);assert(tags.min_level===c.minimum_creator_level&&tags.max_level==null,'태그 스냅샷의 최소 레벨이 다릅니다.');
 const [y,m,d]=c.valid_until_iso.split('-');
 const state=createInvitationPlan({tagState:tags,from:c.from,to:c.to,invitationName:c.invitation_name,validUntil:`${m}/${d}/${y}`,templateId:c.template_id,shopId:c.shop_id,shopRegion:c.shop_region,shareToIm:c.share_to_im,messageText:c.message_text,invitationText:c.invitation_text,now});
 Object.assign(state.config,{campaign_key:c.campaign_id,project_config_hash:configHash(c),start_date:c.start_date,duration_days:c.duration_days,minimum_creator_level:c.minimum_creator_level,products:structuredClone(c.products),commission_rate:c.products[0].standard_commission_rate,shop_ads_commission_rate:c.products[0].shop_ads_commission_rate,sample_policy:c.sample_policy,fail_fast:false,require_full_creator_selection:!c.allow_partial_recipients,require_full_message_selection:!c.allow_partial_recipients,invitation_prepare_retry_limit:2,continue_after_unconfirmed_invite:false,continue_after_uncertain_without_retry:true,unconfirmed_invite_retry_limit:0,message_dialog_reload_retries:2,reinvite_on_message_prepare_failure:false,message_reinvite_limit:0,resume_verified_message_without_reinvite:true,defer_existing_message_failures:true,message_poll_ms:1000,message_stabilize_ms:2000,manual_start_only:true});
 return state;
}
export function assertFreshStart(c,state,now=new Date()){assert(c.valid_until_iso>=kstDate(now),'만료된 캠페인은 발송할 수 없습니다.');if(!state.tags.some(t=>t.send_clicked_at))assert(c.start_date===kstDate(now),'새 발송 시작일이 오늘 KST와 다릅니다. 설정을 먼저 수정하세요.');}
export function formatSettings(c,records=[]){
 return [`캠페인: ${c.campaign_id}${records.some(r=>r.campaign_id===c.campaign_id)?' [이미 발송 완료 — 재발송 금지]':''}`,`계정: ${c.shop_name} ${c.shop_region} / ${c.shop_id}`,`초대 이름: ${c.invitation_name}`,`기간: ${c.start_date} → ${c.valid_until_iso} (${c.duration_days}일)`,`대상: Lv${c.minimum_creator_level} 이상 / ${c.from}~${c.to} / 태그당 최대 50명`,`개인 메시지 공유: ${c.share_to_im?'포함':'제외'} / 부분 선택: ${c.allow_partial_recipients?'허용':'전원 선택 필요'}`,`샘플: 기존 상품별 설정 유지`,...c.products.map(p=>`상품: ${p.label||p.name}\n  ID ${p.id}\n  ${p.name}\n  Standard ${p.standard_commission_rate}% / Shop Ads 활성화 ${p.shop_ads_commission_rate}%`),'\n초대장 본문:\n'+c.invitation_text,'\n초대 후 개인 메시지:\n'+c.message_text,'\n수정할 설정이 있으면 말씀해 주세요. 시작·설정 확인만으로 발송하지 않습니다.'].join('\n');
}
