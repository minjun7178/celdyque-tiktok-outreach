const DATE_PATTERN = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const GEN_PATTERN = /^GEN([1-9]\d*)$/i;
const OUTREACH_PATTERN = /^(GEN|lv3up|lv4up|lv4only)([1-9]\d*)$/i;

export const DEFAULT_INVITATION_SHARE_MESSAGE = `Hi [First Name]! 💙 We love your content and think you’d be a great fit for Celdyque ✨

We’d love to collaborate with you on our [Product Name], featuring [key benefit / selling point]. We think your audience would really enjoy it!

If the content performs well, we may also support it with paid boosting to help increase reach 🚀

Interested in working together? 💌`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function validateInvitationText(value) {
  const text = String(value ?? '');
  assert(text.trim().length > 0 && text.length <= 500, 'Invitation text는 1~500자여야 합니다.');
  return text;
}

export function verifyInvitationText(expected, actual) {
  const text = validateInvitationText(expected);
  // The live invitation editor removes pictographic emoji on input. Accept
  // only that exact platform transformation, never truncation or other edits.
  const withoutEmoji = text.replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, '');
  assert(String(actual).trim().length > 0 && (actual === text || actual === withoutEmoji), 'Invitation text 입력값이 확정 문구와 다릅니다.');
  return { text: actual, emoji_removed: actual !== text };
}

export function normalizeGenTag(value, label = 'tag') {
  const tag = String(value || '').trim().toUpperCase();
  const match = GEN_PATTERN.exec(tag);
  assert(match, `${label}은 GEN1 형식이어야 합니다.`);
  return { tag, number: Number(match[1]) };
}

export function normalizeInvitationTag(value, label = 'tag') {
  const match = OUTREACH_PATTERN.exec(String(value || '').trim());
  assert(match, `${label}은 GEN1 또는 lv3up1 형식이어야 합니다.`);
  const prefix = match[1].toLowerCase() === 'gen' ? 'GEN' : match[1].toLowerCase();
  return { tag: prefix + match[2], number: Number(match[2]), prefix };
}

export function parseUsDate(value) {
  const input = String(value || '').trim();
  const match = DATE_PATTERN.exec(input);
  assert(match, '날짜는 MM/DD/YYYY 형식이어야 합니다.');
  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  assert(
    parsed.getUTCFullYear() === year
      && parsed.getUTCMonth() === month - 1
      && parsed.getUTCDate() === day,
    '존재하지 않는 날짜입니다.',
  );
  return {
    input,
    iso: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    year,
    month,
    day,
  };
}

export function buildDuplicateInvitationUrl({ templateId, shopId, shopRegion = 'US' }) {
  assert(/^\d+$/.test(String(templateId || '')), 'template-id는 숫자 invitation ID여야 합니다.');
  assert(/^\d+$/.test(String(shopId || '')), 'shop-id는 숫자여야 합니다.');
  const region = String(shopRegion || 'US').trim().toUpperCase();
  const url = new URL('https://affiliate-global.tiktok.com/affiliate/collaboration/target-invitation/create');
  url.searchParams.set('invitation_id', String(templateId));
  url.searchParams.set('enter_from', 'target_invitation_list');
  url.searchParams.set('enter_method', 'duplicate');
  url.searchParams.set('shop_id', String(shopId));
  url.searchParams.set('shop_region', region);
  url.searchParams.set('origin_region', region);
  url.searchParams.set('origin_shop_id', '');
  return url.toString();
}

