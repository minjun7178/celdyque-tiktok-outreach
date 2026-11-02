#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { launchProfile, defaultProfile } from './browser-profile.mjs';
import {
  auditGenTaggingState,
  classifyCreatorRows,
  closeIncrementalTag,
  createGenTaggingState,
  createIncrementalGenTaggingState,
  genTagName,
  hashIdentity,
  identityForRow,
  recordCompletedTag,
  recordIncrementalTagPart,
  tagNumber,
} from './gen-tagging-core.mjs';

const scriptFile = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(scriptFile), '..');
const defaultState = path.join(root, '.local', 'gen-tagging', 'current.json');
const defaultIncrementalState = path.join(root, '.local', 'gen-tagging', 'incremental.json');
const defaultShopId = '8651858975596646872';

function parseInteger(value, name, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${name}은 ${min}~${max} 범위의 정수여야 합니다.`);
  return parsed;
}

function parseOptions(args) {
  const command = args[0];
  if (!['login', 'plan', 'run', 'status', 'audit', 'finalize', 'reconcile-next', 'incremental-plan', 'incremental-run', 'incremental-status'].includes(command)) {
    throw new Error('지원하지 않는 GEN 태깅 명령입니다.');
  }
  const valueFlags = new Set(['--profile-dir', '--state', '--shop-id', '--shop-region', '--max-pages', '--passes', '--timeout-ms', '--page', '--expected-count', '--start-page']);
  const booleanFlags = new Set(['--apply', '--replace', '--continue-on-error', '--accept-first-pass']);
  const options = { command };
  for (let index = 1; index < args.length; index += 1) {
    const key = args[index];
    if (booleanFlags.has(key)) {
      if (Object.hasOwn(options, key)) throw new Error(`중복 옵션: ${key}`);
      options[key] = true;
      continue;
    }
    const value = args[index + 1];
    if (!valueFlags.has(key) || value == null || value.startsWith('--') || Object.hasOwn(options, key)) throw new Error(`잘못된 옵션: ${key}`);
    options[key] = value;
    index += 1;
  }
  options.profileDir = path.resolve(options['--profile-dir'] || defaultProfile);
  const incremental = command.startsWith('incremental-');
  options.stateFile = path.resolve(options['--state'] || (incremental ? defaultIncrementalState : defaultState));
  options.shopId = String(options['--shop-id'] || defaultShopId);
  options.shopRegion = String(options['--shop-region'] || 'US').toUpperCase();
  options.maxPages = options['--max-pages'] ? parseInteger(options['--max-pages'], '--max-pages') : null;
  options.passes = options['--passes'] ? parseInteger(options['--passes'], '--passes', { max: 3 }) : 1;
  options.timeoutMs = options['--timeout-ms'] ? parseInteger(options['--timeout-ms'], '--timeout-ms', { min: 5_000, max: 120_000 }) : 30_000;
  options.page = options['--page'] ? parseInteger(options['--page'], '--page') : null;
  options.expectedCount = options['--expected-count'] ? parseInteger(options['--expected-count'], '--expected-count', { max: 50 }) : null;
  options.startPage = options['--start-page'] ? parseInteger(options['--start-page'], '--start-page') : null;
  return options;
}

function creatorManagementUrl(options) {
  return `https://affiliate-global.tiktok.com/affiliate/assets/creator-management?view_blocked_creator=&shop_region=${encodeURIComponent(options.shopRegion)}&shop_id=${encodeURIComponent(options.shopId)}`;
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const pending = `${file}.${process.pid}.pending`;
  await fs.writeFile(pending, JSON.stringify(value, null, 2) + '\n');
  await fs.rename(pending, file);
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function waitForEnter(message) {
  if (!process.stdin.isTTY) throw new Error(`${message} 대화형 터미널에서 실행하세요.`);
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { await terminal.question(`${message}\nEnter를 누르면 종료합니다. `); }
  finally { terminal.close(); }
}

async function confirmExact(expected) {
  if (!process.stdin.isTTY) throw new Error(`실행에는 대화형 확인이 필요합니다: ${expected}`);
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  let answer;
  try { answer = await terminal.question(`실제 TikTok GEN 태그를 변경하려면 정확히 "${expected}"를 입력하세요: `); }
  finally { terminal.close(); }
  if (answer !== expected) throw new Error('확인 문구가 일치하지 않아 태깅하지 않았습니다.');
}

async function visibleCreatorTable(page, timeoutMs) {
  const candidates = page.getByRole('table').filter({ hasText: 'Creator name' }).filter({ hasText: 'GMV' });
  await candidates.first().waitFor({ state: 'visible', timeout: timeoutMs });
  const all = await candidates.all();
  for (const candidate of all) if (await candidate.isVisible()) return candidate;
  throw new Error('Manage creators 표를 찾지 못했습니다. 로그인과 페이지를 확인하세요.');
}

async function setFiftyPerPage(page) {
  const table = await visibleCreatorTable(page, 15_000);
  if ((await table.getByRole('row').count()) >= 51) return;
  const controlStarted = Date.now();
  let opened = false;
  while (Date.now() - controlStarted < 30_000) {
    const current50 = page.getByText('50/Page', { exact: true }).filter({ visible: true }).last();
    if (await current50.count()) return;
    const current20 = page.getByText(/^(10|20)\/Page$/, { exact: true }).filter({ visible: true }).last();
    if (await current20.count()) {
      await current20.locator('xpath=../..').evaluate(element => element.click());
      opened = true;
      break;
    }
    const pageSize = page.getByRole('combobox').filter({ hasText: /\/Page/ }).filter({ visible: true }).last();
    if (await pageSize.count()) {
      await pageSize.evaluate(element => element.click());
      opened = true;
      break;
    }
    await page.waitForTimeout(250);
  }
  if (!opened) throw new Error('30초 동안 페이지 크기 선택기를 찾지 못했습니다.');
  const option = page.getByText('50/Page', { exact: true }).filter({ visible: true }).last();
  await option.waitFor({ state: 'visible', timeout: 15_000 });
  await option.evaluate(element => element.click());
  const started = Date.now();
  while (Date.now() - started < 60_000) {
    await page.waitForTimeout(250);
    try {
      const loadedTable = await visibleCreatorTable(page, 2_000);
      if ((await loadedTable.getByRole('row').count()) >= 51) return;
    } catch { /* The table is temporarily replaced while page size changes. */ }
  }
  throw new Error('50/Page 전환 후 50개 creator 행이 로드되지 않았습니다.');
}

function creatorIdFromHref(href) {
  const match = /(?:creator_id|creatorId|uid|user_id)=([0-9]+)/i.exec(href || '') || /\/creator\/([0-9]+)/i.exec(href || '');
  return match?.[1] || '';
}

async function readCreatorRows(page, timeoutMs) {
  const table = await visibleCreatorTable(page, timeoutMs);
  const allRows = table.getByRole('row');
  const header = allRows.first();
  let headers = await header.getByRole('columnheader').allTextContents();
  if (!headers.length) headers = await header.locator('th').allTextContents();
  const cleanHeaders = headers.map(text => text.replace(/\s+/g, ' ').trim().toLowerCase());
  const creatorIndex = cleanHeaders.findIndex(text => text.includes('creator name'));
  const tagsIndex = cleanHeaders.findIndex(text => text === 'tags' || text.startsWith('tags '));
  const gmvIndex = cleanHeaders.findIndex(text => text === 'gmv' || text.startsWith('gmv '));
  if (creatorIndex < 0 || gmvIndex < 0) throw new Error(`표 열을 해석하지 못했습니다: ${headers.join(' | ')}`);

  const dataRows = allRows.nth(1).locator('xpath=..').getByRole('row').filter({ has: page.getByRole('cell') });
  const rawRows = await dataRows.evaluateAll((elements, indexes) => elements.map((row, rowIndex) => {
    if (!row.getClientRects().length) return null;
    const cells = [...row.querySelectorAll('[role="cell"], td')]
      .filter(cell => cell.closest('[role="row"], tr') === row);
    if (cells.length <= indexes.gmvIndex) return null;
    const checkbox = row.querySelector('input[type="checkbox"], [role="checkbox"]');
    return {
      rowIndex,
      creatorText: cells[indexes.creatorIndex]?.innerText || '',
      tagsText: indexes.tagsIndex >= 0 ? cells[indexes.tagsIndex]?.innerText || '' : '',
      gmv: cells[indexes.gmvIndex]?.innerText || '',
      hrefs: [...row.querySelectorAll('a[href]')].map(link => link.getAttribute('href') || ''),
      selectable: Boolean(checkbox)
        && !checkbox.disabled
        && checkbox.getAttribute('aria-disabled') !== 'true'
        && !checkbox.closest('[aria-disabled="true"]'),
    };
  }), { creatorIndex, tagsIndex, gmvIndex });
  const result = rawRows.filter(Boolean).map(raw => {
    const lines = raw.creatorText.split(/\r?\n/).map(text => text.trim()).filter(Boolean);
    return {
      rowIndex: raw.rowIndex,
      creatorId: raw.hrefs.map(creatorIdFromHref).find(Boolean) || '',
      handle: lines[0] || '',
      gmv: raw.gmv,
      tags: raw.tagsText.split(/[\s,|]+/).map(tag => tag.trim()).filter(tag => /^(GEN|VIP)[1-9]\d*$/i.test(tag)),
      selectable: raw.selectable,
    };
  });
  if (!result.length) throw new Error('현재 페이지에서 creator 행을 읽지 못했습니다.');
  return { table, dataRows, rows: result };
}

function rowsFingerprint(rows) {
  return rows.map(row => hashIdentity(identityForRow(row))).join('|');
}

async function selectRows(snapshot, selected) {
  const selectedIndexes = new Set(selected.map(row => row.rowIndex));
  const selectableIndexes = new Set(snapshot.rows.filter(row => row.selectable).map(row => row.rowIndex));
  if (selectedIndexes.size === selectableIndexes.size && [...selectedIndexes].every(index => selectableIndexes.has(index))) {
    const headerCheckbox = snapshot.table.getByRole('checkbox').first();
    await headerCheckbox.evaluate(element => element.click());
    return;
  }
  for (const index of selectedIndexes) {
    const checkbox = snapshot.dataRows.nth(index).getByRole('checkbox').first();
    await checkbox.evaluate(element => element.click());
  }
}

async function clickVisibleButton(scope, names) {
  for (const name of names) {
    const button = scope.getByRole('button', { name, exact: true }).filter({ visible: true }).last();
    if (await button.count()) { await button.evaluate(element => element.click()); return; }
  }
  throw new Error(`버튼을 찾지 못했습니다: ${names.join(', ')}`);
}

async function enterBatchTagMode(page, timeoutMs) {
  const selectedStatus = page.getByText(/\d+\s+creators? selected/i).filter({ visible: true }).first();
  if (await selectedStatus.count()) return;
  await clickVisibleButton(page, ['Batch tag creators']);
  await selectedStatus.waitFor({ state: 'visible', timeout: timeoutMs });
  const table = await visibleCreatorTable(page, timeoutMs);
  await table.getByRole('checkbox').first().waitFor({ state: 'attached', timeout: timeoutMs });
}

async function exitBatchTagMode(page, timeoutMs) {
  const selectedStatus = page.getByText(/\d+\s+creators? selected/i).filter({ visible: true }).first();
  if (!(await selectedStatus.count())) return;
  await clickVisibleButton(page, ['Exit']);
  await page.getByRole('button', { name: 'Batch tag creators', exact: true })
    .filter({ visible: true }).first().waitFor({ state: 'visible', timeout: timeoutMs });
}

async function currentOverlay(page) {
  const candidates = [
    page.getByRole('dialog').filter({ visible: true }),
    page.locator('[data-tid="m4b_drawer"]').filter({ visible: true }),
    page.locator('.arco-modal, .core-modal').filter({ visible: true }),
  ];
  for (const group of candidates) {
    if (await group.count()) return group.last();
  }
  return null;
}

async function visibleOverlay(page, timeoutMs) {
  const current = await currentOverlay(page);
  if (current) return current;
  await page.getByText(/Create tag|Tag creators/i).filter({ visible: true }).last().waitFor({ state: 'visible', timeout: timeoutMs });
  const appeared = await currentOverlay(page);
  if (appeared) return appeared;
  throw new Error('태그 설정 창을 찾지 못했습니다.');
}

async function applyTag(page, tagName, timeoutMs, { create, requireNew = false }) {
  await clickVisibleButton(page, ['Batch add tags']);
  const dialog = await visibleOverlay(page, timeoutMs);
  await dialog.waitFor({ state: 'visible', timeout: timeoutMs });
  const input = dialog.locator('#tag_input_search_input').filter({ visible: true }).first();
  await input.waitFor({ state: 'visible', timeout: timeoutMs });
  await input.fill(tagName);
  let existingOption = null;
  if (create) {
    const createNew = dialog.getByRole('button', { name: /Create new tag/i }).filter({ visible: true }).last();
    try { await createNew.waitFor({ state: 'visible', timeout: Math.floor(timeoutMs / 2) }); }
    catch {
      if (await dialog.getByText(tagName, { exact: true }).filter({ visible: true }).count()) {
        if (requireNew) throw new Error(`${tagName} already exists outside this checkpoint; refusing to add creators.`);
        existingOption = dialog.getByText(tagName, { exact: true }).filter({ visible: true }).last();
        await existingOption.click();
      } else {
        throw new Error(`${tagName} 새 태그 생성 옵션을 찾지 못했습니다.`);
      }
    }
    if (!existingOption) await createNew.click();
  } else {
    existingOption = dialog.getByText(tagName, { exact: true }).filter({ visible: true }).last();
    await existingOption.waitFor({ state: 'visible', timeout: Math.floor(timeoutMs / 2) });
    await existingOption.click();
  }
  const addButton = dialog.getByRole('button', { name: 'Add', exact: true }).filter({ visible: true }).last();
  if (existingOption && !(await addButton.isEnabled())) {
    const optionRow = existingOption.locator('xpath=ancestor::*[.//input[@type="checkbox"]][1]');
    const checkbox = optionRow.getByRole('checkbox').first();
    if (await checkbox.count() && !(await checkbox.isChecked())) await checkbox.evaluate(element => element.click());
  }
  const started = Date.now();
  while (Date.now() - started < timeoutMs && !(await addButton.isEnabled())) await page.waitForTimeout(100);
  if (!(await addButton.isEnabled())) throw new Error(`${tagName} 선택 후 Add 버튼이 활성화되지 않았습니다.`);
  await addButton.click();
  await dialog.waitFor({ state: 'hidden', timeout: timeoutMs });
  await enterBatchTagMode(page, timeoutMs);
}

async function applyNewTag(page, tagName, timeoutMs) {
  return applyTag(page, tagName, timeoutMs, { create: true });
}

async function verifyTagOnCurrentPage(page, selected, tagName, timeoutMs) {
  const expected = new Set(selected.map(row => hashIdentity(identityForRow(row))));
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const current = await readCreatorRows(page, timeoutMs);
    const verified = current.rows.filter(row => expected.has(hashIdentity(identityForRow(row))) && row.tags.includes(tagName)).length;
    if (verified === expected.size) return true;
    await page.waitForTimeout(1_000);
  }
  return false;
}

