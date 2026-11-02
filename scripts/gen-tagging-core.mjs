import crypto from 'node:crypto';

const OPERATING_TAG = /^(GEN|VIP)([1-9]\d*)$/i;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function normalizeHandle(value) {
  return String(value || '').trim().replace(/^@+/, '').toLocaleLowerCase('en-US');
}

export function normalizeTag(value) {
  const normalized = String(value || '').trim().toUpperCase();
  assert(OPERATING_TAG.test(normalized), '태그는 GEN1 또는 VIP1 형식이어야 합니다.');
  return normalized;
}

export function parseMoney(value) {
  const normalized = String(value ?? '').replaceAll(',', '').replace(/[^0-9.+-]/g, '');
  if (!normalized || normalized === '.' || normalized === '-' || normalized === '+') return 0;
  const parsed = Number(normalized);
  assert(Number.isFinite(parsed), `금액을 읽을 수 없습니다: ${value}`);
  return parsed;
}

export function identityForRow(row) {
  const creatorId = String(row.creatorId || '').trim();
  if (creatorId) return `id:${creatorId}`;
  const handle = normalizeHandle(row.handle);
  assert(handle, 'creator ID와 Handle이 모두 비어 있습니다.');
  return `handle:${handle}`;
}

export function hashIdentity(identity) {
  return crypto.createHash('sha256').update(String(identity)).digest('hex');
}

export function tagNumber(tagName, prefix = 'GEN') {
  const match = new RegExp(`^${prefix}([1-9]\\d*)$`, 'i').exec(String(tagName || '').trim());
  return match ? Number(match[1]) : null;
}

export function genTagName(number) {
  const parsed = Number(number);
  assert(Number.isInteger(parsed) && parsed > 0, 'GEN 태그 번호는 양의 정수여야 합니다.');
  return `GEN${parsed}`;
}

export function classifyCreatorRows(rows, {
  seenHashes = new Set(),
  vipHandles = new Set(),
  includeManagedCreators = false,
  includeExistingGen = false,
} = {}) {
  const selected = [];
  const skipped = { duplicate: [], existing_gen: [], vip: [], positive_gmv: [], unavailable: [], invalid: [] };
  const pageHashes = new Set();

  for (const row of rows) {
    let identity;
    try { identity = identityForRow(row); }
    catch {
      skipped.invalid.push(row);
      continue;
    }
    const identityHash = hashIdentity(identity);
    const handle = normalizeHandle(row.handle);
    const tags = (row.tags || []).map(tag => String(tag).trim().toUpperCase());

    if (seenHashes.has(identityHash) || pageHashes.has(identityHash)) {
      skipped.duplicate.push({ ...row, identityHash });
      continue;
    }
    pageHashes.add(identityHash);
    if (!includeExistingGen && tags.some(tag => /^GEN[1-9]\d*$/.test(tag))) {
      skipped.existing_gen.push({ ...row, identityHash });
      continue;
    }
    if (!includeManagedCreators && (tags.some(tag => /^VIP[1-9]\d*$/.test(tag)) || vipHandles.has(handle))) {
      skipped.vip.push({ ...row, identityHash });
      continue;
    }
    if (!includeManagedCreators && parseMoney(row.gmv) > 0) {
      skipped.positive_gmv.push({ ...row, identityHash });
      continue;
    }
    if (row.selectable === false) {
      skipped.unavailable.push({ ...row, identityHash });
      continue;
    }
    selected.push({ ...row, identityHash });
  }
  assert(selected.length <= 50, `한 태그에 ${selected.length}명이 선택되었습니다. 최대 50명입니다.`);
  return { selected, skipped };
}

export function createGenTaggingState({ shopId, shopRegion = 'US', createdAt = new Date().toISOString() }) {
  assert(/^\d+$/.test(String(shopId || '')), 'shopId가 필요합니다.');
  return {
    schema_version: 4,
    workflow: 'GEN_PLAYWRIGHT_TAGGING',
    allow_overlap: true,
    shop_id: String(shopId),
    shop_region: String(shopRegion || 'US').toUpperCase(),
    created_at: createdAt,
    updated_at: createdAt,
    status: 'READY',
    next_tag_number: 1,
    passes_completed: 0,
    seen_hashes: [],
    tags: [],
    totals: {
      tagged: 0,
      duplicate_skips: 0,
      existing_gen_skips: 0,
      vip_skips: 0,
      positive_gmv_skips: 0,
      unavailable_skips: 0,
      invalid_skips: 0,
    },
  };
}

