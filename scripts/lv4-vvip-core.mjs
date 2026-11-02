import {createInvitationPlan} from './target-invitation-core.mjs';

export const VVIP_INVITATION=`🔥 50% COMMISSION + VIDEO BOOSTING! 🔥

Hi! This is the CELDYQUÉ Manager! 💕

💎 You're invited to our EXCLUSIVE VVIP Collaboration with an incredible 50% commission for 5 weeks! Plus, we'll boost your videos to help maximize your sales! 🚀

If your content performs well, we'd love to continue our partnership with great benefits beyond the 5 weeks!

⏰ LIMITED SPOTS AVAILABLE! Accept your invitation ASAP to secure your 50% commission!

Don't miss out on this exclusive opportunity! 💖`;
export const VVIP_MESSAGE=`Hi! 💕 We're sending you exclusive **50% commission product cards for our Volufiline and Blue Copper Peptide Serum!** 🔥

⏰ **Limited spots available!** Please accept your invitations ASAP to secure these special offers. Don't miss out! 💖`;
export const VVIP_PRODUCTS=[
 {id:'1731757173019480536',label:'보르피린',name:'[CELDYQUE] Volufiline 100% Pure Concentrate Serum Set of 2 | K-Beauty Plumping Skincare for Smile Lines & Under Eyes | 10ml x2',standard_commission_rate:50,shop_ads_commission_rate:15},
 {id:'1732507686646485464',label:'카퍼펩',name:'[CELDYQUE] Blue Copper Peptide Daily Serum - Bakuchiol, GHK-Cu, Matrixyl 3000, EGF, 12 Peptides for Skin Repair, Plumper & Firmer Look - Dry & All Skin Types - 1 fl oz (30ml),blue copper peptide serum',standard_commission_rate:50,shop_ads_commission_rate:15},
];
export function kstDate(now=new Date()){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);}
export function buildVvipPlan(tagState,{startDate=kstDate(),now=new Date()}={}){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(startDate))throw Error('시작일은 YYYY-MM-DD 형식이어야 합니다.');
 const date=new Date(startDate+'T00:00:00Z');if(date.toISOString().slice(0,10)!==startDate)throw Error('유효하지 않은 시작일');
 if(tagState.workflow!=='LV4UP_TAGGING'||tagState.min_level!==4||tagState.max_level!=null)throw Error('Lv4 이상 완료 태그만 사용할 수 있습니다.');
 const until=new Date(date.getTime()+35*86400000).toISOString().slice(0,10);const [year,month,day]=until.split('-');
 const plan=createInvitationPlan({tagState,from:tagState.tags[0].name,to:tagState.tags.at(-1).name,invitationName:startDate.slice(5).replace('-','.')+' VVIP50',validUntil:`${month}/${day}/${year}`,templateId:'7688275903915443982',shopId:'8651858975596646872',shareToIm:true,messageText:VVIP_MESSAGE,invitationText:VVIP_INVITATION,now});
 Object.assign(plan.config,{campaign_key:'lv4-vvip-50',start_date:startDate,duration_days:35,minimum_creator_level:4,products:structuredClone(VVIP_PRODUCTS),commission_rate:50,shop_ads_commission_rate:15,sample_policy:'PRODUCT_LEVEL',fail_fast:false,require_full_creator_selection:false,require_full_message_selection:false,invitation_prepare_retry_limit:2,continue_after_unconfirmed_invite:false,continue_after_uncertain_without_retry:true,unconfirmed_invite_retry_limit:0,message_dialog_reload_retries:2,reinvite_on_message_prepare_failure:false,message_reinvite_limit:0,resume_verified_message_without_reinvite:true,message_poll_ms:1000,message_stabilize_ms:2000,manual_start_only:true});
 return plan;
}