async function nextPage(page, previousRows, timeoutMs) {
  const selectors = ['.arco-pagination-item-next', '[class*="pagination-item-next"]'];
  let next;
  for (const selector of selectors) {
    const candidate = page.locator(selector).filter({ visible: true }).last();
    if (await candidate.count()) { next = candidate; break; }
  }
  if (!next) return false;
  const classes = await next.getAttribute('class') || '';
  if (/disabled/i.test(classes) || await next.getAttribute('aria-disabled') === 'true') return false;
  const before = rowsFingerprint(previousRows);
  await exitBatchTagMode(page, timeoutMs);
  await next.evaluate(element => element.click());
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await page.waitForTimeout(250);
    try {
      const current = await readCreatorRows(page, Math.min(timeoutMs, 5_000));
      if (rowsFingerprint(current.rows) !== before) {
        await enterBatchTagMode(page, timeoutMs);
        return true;
      }
    } catch { /* Table can be between pages. */ }
  }
  throw new Error('다음 페이지로 이동했지만 creator 목록이 바뀌지 않았습니다.');
}

async function openManagedPage(context, options) {
  const pages = context.pages();
  const page = pages[0] || await context.newPage();
  page.setDefaultTimeout(options.timeoutMs);
  await page.goto(creatorManagementUrl(options), { waitUntil: 'domcontentloaded' });
  await visibleCreatorTable(page, options.timeoutMs);
  await setFiftyPerPage(page);
  await enterBatchTagMode(page, options.timeoutMs);
  return page;
}