export function createIncrementalGenTaggingState({
  shopId,
  shopRegion = 'US',
  nextTagNumber,
  plan,
  createdAt = new Date().toISOString(),
}) {
  const state = createGenTaggingState({ shopId, shopRegion, createdAt });
  const parsedNext = Number(nextTagNumber);
  assert(Number.isInteger(parsedNext) && parsedNext > 0, '증분 시작 GEN 번호는 양의 정수여야 합니다.');
  state.schema_version = 4;
  state.workflow = 'GEN_PLAYWRIGHT_INCREMENTAL';
  state.allow_overlap = false;
  state.next_tag_number = parsedNext;
  state.plan = {
    complete_scan: Boolean(plan?.complete_scan),
    pages_scanned: Number(plan?.pages_scanned || 0),
    untagged_creators: Number(plan?.untagged_creators || 0),
    max_existing_gen: Number(plan?.max_existing_gen || 0),
    planned_at: String(plan?.planned_at || createdAt),
  };
  return state;
}

export function recordIncrementalTagPart(state, result, completedAt = new Date().toISOString()) {
  assert(state.workflow === 'GEN_PLAYWRIGHT_INCREMENTAL', '증분 GEN 체크포인트가 아닙니다.');
  const tagName = normalizeTag(result.tagName);
  assert(tagName === genTagName(state.next_tag_number), `증분 태그는 ${genTagName(state.next_tag_number)}이어야 합니다.`);
  const hashes = [...new Set(result.identityHashes || [])];
  assert(hashes.length > 0 && hashes.length <= 50, '증분 적용 인원은 1~50명이어야 합니다.');
  const seen = new Set(state.seen_hashes || []);
  assert(hashes.every(hash => !seen.has(hash)), `${tagName}에 이미 기록된 creator가 포함됐습니다.`);

  let tag = state.tags.find(item => item.tag_name === tagName);
  if (!tag) {
    tag = {
      tag_name: tagName,
      source_page: Number(result.sourcePage),
      source_pages: [],
      actual_count: 0,
      identity_hashes: [],
      status: 'OPEN',
      completed_at: null,
      note: 'Incremental untagged packing',
    };
    state.tags.push(tag);
  }
  assert(tag.status === 'OPEN', `${tagName}은 이미 닫힌 태그입니다.`);
  assert(tag.actual_count + hashes.length <= 50, `${tagName} 인원이 50명을 초과합니다.`);
  if (!tag.source_pages.includes(Number(result.sourcePage))) tag.source_pages.push(Number(result.sourcePage));
  tag.identity_hashes.push(...hashes);
  tag.actual_count = tag.identity_hashes.length;
  state.seen_hashes.push(...hashes);
  state.totals.tagged += hashes.length;
  state.updated_at = completedAt;
  state.status = 'RUNNING';
  return state;
}

export function closeIncrementalTag(state, completedAt = new Date().toISOString()) {
  assert(state.workflow === 'GEN_PLAYWRIGHT_INCREMENTAL', '증분 GEN 체크포인트가 아닙니다.');
  const tagName = genTagName(state.next_tag_number);
  const tag = state.tags.find(item => item.tag_name === tagName);
  assert(tag && tag.status === 'OPEN' && tag.actual_count > 0, `${tagName}에 닫을 증분 인원이 없습니다.`);
  tag.status = 'COMPLETE';
  tag.completed_at = completedAt;
  state.next_tag_number += 1;
  state.updated_at = completedAt;
  return state;
}

export function recordCompletedTag(state, result, completedAt = new Date().toISOString()) {
  const tagName = normalizeTag(result.tagName);
  assert(tagName.startsWith('GEN'), 'GEN 태그만 기록할 수 있습니다.');
  assert(!state.tags.some(tag => tag.tag_name === tagName), `${tagName}은 이미 완료 기록이 있습니다.`);
  const hashes = [...new Set(result.identityHashes || [])];
  assert(hashes.length > 0 && hashes.length <= 50, `${tagName} 실제 인원은 1~50명이어야 합니다.`);
  const seen = new Set(state.seen_hashes || []);
  const overlap = hashes.filter(hash => seen.has(hash));
  const allowOverlap = state.allow_overlap === true || (state.allow_overlap == null && state.workflow === 'GEN_PLAYWRIGHT_TAGGING');
  if (!allowOverlap) assert(overlap.length === 0, `${tagName}에 이전 태그와 중복된 creator가 있습니다.`);

  state.tags.push({
    tag_name: tagName,
    source_page: Number(result.sourcePage),
    actual_count: hashes.length,
    identity_hashes: hashes,
    completed_at: completedAt,
    note: String(result.note || ''),
  });
  state.seen_hashes = [...new Set([...seen, ...hashes])];
  state.next_tag_number = Math.max(state.next_tag_number, tagNumber(tagName) + 1);
  state.totals.tagged += hashes.length;
  for (const [key, totalKey] of [
    ['duplicate', 'duplicate_skips'],
    ['existing_gen', 'existing_gen_skips'],
    ['vip', 'vip_skips'],
    ['positive_gmv', 'positive_gmv_skips'],
    ['unavailable', 'unavailable_skips'],
    ['invalid', 'invalid_skips'],
  ]) state.totals[totalKey] += Number(result.skipped?.[key] || 0);
  state.updated_at = completedAt;
  state.status = 'RUNNING';
  return state;
}

