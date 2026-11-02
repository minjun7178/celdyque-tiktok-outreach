import { createHash } from 'node:crypto';
export const MIN_LEVEL = Number(new URL(import.meta.url).searchParams.get('minLevel') || 3);
export const MAX_LEVEL = Number(new URL(import.meta.url).searchParams.get('maxLevel') || Infinity);
if (![3,4].includes(MIN_LEVEL)) throw new Error('Unsupported minimum creator level');
export const TAG_PREFIX = `lv${MIN_LEVEL}${MAX_LEVEL===MIN_LEVEL?'only':'up'}`;
export const eligibleLevel = level => level != null && level >= MIN_LEVEL && level <= MAX_LEVEL;
export const TAG_PATTERN = new RegExp(`^${TAG_PREFIX}([1-9]\\d*)$`);
export const digest = value => createHash('sha256').update(String(value)).digest('hex');
const assert=(condition,message)=>{if(!condition)throw new Error(message);};
export function parseLevel(text){const values=[...new Set([...String(text).matchAll(/\bLv\.?\s*(\d+)\b/gi)].map(m=>Number(m[1])))];return values.length===1?values[0]:null;}
export function parseRow(raw){return {rowIndex:raw.rowIndex,level:parseLevel(raw.creatorText),tags:[...new Set(String(raw.tagsText||'').split(/[\s,|]+/).filter(t=>t&&t!=='-'))],selectable:raw.selectable};}
export function createState(shopId){return {schema_version:2,workflow:`${TAG_PREFIX.toUpperCase()}_TAGGING`,min_level:MIN_LEVEL,max_level:Number.isFinite(MAX_LEVEL)?MAX_LEVEL:null,tag_prefix:TAG_PREFIX,shop_id:shopId,status:'PLANNED',created_at:new Date().toISOString(),tags:[],pages:[],pending_apply:null,pilot_verified:false};}
export function classify(rows,state){
 const selected=[],counts={low_level:0,covered:0,unavailable:0,unknown_level:0};const indexes=new Set();
 for(const row of rows){
  assert(!indexes.has(row.rowIndex),'Duplicate row index');indexes.add(row.rowIndex);
  const cohort=row.tags.filter(t=>TAG_PATTERN.test(t));assert(cohort.length<=1,'Creator has multiple lv3up tags; review required');
  if(cohort.length){assert(state.tags.some(t=>t.name===cohort[0]),'Visible cohort tag is not owned by this checkpoint');assert(eligibleLevel(row.level),'Tagged creator has no verified eligible level badge');counts.covered++;continue;}
  if(row.level==null){counts.unknown_level++;continue;}if(!eligibleLevel(row.level)){counts.low_level++;continue;}
  if(!row.selectable){counts.unavailable++;continue;}selected.push(row);
 }
 return {selected,counts};
}
export function nextPart(rows,state){const open=state.tags.find(t=>t.count<50);const tag=open||{name:TAG_PREFIX+(state.tags.length+1),count:0};return {name:tag.name,create:!open,before:tag.count,rows:rows.slice(0,50-tag.count)};}
export function pageCandidates(rows,state,remembered=[]){
 const live=classify(rows,state).selected;
 const indices=[...new Set([...remembered,...live.map(r=>r.rowIndex)])];
 assert(indices.every(i=>rows.some(r=>r.rowIndex===i)),'Remembered page row disappeared');
 const remaining=rows.filter(r=>indices.includes(r.rowIndex)&&!r.tags.some(t=>TAG_PATTERN.test(t)));
 assert(remaining.every(r=>eligibleLevel(r.level)),'Remembered row lost its eligible level badge');
 return {indices,remaining};
}
export function commitPending(state){
 const p=state.pending_apply;assert(p&&p.row_indices?.length,'No pending row selection');assert(new Set(p.row_indices).size===p.row_indices.length,'Duplicate selected rows');
 let tag=state.tags.find(t=>t.name===p.tag);if(!tag){assert(p.before===0&&p.tag===TAG_PREFIX+(state.tags.length+1),'Unexpected tag sequence');tag={name:p.tag,count:0};state.tags.push(tag);}
 assert(tag.count===p.before,'Checkpoint count changed');assert(tag.count+p.row_indices.length<=50,'Tag exceeds 50');tag.count+=p.row_indices.length;tag.verified_at=new Date().toISOString();state.pending_apply=null;
}
export function verifyPending(rows,state){const p=state.pending_apply;if(!p)return true;if(!p.row_indices)return false;return p.row_indices.every(i=>{const row=rows.find(r=>r.rowIndex===i);return row&&eligibleLevel(row.level)&&row.tags.includes(p.tag)&&row.tags.filter(t=>TAG_PATTERN.test(t)).length===1;});}
export function audit(state){assert(!state.pending_apply,'Uncertain tag application remains');state.tags.forEach((t,i)=>{assert(t.name===TAG_PREFIX+(i+1),'Tag numbering gap');assert(Number.isInteger(t.count)&&t.count>0&&t.count<=50,'Invalid count');assert(i===state.tags.length-1||t.count===50,'Earlier tag is not full');});return {tags:state.tags.length,creators:state.tags.reduce((n,t)=>n+t.count,0)};}
export function auditPrepared(state){
 const names=state.empty_tags||[];assert(new Set(names).size===names.length,'Duplicate prepared tag');
 names.forEach((name,i)=>{assert(name===TAG_PREFIX+(state.tags.length+i+1),'Prepared tag numbering gap');const proof=state.prepared_tags?.[name];assert(proof?.status==='EMPTY'&&proof.verified_at,'Prepared tag has no empty-creation proof');});
 return {prepared_empty_tags:names.length};
}
export function planPrepared(state,count=25){
 audit(state);auditPrepared(state);assert(Number.isInteger(count)&&count>0&&count<=25,'Invalid prepared batch size');
 const start=state.tags.length+(state.empty_tags||[]).length+1;return Array.from({length:count},(_,i)=>TAG_PREFIX+(start+i));
}
export function finalize(state){const result=audit(state);state.tags=state.tags.map(({identity_hashes,membership_hash,...tag})=>tag);state.finalized_at=new Date().toISOString();return result;}