async function readPageNumber(page, targetPage, timeoutMs) {
  let currentPage = 1;
  let snapshot = await readCreatorRows(page, timeoutMs);
  while (currentPage < targetPage) {
    if (!(await nextPage(page, snapshot.rows, timeoutMs))) throw new Error(`${targetPage}페이지에 도달하지 못했습니다.`);
    currentPage += 1;
    snapshot = await readCreatorRows(page, timeoutMs);
  }
  return snapshot;
}

async function activePageNumber(page) {
  const active = page.locator('.arco-pagination-item-active, [class*="pagination-item-active"]').filter({ visible: true }).last();
  if (!(await active.count())) return 1;
  const value = Number((await active.textContent() || '').trim());
  return Number.isInteger(value) && value > 0 ? value : 1;
}

async function seekToPage(page, targetPage, timeoutMs) {
  await exitBatchTagMode(page, timeoutMs);
  let current = await activePageNumber(page);
  if (current > targetPage) throw new Error(`현재 ${current}페이지에서 이전 ${targetPage}페이지로 빠른 이동할 수 없습니다.`);
  const next = page.locator('.arco-pagination-item-next, [class*="pagination-item-next"]').filter({ visible: true }).last();
  while (current < targetPage) {
    const before = current;
    const forwardFive = page.locator('[aria-label="Go forward 5 pages"]').filter({ visible: true }).last();
    if (targetPage - current >= 5 && await forwardFive.count()) await forwardFive.evaluate(element => element.click());
    else await next.evaluate(element => element.click());
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      await page.waitForTimeout(100);
      current = await activePageNumber(page);
      if (current > before) break;
    }
    if (current <= before) throw new Error(`${targetPage}페이지 빠른 이동 중 ${before}페이지에서 멈췄습니다.`);
  }
  await visibleCreatorTable(page, timeoutMs);
  await enterBatchTagMode(page, timeoutMs);
  return readCreatorRows(page, timeoutMs);
}