export function auditGenTaggingState(state) {
  const finalized = state.status === 'FINALIZED'
    && state.tags.every(tag => !Array.isArray(tag.identity_hashes) && Boolean(tag.membership_hash));
  if (finalized) {
    const errors = [];
    const assignments = state.tags.reduce((sum, tag) => {
      if (tag.actual_count < 1 || tag.actual_count > 50) errors.push(`${tag.tag_name} 허용 인원 초과`);
      return sum + Number(tag.actual_count || 0);
    }, 0);
    if (state.totals.tagged !== assignments) errors.push('전체 태깅 기록 수와 태그별 적용 건수가 다릅니다.');
    return {
      ok: errors.length === 0,
      errors,
      finalized: true,
      tags: state.tags.length,
      tagged: state.totals.tagged,
      membership_assignments: assignments,
      unique_creators: null,
      overlapping_memberships: null,
      next_tag: genTagName(state.next_tag_number),
    };
  }
  const allHashes = state.tags.flatMap(tag => tag.identity_hashes || []);
  const unique = new Set(allHashes);
  const errors = [];
  const allowOverlap = state.allow_overlap === true || (state.allow_overlap == null && state.workflow === 'GEN_PLAYWRIGHT_TAGGING');
  if (!allowOverlap && unique.size !== allHashes.length) errors.push(`태그 간 중복 ${allHashes.length - unique.size}건`);
  for (const tag of state.tags) {
    if (tag.actual_count !== (tag.identity_hashes || []).length) errors.push(`${tag.tag_name} 인원 불일치`);
    if (tag.actual_count < 1 || tag.actual_count > 50) errors.push(`${tag.tag_name} 허용 인원 초과`);
  }
  if (state.totals.tagged !== allHashes.length) errors.push('전체 태깅 기록 수와 태그별 적용 건수가 다릅니다.');
  return {
    ok: errors.length === 0,
    errors,
    finalized: false,
    tags: state.tags.length,
    tagged: state.totals.tagged,
    membership_assignments: allHashes.length,
    unique_creators: unique.size,
    overlapping_memberships: allHashes.length - unique.size,
    next_tag: genTagName(state.next_tag_number),
  };
}

export function selectGenTagsForDeletion(tagNames, { from = 1, to = Number.MAX_SAFE_INTEGER } = {}) {
  const start = Number(from);
  const end = Number(to);
  assert(Number.isInteger(start) && start > 0, '--from은 양의 정수여야 합니다.');
  assert(Number.isInteger(end) && end >= start, '--to는 --from 이상의 정수여야 합니다.');
  return [...new Set(tagNames.map(name => String(name).trim().toUpperCase()))]
    .map(name => ({ name, number: tagNumber(name, 'GEN') }))
    .filter(item => item.number != null && item.number >= start && item.number <= end)
    .sort((left, right) => right.number - left.number)
    .map(item => item.name);
}

export function deleteConfirmation(tagNames) {
  assert(tagNames.length > 0, '삭제할 GEN 태그가 없습니다.');
  const numbers = tagNames.map(name => tagNumber(name, 'GEN')).filter(Boolean);
  return `DELETE GEN TAGS GEN${Math.min(...numbers)}-GEN${Math.max(...numbers)} ${tagNames.length}`;
}

export function selectAllOperatingTags(tagNames) {
  return [...new Set(tagNames.map(name => String(name).trim().toUpperCase()))]
    .map(name => ({ name, match: /^(GEN|VIP)([1-9]\d*)$/.exec(name) }))
    .filter(item => item.match)
    .sort((left, right) => {
      if (left.match[1] !== right.match[1]) return left.match[1] === 'GEN' ? -1 : 1;
      return Number(right.match[2]) - Number(left.match[2]);
    })
    .map(item => item.name);
}

export function deleteAllConfirmation(tagNames) {
  assert(tagNames.length > 0, '삭제할 태그가 없습니다.');
  return `DELETE ALL TAGS ${tagNames.length}`;
}