export function parseCreatorCount(text, suffix) {
  const escaped = suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(\\d+)\\s*\\/\\s*50\\s*${escaped}`, 'i').exec(String(text || ''));
  assert(match, `크리에이터 인원을 읽을 수 없습니다: ${text}`);
  const count = Number(match[1]);
  assert(count >= 0 && count <= 50, '크리에이터 인원은 0~50이어야 합니다.');
  return count;
}

export function parseCreatorSelectionProgress(text) {
  const match = /(\d+)\s*\/\s*(\d+)\s*creators selected/i.exec(String(text || ''));
  assert(match, `메시지 대상 인원을 읽을 수 없습니다: ${text}`);
  const selected = Number(match[1]);
  const total = Number(match[2]);
  assert(Number.isInteger(total) && total >= 1 && total <= 50, '메시지 전체 인원은 1~50이어야 합니다.');
  assert(Number.isInteger(selected) && selected >= 0 && selected <= total, '메시지 선택 인원이 전체 인원 범위를 벗어났습니다.');
  return { selected, total };
}

export function messageVerificationTarget(expectedCount, candidateCount) {
  const expected = Number(expectedCount);
  const candidates = Number(candidateCount);
  assert(Number.isInteger(expected) && expected >= 1 && expected <= 50, '메시지 실제 대상 수는 1~50이어야 합니다.');
  assert(Number.isInteger(candidates) && candidates >= 0, '메시지 handle 후보 수가 올바르지 않습니다.');
  return Math.min(expected, candidates);
}

export function validateRecipientSelection(selected,total,{requireFull=false}={}){
 assert(Number.isInteger(selected)&&selected>=1&&selected<=total&&Number.isInteger(total)&&total<=50,'메시지 선택 인원이 올바르지 않습니다.');
 assert(!requireFull||selected===total,`MESSAGE_SELECTION_INCOMPLETE: ${selected}/${total}; Share 전에 중단합니다.`);
 return selected;
}

export function messageReinviteDecision(item, config = {}) {
  const status = String(item?.status || '');
  const used = Math.max(0, Number(item?.message_reinvite_count || 0));
  const eligible = status === 'INVITE_SENT'
    || status === 'MESSAGE_FAILED'
    || (status === 'FAILED' && used > 0);
  const limit = Math.max(0, Number(config.message_reinvite_limit || 0));
  if (!eligible) return { action: 'NONE', used, limit };
  if(config.resume_verified_message_without_reinvite&&item.message_resume_url&&item.invite_confirmation_status==='VERIFIED'&&!item.message_share_clicked_at)return {action:'RESUME_EXISTING',used,limit};
  if (!config.reinvite_on_message_prepare_failure) {
    return { action: 'SKIP_RESUME_UNAVAILABLE', used, limit };
  }
  if (used >= limit) return { action: 'SKIP', used, limit };
  return { action: 'REINVITE', used, next: used + 1, limit };
}

export function invitationPreparationRetryDecision(attempt, config = {}, { fatal = false } = {}) {
  const used = Math.max(0, Number(attempt || 0));
  const limit = Math.max(0, Number(config.invitation_prepare_retry_limit ?? 2));
  if (fatal) return { action: 'STOP_FATAL', used, limit };
  if (used < limit) return { action: 'RETRY_FRESH_FORM', used, next: used + 1, limit };
  return { action: 'FAIL_TAG_AND_CONTINUE', used, limit };
}

export function upgradeInvitationCheckpoint(state) {
  assert(state && typeof state === 'object', '초대 체크포인트 형식이 올바르지 않습니다.');
  assert(state.config && typeof state.config === 'object', '초대 체크포인트 config가 없습니다.');
  assert(Array.isArray(state.tags), '초대 체크포인트 tags가 없습니다.');

  const config = state.config;
  const duplicateTolerantPlan = config.overlap_policy === 'MOVE_TO_THIS_INVITATION';
  if (!duplicateTolerantPlan) return state;

  const defaults = {
    invitation_prepare_retry_limit: 2,
    overlap_resolution_timeout_ms: 5_000,
  };
  if (config.share_to_im) Object.assign(defaults, {
    message_dialog_timeout_ms: 20_000,
    message_dialog_reload_retries: 2,
    reinvite_on_message_prepare_failure: true,
    message_reinvite_limit: 2,
    invite_success_timeout_ms: 15_000,
    continue_after_unconfirmed_invite: true,
    unconfirmed_invite_retry_limit: 2,
  });
  let upgraded = false;
  for (const [key, value] of Object.entries(defaults)) {
    if (config[key] == null) {
      config[key] = value;
      upgraded = true;
    }
  }
  if (upgraded) {
    state.schema_version = Math.max(4, Number(state.schema_version || 0));
    state.checkpoint_upgrade = 'INVITATION_PREP_RECOVERY_V2';
  }
  return state;
}

export function summarizeCreatorPageSelection(beforeCount, afterCount, visibleRows) {
  const before = Number(beforeCount);
  const after = Number(afterCount);
  const visible = Number(visibleRows);
  assert(Number.isInteger(before) && before >= 0 && before <= 50, '페이지 선택 전 인원은 0~50이어야 합니다.');
  assert(Number.isInteger(after) && after >= 0 && after <= 50, '페이지 선택 후 인원은 0~50이어야 합니다.');
  assert(Number.isInteger(visible) && visible >= 1 && visible <= 50, '화면 creator 행 수는 1~50이어야 합니다.');
  assert(after >= before, `페이지 선택 인원이 감소했습니다: ${before} -> ${after}`);
  const capacity = Math.min(50 - before, visible);
  const gained = after - before;
  return {
    before,
    after,
    visible,
    gained,
    unavailable: Math.max(0, capacity - gained),
    progressed: gained > 0,
  };
}

export function validateSelectableCreatorCount(value) {
  const count = Number(value);
  assert(Number.isInteger(count) && count >= 1 && count <= 50, '현재 선택 가능 인원은 1~50이어야 합니다.');
  return count;
}

function tagEntries(tagState, prefix) {
  assert(tagState && Array.isArray(tagState.tags), '태그 체크포인트의 tags 배열이 없습니다.');
  const byNumber = new Map();
  for (const item of tagState.tags) {
    const rawName = item.tag_name || item.tag || item.name;
    if (!OUTREACH_PATTERN.test(String(rawName || ''))) continue;
    const parsed = normalizeInvitationTag(rawName, 'tag_name');
    if (parsed.prefix !== prefix) continue;
    const count = Number(item.actual_count ?? item.creator_count ?? item.count ?? 0);
    assert(Number.isInteger(count) && count >= 1 && count <= 50, `${parsed.tag} 인원이 1~50 범위가 아닙니다.`);
    assert(!byNumber.has(parsed.number), `${parsed.tag} 태그가 체크포인트에 중복됩니다.`);
    byNumber.set(parsed.number, {
      tag_name: parsed.tag,
      tag_number: parsed.number,
      expected_count: count,
    });
  }
  return [...byNumber.values()].sort((a, b) => a.tag_number - b.tag_number);
}

export function estimateBatchDuration(tagCount, {
  minSecondsPerTag = 16,
  maxSecondsPerTag = 26,
} = {}) {
  assert(Number.isInteger(tagCount) && tagCount >= 0, '태그 수가 잘못됐습니다.');
  return {
    min_seconds: tagCount * minSecondsPerTag,
    max_seconds: tagCount * maxSecondsPerTag,
  };
}

export function estimateMessagePipelineDuration(tagCount) {
  return estimateBatchDuration(tagCount, {
    minSecondsPerTag: 220,
    maxSecondsPerTag: 330,
  });
}

const MESSAGE_LIMIT_PATTERNS = [
  /too many messages to this creator consecutively/i,
  /send up to 5 messages to an unconnected creator each week/i,
  /weekly limit/i,
];

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeMessageText(value) {
  return String(value || '')
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function messageSignatures(messageText) {
  return String(messageText || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .map(line => {
      if (!line.includes('[First Name]')) return line;
      return line.split('[First Name]').at(-1).replace(/^[^\p{L}\p{N}]+/u, '');
    })
    .filter(line => line.length >= 20)
    .map(normalizeMessageText);
}

export function hasMessageRestriction(text) {
  return MESSAGE_LIMIT_PATTERNS.some(pattern=>pattern.test(String(text)));
}

export function classifyMessageOutcomes(text, handles, messageText = DEFAULT_INVITATION_SHARE_MESSAGE, {restrictionFirst=false}={}) {
  const orderedHandles = [...new Set(handles.map(value => String(value || '').trim().replace(/^@/, '')).filter(Boolean))];
  const handleSet = new Set(orderedHandles);
  const lines = String(text || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  const outcomes = new Map();
  const signatures = messageSignatures(messageText);

  const lineHandle = line => {
    if (handleSet.has(line)) return line;
    for (const handle of orderedHandles) {
      if (line.startsWith(`${handle} `)) return handle;
    }
    return null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const handle = lineHandle(lines[index]);
    if (!handle) continue;
    const segment = [lines[index]];
    for (let cursor = index + 1; cursor < lines.length && segment.length < 20; cursor += 1) {
      if (lineHandle(lines[cursor])) break;
      segment.push(lines[cursor]);
    }
    const joined = segment.join('\n');
    const normalizedJoined = normalizeMessageText(joined);
    if (restrictionFirst && hasMessageRestriction(joined)) {
      outcomes.set(handle, 'RESTRICTED');
    } else if (
      new RegExp(`Dear\\s+${escapeRegExp(handle)}\\s*,`, 'i').test(joined)
      || signatures.some(signature => normalizedJoined.includes(signature))
    ) {
      outcomes.set(handle, 'DELIVERED');
    } else if (hasMessageRestriction(joined)) {
      outcomes.set(handle, 'RESTRICTED');
    }
  }
  return outcomes;
}

export function createInvitationPlan({
  tagState,
  from,
  to,
  maxTags = null,
  invitationName,
  validUntil,
  templateId,
  shopId,
  shopRegion = 'US',
  shareToIm = false,
  messageText = DEFAULT_INVITATION_SHARE_MESSAGE,
  invitationText = null,
  now = new Date(),
}) {
  const first = normalizeInvitationTag(from, 'from');
  const last = normalizeInvitationTag(to, 'to');
  assert(first.prefix === last.prefix, 'from과 to는 같은 태그 종류여야 합니다.');
  if (first.prefix !== 'GEN') {
    assert(tagState?.workflow === `${first.prefix.toUpperCase()}_TAGGING` && tagState.status === 'COMPLETE', '완료된 레벨별 태깅 체크포인트가 필요합니다.');
    assert(String(tagState.shop_id) === String(shopId), 'lv3up 체크포인트의 shop ID가 다릅니다.');
    assert(!tagState.pending_apply && !tagState.pending_tag_creation && !tagState.page_selection, 'lv3up 태깅에 미확정 작업이 남아 있습니다.');
  }
  assert(first.number <= last.number, 'from은 to보다 클 수 없습니다.');
  const cleanName = String(invitationName || '').trim();
  assert(cleanName.length >= 1 && cleanName.length <= 30, 'invitation-name은 1~30자여야 합니다.');
  const date = parseUsDate(validUntil);
  const cleanMessageText = String(messageText || '').trim();
  if (invitationText != null) validateInvitationText(invitationText);
  if (shareToIm) {
    assert(cleanMessageText.length >= 1 && cleanMessageText.length <= 500, 'message text는 1~500자여야 합니다.');
  }
  const duplicateUrl = buildDuplicateInvitationUrl({ templateId, shopId, shopRegion });
  const available = tagEntries(tagState, first.prefix);
  const selected = available.filter(item => item.tag_number >= first.number && item.tag_number <= last.number);
  const expectedNumbers = Array.from({ length: last.number - first.number + 1 }, (_, index) => first.number + index);
  const selectedNumbers = new Set(selected.map(item => item.tag_number));
  const missing = expectedNumbers.filter(number => !selectedNumbers.has(number));
  assert(!missing.length, `체크포인트에 없는 태그가 있습니다: ${missing.map(number => first.prefix + number).join(', ')}`);
  const limited = maxTags == null ? selected : selected.slice(0, maxTags);
  assert(limited.length > 0, '계획에 포함할 태그가 없습니다.');
  const createdAt = now.toISOString();
  const estimate = shareToIm
    ? estimateMessagePipelineDuration(limited.length)
    : estimateBatchDuration(limited.length);
  return {
    schema_version: 4,
    workflow: 'TARGET_INVITATION_BATCH',
    status: 'PLANNED',
    created_at: createdAt,
    updated_at: createdAt,
    config: {
      from: limited[0].tag_name,
      to: limited.at(-1).tag_name,
      invitation_name: cleanName,
      valid_until: date.input,
      valid_until_iso: date.iso,
      template_id: String(templateId),
      shop_id: String(shopId),
      shop_region: String(shopRegion || 'US').toUpperCase(),
      duplicate_url: duplicateUrl,
      commission_rate: 30,
      shop_ads_commission_rate: 15,
      overlap_policy: 'MOVE_TO_THIS_INVITATION',
      invitation_prepare_retry_limit: 2,
      overlap_resolution_timeout_ms: 5_000,
      share_to_im: Boolean(shareToIm),
      message_text: shareToIm ? cleanMessageText : null,
      ...(invitationText == null ? {} : { invitation_text: invitationText }),
      message_poll_ms: 2_000,
      message_stabilize_ms: 10_000,
      message_quiet_timeout_ms: 20_000,
      message_total_timeout_ms: 900_000,
      message_dialog_timeout_ms: 20_000,
      message_dialog_reload_retries: 2,
      reinvite_on_message_prepare_failure: true,
      message_reinvite_limit: 2,
      invite_success_timeout_ms: 15_000,
      continue_after_unconfirmed_invite: true,
      unconfirmed_invite_retry_limit: 2,
    },
    estimate,
    tags: limited.map(item => ({
      ...item,
      status: 'PENDING',
      attempts: 0,
      overlap_count: null,
    })),
    failures: [],
  };
}

export function refreshPlanSummary(state) {
  const counts = {
    total: state.tags.length,
    pending: 0,
    preparing: 0,
    ready: 0,
    invite_sent: 0,
    message_preparing: 0,
    message_share_clicked: 0,
    message_failed: 0,
    message_uncertain: 0,
    sent: 0,
    failed: 0,
    uncertain: 0,
  };
  for (const item of state.tags) {
    const key = String(item.status || '').toLowerCase();
    if (Object.hasOwn(counts, key)) counts[key] += 1;
  }
  state.counts = counts;
  state.updated_at = new Date().toISOString();
  if (counts.sent === counts.total) state.status = 'COMPLETE';
  else if (counts.uncertain || counts.failed || counts.message_failed || counts.message_uncertain) state.status = 'PARTIAL';
  else if (
    counts.preparing
    || counts.ready
    || counts.invite_sent
    || counts.message_preparing
    || counts.message_share_clicked
  ) state.status = 'RUNNING';
  return state;
}

export function invitationConfirmation(state, queue) {
  assert(queue.length > 0, '전송할 태그가 없습니다.');
  const action = state.config.share_to_im ? 'INVITATIONS AND MESSAGES' : 'INVITATIONS';
  return `SEND ${action} ${queue[0].tag_name}-${queue.at(-1).tag_name} ${queue.length}`;
}

export function recoverInterruptedStates(state) {
  for (const item of state.tags) {
    if (item.status === 'PREPARING' || item.status === 'READY') {
      item.status = 'PENDING';
      item.note = 'Recovered before Send; safe to retry.';
    } else if (item.status === 'SEND_CLICKED') {
      if (state.config.continue_after_unconfirmed_invite) {
        item.status = 'FAILED';
        item.invite_confirmation_status = 'RETRY_PENDING';
        item.note = 'Process stopped after Send click; duplicate retry is allowed by the active plan.';
      } else {
        item.status = 'UNCERTAIN';
        item.note = 'Process stopped after Send click; verify in TikTok before retrying.';
      }
    } else if (item.status === 'UNCERTAIN' && state.config.continue_after_unconfirmed_invite) {
      item.status = 'FAILED';
      item.invite_confirmation_status = 'RETRY_PENDING';
      item.note = 'Previous Send result was unconfirmed; duplicate retry is allowed by the active plan.';
    } else if (item.status === 'MESSAGE_PREPARING') {
      item.status = 'INVITE_SENT';
      item.note = 'Invitation was verified; message Share was not clicked and is safe to resume.';
    } else if (item.status === 'MESSAGE_SHARE_CLICKED' || item.status === 'MESSAGE_UNCERTAIN') {
      const expected = Number(item.message_expected_count || item.selected_count || item.expected_count || 0);
      const progress = /MESSAGE_(?:STALLED|TIMEOUT):\s*(\d+)\s*\/\s*(\d+)/i.exec(String(item.note || ''));
      const verified = progress ? Number(progress[1]) : Number(item.message_verified_count || 0);
      item.status = 'SENT';
      item.sent_at ||= item.message_share_clicked_at || new Date().toISOString();
      item.message_verified_count = Math.max(0, verified);
      item.message_unverified_count = Math.max(0, expected - item.message_verified_count);
      item.message_monitoring_status = 'BEST_EFFORT_RECOVERED';
      item.note = `Message Share was already clicked; finalized without retry. verified=${item.message_verified_count}; unverified=${item.message_unverified_count}.`;
    }
  }
  return refreshPlanSummary(state);
}