function skipCounts(skipped) {
  return Object.fromEntries(Object.entries(skipped).map(([key, rows]) => [key, rows.length]));
}

async function runPass({ page, state, options, mutate, coverageOnly = false }) {
  let pageNumber = options.startPage || 1;
  let pagesVisited = 0;
  let newlyTagged = 0;
  let unavailableWithoutGen = 0;
  let reachedEnd = false;
  let snapshot = options.startPage && options.startPage > 1
    ? await seekToPage(page, options.startPage, options.timeoutMs)
    : await readCreatorRows(page, options.timeoutMs);
  while (true) {
    pagesVisited += 1;
    const classified = classifyCreatorRows(snapshot.rows, {
      seenHashes: new Set(),
      includeManagedCreators: true,
      includeExistingGen: false,
    });
    const counts = skipCounts(classified.skipped);
    if (coverageOnly) unavailableWithoutGen += counts.unavailable || 0;
    process.stdout.write(`${JSON.stringify({ page: pageNumber, mode: coverageOnly ? 'coverage' : 'full-page', selectable: classified.selected.length, ...counts })}\n`);
    if (mutate && classified.selected.length > 0) {
      const tagName = genTagName(state.next_tag_number);
      await selectRows(snapshot, classified.selected);
      await applyNewTag(page, tagName, options.timeoutMs);
      if (!(await verifyTagOnCurrentPage(page, classified.selected, tagName, options.timeoutMs))) {
        throw new Error(`${tagName} 적용 후 현재 페이지에서 Handle과 태그를 검증하지 못했습니다.`);
      }
      recordCompletedTag(state, {
        tagName,
        sourcePage: pageNumber,
        identityHashes: classified.selected.map(row => row.identityHash),
        skipped: counts,
        note: `Playwright ${coverageOnly ? 'coverage' : 'full-page'} batch; pass=${state.passes_completed + 1}`,
      });
      await writeJsonAtomic(options.stateFile, state);
      newlyTagged += classified.selected.length;
      process.stdout.write(`${tagName}: ${classified.selected.length}명 검증 완료\n`);
    }

    if (options.maxPages && pagesVisited >= options.maxPages) break;
    try {
      if (!(await nextPage(page, snapshot.rows, options.timeoutMs))) { reachedEnd = true; break; }
    } catch (error) {
      if (!options['--continue-on-error']) throw error;
      process.stderr.write(`PAGE ${pageNumber} ERROR: ${error.message}\n`);
      break;
    }
    pageNumber += 1;
    snapshot = await readCreatorRows(page, options.timeoutMs);
  }
  return { pagesVisited, newlyTagged, unavailableWithoutGen, reachedEnd };
}

function maxGenNumberOnRows(rows) {
  let maximum = 0;
  for (const row of rows) {
    for (const tag of row.tags || []) maximum = Math.max(maximum, tagNumber(tag, 'GEN') || 0);
  }
  return maximum;
}

async function scanIncrementalCandidates(page, options) {
  let pageNumber = 1;
  let pagesScanned = 0;
  let reachedEnd = false;
  let maxExistingGen = 0;
  let untaggedCreators = 0;
  const seenHashes = new Set();
  let snapshot = await readCreatorRows(page, options.timeoutMs);
  while (true) {
    pagesScanned += 1;
    maxExistingGen = Math.max(maxExistingGen, maxGenNumberOnRows(snapshot.rows));
    const classified = classifyCreatorRows(snapshot.rows, { seenHashes, includeManagedCreators: true });
    for (const row of classified.selected) seenHashes.add(row.identityHash);
    untaggedCreators += classified.selected.length;
    process.stdout.write(`${JSON.stringify({ incremental_page: pageNumber, untagged: classified.selected.length, max_existing_gen: maxExistingGen })}\n`);
    if (options.maxPages && pagesScanned >= options.maxPages) break;
    if (!(await nextPage(page, snapshot.rows, options.timeoutMs))) { reachedEnd = true; break; }
    pageNumber += 1;
    snapshot = await readCreatorRows(page, options.timeoutMs);
  }
  return {
    complete_scan: reachedEnd,
    pages_scanned: pagesScanned,
    untagged_creators: untaggedCreators,
    max_existing_gen: maxExistingGen,
    next_tag: genTagName(maxExistingGen + 1),
  };
}

function openIncrementalTag(state) {
  return state.tags.find(tag => tag.tag_name === genTagName(state.next_tag_number) && tag.status === 'OPEN') || null;
}

async function runIncrementalPass({ page, state, options }) {
  let pageNumber = 1;
  let pagesVisited = 0;
  let newlyTagged = 0;
  let reachedEnd = false;
  let snapshot = await readCreatorRows(page, options.timeoutMs);

  while (true) {
    pagesVisited += 1;
    while (true) {
      const classified = classifyCreatorRows(snapshot.rows, {
        seenHashes: new Set(state.seen_hashes),
        includeManagedCreators: true,
      });
      if (!classified.selected.length) break;

      const currentTag = genTagName(state.next_tag_number);
      const open = openIncrementalTag(state);
      const remainingCapacity = 50 - Number(open?.actual_count || 0);
      const selected = classified.selected.slice(0, remainingCapacity);
      await selectRows(snapshot, selected);
      await applyTag(page, currentTag, options.timeoutMs, { create: !open });
      if (!(await verifyTagOnCurrentPage(page, selected, currentTag, options.timeoutMs))) {
        throw new Error(`${currentTag} 증분 적용 후 현재 페이지 검증에 실패했습니다.`);
      }
      recordIncrementalTagPart(state, {
        tagName: currentTag,
        sourcePage: pageNumber,
        identityHashes: selected.map(row => row.identityHash),
      });
      newlyTagged += selected.length;
      if (openIncrementalTag(state).actual_count === 50) closeIncrementalTag(state);
      await writeJsonAtomic(options.stateFile, state);
      process.stdout.write(`${currentTag}: 증분 ${selected.length}명 적용, 누적 ${state.tags.at(-1).actual_count}명 검증 완료\n`);
      snapshot = await readCreatorRows(page, options.timeoutMs);
    }

    if (options.maxPages && pagesVisited >= options.maxPages) break;
    if (!(await nextPage(page, snapshot.rows, options.timeoutMs))) { reachedEnd = true; break; }
    pageNumber += 1;
    snapshot = await readCreatorRows(page, options.timeoutMs);
  }

  if (reachedEnd) {
    if (openIncrementalTag(state)) closeIncrementalTag(state);
    state.status = 'COMPLETE';
    state.updated_at = new Date().toISOString();
    await writeJsonAtomic(options.stateFile, state);
  } else {
    state.status = 'PAUSED';
    state.updated_at = new Date().toISOString();
    await writeJsonAtomic(options.stateFile, state);
  }
  return { pagesVisited, newlyTagged, reachedEnd };
}

async function summarizeIncrementalState(state) {
  return {
    status: state.status,
    next_tag: genTagName(state.next_tag_number),
    tags_completed: state.tags.filter(tag => tag.status === 'COMPLETE').length,
    open_tag: openIncrementalTag(state)?.tag_name || null,
    tagged: state.totals.tagged,
    plan: state.plan,
  };
}

async function summarizeState(state) {
  return {
    status: state.status,
    next_tag: genTagName(state.next_tag_number),
    passes_completed: state.passes_completed,
    tags_completed: state.tags.length,
    ...state.totals,
  };
}

export async function runGenTagging(args) {
  const options = parseOptions(args);
  if (options.command === 'status') return summarizeState(await readJson(options.stateFile));
  if (options.command === 'incremental-status') return summarizeIncrementalState(await readJson(options.stateFile));
  if (options.command === 'audit') return auditGenTaggingState(await readJson(options.stateFile));
  if (options.command === 'finalize') {
    const state = await readJson(options.stateFile);
    const audit = auditGenTaggingState(state);
    if (!audit.ok) throw new Error(`감사 실패로 finalize할 수 없습니다: ${audit.errors.join('; ')}`);
    const acceptedFirstPass = state.status === 'VERIFYING'
      && state.passes_completed >= 1
      && options['--accept-first-pass'];
    if (state.status !== 'COMPLETE' && !acceptedFirstPass) {
      throw new Error(`COMPLETE 상태가 아니면 --accept-first-pass로 검증 순회 생략을 명시해야 합니다: ${state.status}`);
    }
    state.tags = state.tags.map(tag => ({
      ...tag,
      membership_hash: hashIdentity([...(tag.identity_hashes || [])].sort().join('|')),
      identity_hashes: undefined,
    }));
    state.seen_hashes = [];
    state.status = 'FINALIZED';
    state.finalization_basis = acceptedFirstPass ? 'FIRST_PASS_ACCEPTED' : 'FULL_COVERAGE_PASS';
    state.finalized_at = new Date().toISOString();
    state.updated_at = state.finalized_at;
    await writeJsonAtomic(options.stateFile, state);
    return { finalized: true, state: options.stateFile, tags: audit.tags, tagged: audit.tagged };
  }

  const context = await launchProfile(options.profileDir);
  try {
    if (options.command === 'login') {
      const pages = context.pages();
      const page = pages[0] || await context.newPage();
      await page.goto(creatorManagementUrl(options), { waitUntil: 'domcontentloaded' });
      await waitForEnter('Manage creators 화면이 열렸습니다. 로그인/OTP 확인이 끝났다면');
      return { logged_in: true, profile: options.profileDir };
    }
    const page = await openManagedPage(context, options);

    if (options.command === 'reconcile-next') {
      if (!options.page || !options.expectedCount) throw new Error('reconcile-next에는 --page와 --expected-count가 필요합니다.');
      const state = await readJson(options.stateFile);
      if (state.workflow !== 'GEN_PLAYWRIGHT_TAGGING') throw new Error('전체 GEN 태깅 체크포인트가 아닙니다.');
      const tagName = genTagName(state.next_tag_number);
      const snapshot = await readPageNumber(page, options.page, options.timeoutMs);
      const matching = snapshot.rows.filter(row => row.tags.includes(tagName));
      if (matching.length !== options.expectedCount) {
        throw new Error(`${options.page}페이지의 ${tagName} 확인 인원 ${matching.length}명이 예상 ${options.expectedCount}명과 다릅니다.`);
      }
      recordCompletedTag(state, {
        tagName,
        sourcePage: options.page,
        identityHashes: matching.map(row => hashIdentity(identityForRow(row))),
        skipped: {},
        note: 'Recovered from verified TikTok UI after uncertain post-apply verification',
      });
      state.status = 'PAUSED';
      await writeJsonAtomic(options.stateFile, state);
      return { reconciled: tagName, page: options.page, count: matching.length, next_tag: genTagName(state.next_tag_number) };
    }

    if (options.command === 'incremental-plan') {
      const plan = await scanIncrementalCandidates(page, options);
      if (options['--replace']) {
        const state = createIncrementalGenTaggingState({
          shopId: options.shopId,
          shopRegion: options.shopRegion,
          nextTagNumber: plan.max_existing_gen + 1,
          plan: { ...plan, planned_at: new Date().toISOString() },
        });
        await writeJsonAtomic(options.stateFile, state);
      }
      return { mode: 'READ_ONLY_INCREMENTAL', ...plan, checkpoint_written: Boolean(options['--replace']) };
    }

    if (options.command === 'incremental-run') {
      if (!options['--apply']) throw new Error('실제 증분 태깅에는 --apply가 필요합니다. 먼저 incremental-plan --replace를 실행하세요.');
      const state = await readJson(options.stateFile);
      if (state.workflow !== 'GEN_PLAYWRIGHT_INCREMENTAL') throw new Error('증분 GEN 체크포인트가 아닙니다.');
      if (!state.plan?.complete_scan) throw new Error('전체 페이지를 읽은 증분 계획만 실행할 수 있습니다. --max-pages 없이 incremental-plan --replace를 실행하세요.');
      if (state.status === 'COMPLETE') throw new Error('이 증분 작업은 이미 완료됐습니다. 새 계획을 만드세요.');
      await confirmExact(`APPLY INCREMENTAL GEN TAGS FROM ${genTagName(state.next_tag_number)}`);
      const result = await runIncrementalPass({ page, state, options });
      return { ...(await summarizeIncrementalState(state)), result, audit: auditGenTaggingState(state) };
    }

    let state;
    if (options['--replace']) {
      if (options.command !== 'plan') throw new Error('--replace는 새 작업의 gen:tags:plan에서만 사용할 수 있습니다.');
      state = createGenTaggingState({ shopId: options.shopId, shopRegion: options.shopRegion });
      await writeJsonAtomic(options.stateFile, state);
    } else {
      try { state = await readJson(options.stateFile); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        state = createGenTaggingState({ shopId: options.shopId, shopRegion: options.shopRegion });
        await writeJsonAtomic(options.stateFile, state);
      }
    }
    if (state.shop_id !== options.shopId) throw new Error(`체크포인트 shop_id가 다릅니다: ${state.shop_id}`);

    if (options.command === 'plan') {
      const result = await runPass({ page, state, options: { ...options, maxPages: options.maxPages || 1 }, mutate: false });
      return { mode: 'READ_ONLY', ...result, next_tag: genTagName(state.next_tag_number) };
    }
    if (!options['--apply']) throw new Error('실제 태깅에는 --apply가 필요합니다. 먼저 gen:tags:plan을 실행하세요.');
    if (state.status === 'FINALIZED' || state.status === 'COMPLETE') {
      throw new Error(`현재 체크포인트가 ${state.status}입니다. 새 재구성은 gen:tags:plan -- --replace로 시작하세요.`);
    }
    await confirmExact(`APPLY GEN TAGS FROM ${genTagName(state.next_tag_number)}`);

    const passResults = [];
    for (let pass = 0; pass < options.passes; pass += 1) {
      if (pass > 0) {
        await page.goto(creatorManagementUrl(options), { waitUntil: 'domcontentloaded' });
        await visibleCreatorTable(page, options.timeoutMs);
        await setFiftyPerPage(page);
        await enterBatchTagMode(page, options.timeoutMs);
      }
      const coverageOnly = state.passes_completed >= 1;
      const result = await runPass({ page, state, options, mutate: true, coverageOnly });
      passResults.push(result);
      if (result.reachedEnd) state.passes_completed += 1;
      if (coverageOnly && result.reachedEnd) {
        state.last_coverage = {
          checked_at: new Date().toISOString(),
          untagged_selectable_found: result.newlyTagged,
          untagged_unavailable: result.unavailableWithoutGen,
        };
      }
      if (coverageOnly && result.reachedEnd && result.newlyTagged === 0 && result.unavailableWithoutGen === 0) state.status = 'COMPLETE';
      else if (coverageOnly && result.reachedEnd && result.newlyTagged === 0 && result.unavailableWithoutGen > 0) state.status = 'NEEDS_REVIEW';
      else state.status = result.reachedEnd ? 'VERIFYING' : 'PAUSED';
      state.updated_at = new Date().toISOString();
      await writeJsonAtomic(options.stateFile, state);
      if (options.maxPages) break;
    }
    return { ...(await summarizeState(state)), pass_results: passResults, audit: auditGenTaggingState(state) };
  } finally {
    await context.close();
  }
}

export { visibleCreatorTable, setFiftyPerPage, enterBatchTagMode, exitBatchTagMode, applyTag, activePageNumber, seekToPage };

if (process.argv[1] && path.resolve(process.argv[1]) === scriptFile) {
  try { process.stdout.write(JSON.stringify(await runGenTagging(process.argv.slice(2)), null, 2) + '\n'); }
  catch (error) { process.stderr.write(`ERROR: ${error.message}\n`); process.exitCode = 1; }
}
