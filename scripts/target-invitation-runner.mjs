#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { defaultProfile, launchProfile } from './browser-profile.mjs';
import { configureInvitationProducts, verifyInvitationProducts } from './invitation-products.mjs';
import { kstDate } from './lv4-vvip-core.mjs';
import {
  DEFAULT_INVITATION_SHARE_MESSAGE,
  classifyMessageOutcomes,
  hasMessageRestriction,
  createInvitationPlan,
  invitationPreparationRetryDecision,
  invitationConfirmation,
  messageReinviteDecision,
  messageVerificationTarget,
  parseCreatorCount,
  parseCreatorSelectionProgress,
  recoverInterruptedStates,
  refreshPlanSummary,
  summarizeCreatorPageSelection,
  upgradeInvitationCheckpoint,
  validateSelectableCreatorCount,
  validateRecipientSelection,
  validateInvitationText,
  verifyInvitationText,
} from './target-invitation-core.mjs';

const scriptFile = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(scriptFile), '..');
const defaultCheckpoint = path.join(root, '.local', 'target-invitations', 'current.json');
const defaultTagState = path.join(root, '.local', 'gen-tagging', 'current.json');
const defaultEvidence = path.join(root, '.local', 'target-invitations', 'evidence');
const collaborationListUrl = 'https://affiliate-global.tiktok.com/affiliate/collaboration/target-invitation?shop_region=US';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseInteger(value, label, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  assert(Number.isInteger(parsed) && parsed >= min && parsed <= max, `${label}은 ${min}~${max} 범위의 정수여야 합니다.`);
  return parsed;
}

export function parseOptions(args) {
  const command = args[0];
  assert(['login', 'plan', 'run', 'status'].includes(command), '명령은 login, plan, run, status 중 하나여야 합니다.');
  const valueFlags = new Set([
    '--from', '--to', '--max-tags', '--invitation-name', '--valid-until', '--template-id', '--shop-id',
    '--shop-region', '--checkpoint', '--tag-state', '--profile-dir', '--evidence-dir', '--timeout-ms', '--tag-family',
  ]);
  const booleanFlags = new Set([
    '--replace', '--apply', '--stop-on-error', '--retry-failed', '--retry-uncertain', '--share-message', '--fail-fast',
  ]);
  const raw = { command };
  for (let index = 1; index < args.length; index += 1) {
    const key = args[index];
    if (booleanFlags.has(key)) {
      assert(!Object.hasOwn(raw, key), `중복 옵션: ${key}`);
      raw[key] = true;
      continue;
    }
    const value = args[index + 1];
    assert(valueFlags.has(key) && value != null && !value.startsWith('--'), `잘못된 옵션: ${key}`);
    assert(!Object.hasOwn(raw, key), `중복 옵션: ${key}`);
    raw[key] = value;
    index += 1;
  }
  if (command === 'plan') {
    for (const key of ['--from', '--to', '--invitation-name', '--valid-until', '--template-id', '--shop-id']) {
      assert(raw[key], `plan에는 ${key}가 필요합니다.`);
    }
  }
  if (command === 'run') assert(raw['--apply'], '실제 전송에는 --apply가 필요합니다.');
  const tagFamily = String(raw['--tag-family'] || (/^lv(?:[34]up|4only)/i.exec(raw['--from'] || '')?.[0] || 'GEN')).toLowerCase();
  assert(['gen', 'lv3up', 'lv4up', 'lv4only'].includes(tagFamily), '--tag-family는 GEN, lv3up, lv4up 또는 lv4only이어야 합니다.');
  if (raw['--from']) assert(raw['--from'].toLowerCase().startsWith(tagFamily), '--from과 --tag-family가 다릅니다.');
  const levelCohort = tagFamily !== 'gen';
  const outreachFolder = path.join(root, '.local', levelCohort ? `target-invitations-${tagFamily}` : 'target-invitations');
  return {
    ...raw,
    tagFamily,
    checkpoint: path.resolve(raw['--checkpoint'] || (levelCohort ? path.join(outreachFolder, 'current.json') : defaultCheckpoint)),
    tagState: path.resolve(raw['--tag-state'] || (levelCohort ? path.join(root, '.local', `${tagFamily}-tagging`, 'current.json') : defaultTagState)),
    profileDir: path.resolve(raw['--profile-dir'] || defaultProfile),
    evidenceDir: path.resolve(raw['--evidence-dir'] || (levelCohort ? path.join(outreachFolder, 'evidence') : defaultEvidence)),
    timeoutMs: raw['--timeout-ms'] ? parseInteger(raw['--timeout-ms'], '--timeout-ms', { min: 5_000, max: 120_000 }) : 30_000,
    maxTags: raw['--max-tags'] ? parseInteger(raw['--max-tags'], '--max-tags') : null,
  };
}

async function pathExists(file) {
  try { await fs.access(file); return true; }
  catch { return false; }
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const pending = `${file}.${process.pid}.pending`;
  await fs.writeFile(pending, JSON.stringify(value, null, 2) + '\n');
  await fs.rename(pending, file);
}

async function askExact(expected) {
  assert(process.stdin.isTTY, `대화형 터미널에서 확인 문구가 필요합니다: ${expected}`);
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  let answer;
  try { answer = await terminal.question(`실제 TikTok 초대 전송을 시작하려면 정확히 "${expected}"를 입력하세요: `); }
  finally { terminal.close(); }
  assert(answer === expected, '확인 문구가 일치하지 않아 전송을 시작하지 않았습니다.');
}

async function waitForEnter(message) {
  assert(process.stdin.isTTY, `${message} 대화형 터미널에서 실행하세요.`);
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { await terminal.question(`${message}\n완료 후 Enter를 누르세요. `); }
  finally { terminal.close(); }
}

function currentDurationText(estimate) {
  const format = seconds => {
    const minutes = Math.ceil(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const remainder = minutes % 60;
    return hours ? `${hours}시간 ${remainder}분` : `${minutes}분`;
  };
  return `${format(estimate.min_seconds)}~${format(estimate.max_seconds)}`;
}

async function runPlan(options) {
  if (await pathExists(options.checkpoint)) {
    assert(options['--replace'], `체크포인트가 이미 있습니다. 새 계획은 --replace가 필요합니다: ${options.checkpoint}`);
  }
  const tagState = await readJson(options.tagState);
  const state = createInvitationPlan({
    tagState,
    from: options['--from'],
    to: options['--to'],
    maxTags: options.maxTags,
    invitationName: options['--invitation-name'],
    validUntil: options['--valid-until'],
    templateId: options['--template-id'],
    shopId: options['--shop-id'],
    shopRegion: options['--shop-region'] || 'US',
    shareToIm: Boolean(options['--share-message']),
  });
  refreshPlanSummary(state);
  await writeJsonAtomic(options.checkpoint, state);
  process.stdout.write(JSON.stringify({
    status: state.status,
    range: `${state.config.from}-${state.config.to}`,
    tags: state.tags.length,
    creators: state.tags.reduce((sum, item) => sum + item.expected_count, 0),
    invitation_name: state.config.invitation_name,
    valid_until: state.config.valid_until,
    overlap_policy: state.config.overlap_policy,
    share_to_im: state.config.share_to_im,
    estimated_time: currentDurationText(state.estimate),
    checkpoint: options.checkpoint,
  }, null, 2) + '\n');
  return state;
}

async function visibleExactText(page, text) {
  const matches = await page.getByText(text, { exact: true }).all();
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    if (await matches[index].isVisible()) return matches[index];
  }
  throw new Error(`화면에서 정확한 항목을 찾지 못했습니다: ${text}`);
}

export async function selectDate(page, dateInput) {
  const [month, day, year] = dateInput.split('/').map(Number);
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const input = page.getByPlaceholder('End date').first();
  await input.click();

  // The current TikTok picker renders zero-padded days in div cells and opens
  // on its own displayed month, which need not match the host's current month.
  const corePicker = page.locator('.core-picker-container').filter({ visible: true }).last();
  await corePicker.waitFor({ state: 'visible', timeout: 1_500 }).catch(() => {});
  if (await corePicker.count()) {
    const header = corePicker.locator('.core-picker-header-value');
    for (let steps = 0; steps <= 24; steps += 1) {
      const match = /^(\d{1,2})\s*\/\s*(\d{4})$/.exec((await header.innerText()).trim());
      assert(match, '달력의 표시 연·월을 읽지 못했습니다.');
      const shownMonth = Number(match[1]), shownYear = Number(match[2]);
      const delta = (year - shownYear) * 12 + month - shownMonth;
      if (!delta) break;
      assert(steps < 24 && Math.abs(delta) <= 24, '달력 이동 범위가 24개월을 초과합니다.');
      const direction = delta > 0 ? 'right' : 'left';
      await corePicker.locator(`.core-picker-header-icon:has(svg.arco-icon-${direction})`).click();
      const next = new Date(Date.UTC(shownYear, shownMonth - 1 + Math.sign(delta), 1));
      const expected = new RegExp(`^${next.getUTCMonth() + 1}\\s*/\\s*${next.getUTCFullYear()}$`);
      await header.filter({ hasText: expected }).waitFor({ state: 'visible', timeout: 5_000 });
    }
    const cell = corePicker.locator('.core-picker-cell-in-view').filter({
      has: page.getByText(String(day).padStart(2, '0'), { exact: true }),
    });
    assert(await cell.count() === 1, `달력의 ${dateInput} 날짜 칸이 명확하지 않습니다.`);
    assert(!(await cell.evaluate(element => /disabled/.test(element.className)
      || element.getAttribute('aria-disabled') === 'true')), `달력에서 ${dateInput}을 선택할 수 없습니다.`);
    await cell.click();
    await page.waitForFunction(expected => [...document.querySelectorAll('input[placeholder="End date"]')]
      .some(element => element.getClientRects().length && element.value === expected), dateInput, { timeout: 5_000 });
    assert(await input.inputValue() === dateInput, '선택한 만료일이 요청과 다릅니다.');
    return;
  }

  const popup = page.locator('.arco-picker-container:visible, .arco-picker-popup:visible, [class*="picker-popup"]:visible').last();
  try { await popup.waitFor({ state: 'visible', timeout: 5_000 }); }
  catch { /* The exact-date selectors below may still be available in another popup wrapper. */ }

  const today = new Date();
  const monthDelta = (year - today.getFullYear()) * 12 + month - (today.getMonth() + 1);
  assert(monthDelta >= 0 && monthDelta <= 24, '만료일은 현재부터 24개월 이내의 미래 날짜여야 합니다.');

  const findDateCell = () => page.locator([
    `[data-date="${iso}"]`,
    `[data-value="${iso}"]`,
    `td[title="${iso}"]`,
    `time[datetime="${iso}"]`,
  ].join(', ')).filter({ visible: true }).last();

  if (!(await findDateCell().count())) {
    const calendar = (await popup.count()) ? popup : page.locator('body');
    for (let index = 0; index < monthDelta; index += 1) {
      const singleRight = calendar.locator([
        '.core-picker-header-icon:has(svg.arco-icon-right)',
        '.core-picker-header-icon:has(svg[class~="arco-icon-right"])',
        '.arco-picker-header-next-btn',
        '[class*="picker-header-next"]',
        '[class*="header-next"]',
        'button:has(svg.arco-icon-right)',
        'button:has(svg[class~="arco-icon-right"])',
      ].join(', '))
        .filter({ visible: true }).last();
      if (await singleRight.count()) await singleRight.click();
      else {
        const headerButtons = calendar.locator('.arco-picker-header button, [class*="picker-header"] button')
          .filter({ visible: true });
        assert(await headerButtons.count(), '달력의 다음 달 버튼을 찾지 못했습니다.');
        await headerButtons.last().click();
      }
      await page.waitForTimeout(120);
    }
  }

  let dateCell = findDateCell();
  if (await dateCell.count()) {
    await dateCell.click();
  } else {
    const calendar = (await popup.count()) ? popup : page.locator('body');
    const candidates = calendar.getByText(String(day), { exact: true }).filter({ visible: true });
    let clicked = false;
    for (let index = (await candidates.count()) - 1; index >= 0; index -= 1) {
      const candidate = candidates.nth(index);
      const disabled = await candidate.evaluate(element => {
        const cell = element.closest('td, [role="gridcell"], button') || element;
        return cell.getAttribute('aria-disabled') === 'true'
          || cell.hasAttribute('disabled')
          || /not-current|disabled|outside/.test(String(cell.className));
      });
      if (!disabled) {
        await candidate.click();
        clicked = true;
        break;
      }
    }
    assert(clicked, `달력에서 ${dateInput}을 선택하지 못했습니다.`);
  }
  await page.waitForTimeout(100);
  assert((await input.inputValue()) === dateInput, `만료일 입력값이 다릅니다: ${await input.inputValue()}`);
}

async function chooseExactTag(page, tagName) {
  const creatorTagsText = await visibleExactText(page, 'Creator tags');
  const tagControl = creatorTagsText.locator('xpath=..');
  await tagControl.click();
  const popup = page.locator('.core-select-popup-inner:visible').last();
  await popup.waitFor({ state: 'visible' });

  const input = tagControl.locator('input').last();
  if (await input.count()) await input.fill(tagName);
  else await page.keyboard.type(tagName);

  const exact = popup.getByText(tagName, { exact: true }).filter({ visible: true }).last();
  const startedAt = Date.now();
  const timeoutMs = 5_000;
  let scrolled = false;
  let refilled = false;
  while (Date.now() - startedAt < timeoutMs) {
    if (await exact.count()) {
      await exact.click();
      await page.keyboard.press('Escape');
      return;
    }

    const elapsedMs = Date.now() - startedAt;
    if (!scrolled && elapsedMs >= 1_000) {
      await popup.evaluate(element => {
        element.scrollTop = element.scrollHeight;
        element.dispatchEvent(new Event('scroll', { bubbles: true }));
      });
      scrolled = true;
    }
    if (!refilled && elapsedMs >= 2_500 && await input.count()) {
      await input.fill('');
      await input.fill(tagName);
      refilled = true;
    }
    await page.waitForTimeout(100);
  }
  throw new Error(`Creator tags 목록에서 ${tagName}을 5초 동안 찾지 못했습니다.`);
}

async function selectDrawerPageSize(page, drawer, target) {
  const label = `${target}/Page`;
  const current = drawer.getByText(/^(10|20|50)\/Page$/, { exact: true }).filter({ visible: true }).last();
  await current.waitFor({ state: 'visible' });
  if ((await current.innerText()).trim() === label) return false;
  const pageSizeControl = current.locator('xpath=../..');
  await pageSizeControl.evaluate(element => element.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(100);
  await pageSizeControl.evaluate(element => element.click());
  const option = page.getByText(label, { exact: true }).filter({ visible: true }).last();
  await option.waitFor({ state: 'visible' });
  await option.evaluate(element => element.scrollIntoView({ block: 'center' }));
  await option.evaluate(element => element.click());
  await drawer.getByText(label, { exact: true }).filter({ visible: true }).last()
    .waitFor({ state: 'visible' });
  await page.waitForTimeout(750);
  return true;
}

async function waitForStableTaggedRows(page, table, tagName, timeoutMs = 20_000) {
  const started = Date.now();
  let lastCount = 0;
  let stableSamples = 0;
  while (Date.now() - started < timeoutMs) {
    lastCount = await table.locator('tbody tr').evaluateAll(
      rows => rows.filter(row => row.getClientRects().length).length,
    );
    const matchingTagCells = await table.getByText(tagName, { exact: true }).filter({ visible: true }).count();
    if (lastCount >= 1 && matchingTagCells >= lastCount) {
      stableSamples += 1;
      if (stableSamples >= 5) return lastCount;
    } else {
      stableSamples = 0;
    }
    await page.waitForTimeout(250);
  }
  return lastCount;
}

async function waitForStableCreatorSelection(page, selectedText, beforeCount, timeoutMs = 5_000) {
  const startedAt = Date.now();
  let latest = beforeCount;
  let stableSamples = 0;
  while (Date.now() - startedAt < timeoutMs) {
    const current = parseCreatorCount(await selectedText.innerText(), 'creators selected');
    if (current === latest) stableSamples += 1;
    else {
      latest = current;
      stableSamples = 0;
    }
    if (current !== beforeCount && stableSamples >= 3) return current;
    await page.waitForTimeout(150);
  }
  return latest;
}

async function selectRemainingAvailableRows(page, table, selectedText, selectedCount) {
  const rows = table.locator('tbody tr');
  const rowCount = await rows.count();
  let currentCount = selectedCount;
  for (let index = 0; index < rowCount && currentCount < 50; index += 1) {
    const row = rows.nth(index);
    if (!(await row.isVisible())) continue;
    const checkbox = row.getByRole('checkbox').first();
    if (!(await checkbox.count())) continue;
    const disabled = await checkbox.isDisabled().catch(() => false);
    const checked = await checkbox.isChecked().catch(() => false);
    if (disabled || checked) continue;

    const before = currentCount;
    await checkbox.evaluate(element => element.click());
    const after = await waitForStableCreatorSelection(page, selectedText, before, 1_500);
    if (after > before) currentCount = after;
  }
  return currentCount;
}

async function tableFingerprint(table) {
  const rows = await table.locator('tbody tr').allTextContents();
  return rows.map(value => value.replace(/\s+/g, ' ').trim()).join('\n');
}

async function moveToNextCreatorPage(page, drawer, table, previousFingerprint) {
  const next = drawer.getByRole('listitem', { name: 'Next', exact: true }).filter({ visible: true }).last();
  await next.waitFor({ state: 'visible' });
  const disabled = await next.evaluate(element => {
    const ownClass = String(element.className || '');
    const parentClass = String(element.parentElement?.className || '');
    return element.getAttribute('aria-disabled') === 'true'
      || element.hasAttribute('disabled')
      || /disabled/i.test(`${ownClass} ${parentClass}`)
      || Boolean(element.querySelector('[aria-disabled="true"], [disabled], [class*="disabled"]'));
  });
  if (disabled) return false;
  await next.click();
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await page.waitForTimeout(250);
    const currentFingerprint = await tableFingerprint(table);
    if (currentFingerprint && currentFingerprint !== previousFingerprint) return true;
  }
  throw new Error('다음 creator 페이지가 20초 안에 로드되지 않았습니다.');
}

async function discardPartialCreatorSelection(page, drawer) {
  const cancel = drawer.getByRole('button', { name: 'Cancel', exact: true });
  if (await cancel.count()) await cancel.click({ force: true });

  const dialog = page.getByRole('dialog', { name: 'Discard changes?', exact: true }).filter({ visible: true }).last();
  try {
    await dialog.waitFor({ state: 'visible', timeout: 2_000 });
    await dialog.getByRole('button', { name: 'Discard', exact: true }).click();
  } catch (error) {
    if (await dialog.count()) throw error;
  }
  await drawer.waitFor({ state: 'hidden' });
}

async function addTagCreators(page, tagName, expectedCount) {
  const addFromManage = page.getByRole('button', { name: 'Add from Manage creators', exact: true });
  if (!(await addFromManage.isVisible())) {
    const chooseCreators = page.getByRole('button', { name: 'Choose creators', exact: true }).first();
    await chooseCreators.waitFor({ state: 'visible' });
    await chooseCreators.click();
  }
  let lastError = null;
  for (let drawerAttempt = 0; drawerAttempt < 3; drawerAttempt += 1) {
    await addFromManage.waitFor({ state: 'visible' });
    await addFromManage.click();
    const drawer = page.locator('[data-tid="m4b_drawer"]:visible').last();
    await drawer.getByText('Add from Manage creators', { exact: true }).last().waitFor({ state: 'visible' });
    await chooseExactTag(page, tagName);
    await page.waitForTimeout(750);
    await selectDrawerPageSize(page, drawer, 20);

    const table = drawer.getByRole('table').filter({ hasText: 'Avg. LIVE viewers' }).first();
    await table.waitFor({ state: 'visible' });
    const selectedText = drawer.getByText(/\d+\s*\/\s*50\s*creators selected/i).last();
    await selectedText.waitFor({ state: 'visible' });
    let selectedCount = 0;
    let selectionFailed = false;

    for (let pageIndex = 0; pageIndex < 3; pageIndex += 1) {
      const visibleRows = await waitForStableTaggedRows(page, table, tagName);
      if (visibleRows < 1) {
        lastError = new Error(`${tagName} ${pageIndex + 1}페이지에서 선택 가능한 creator를 찾지 못했습니다.`);
        selectionFailed = true;
        break;
      }

      const beforeCount = parseCreatorCount(await selectedText.innerText(), 'creators selected');
      const headerCheckbox = table.getByRole('checkbox').first();
      await headerCheckbox.evaluate(element => element.scrollIntoView({ block: 'center' }));
      await headerCheckbox.evaluate(element => element.click());
      selectedCount = await waitForStableCreatorSelection(page, selectedText, beforeCount);
      const maximumAfterPage = Math.min(50, beforeCount + visibleRows);
      if (selectedCount < maximumAfterPage) {
        selectedCount = await selectRemainingAvailableRows(page, table, selectedText, selectedCount);
      }

      let pageSelection;
      try {
        pageSelection = summarizeCreatorPageSelection(beforeCount, selectedCount, visibleRows);
      } catch (error) {
        lastError = new Error(`${tagName} ${pageIndex + 1}페이지 ${error.message}`);
        selectionFailed = true;
        break;
      }
      if (!pageSelection.progressed) {
        lastError = new Error(
          `${tagName} ${pageIndex + 1}페이지에서 선택 인원이 증가하지 않았습니다: ${beforeCount} -> ${selectedCount}`,
        );
        selectionFailed = true;
        break;
      }

      if (pageSelection.unavailable > 0) {
        process.stderr.write(
          `[${tagName}] page ${pageIndex + 1}: 화면 ${visibleRows}행 중 `
          + `${pageSelection.gained}명 선택, ${pageSelection.unavailable}명 미선택 상태로 계속합니다.\n`,
        );
      }

      process.stdout.write(
        `[${tagName}] CREATOR SELECT ${selectedCount}/50 `
        + `(page ${pageIndex + 1}, checkpoint expected ${expectedCount})\n`,
      );
      if (selectedCount >= 50) break;
      const fingerprint = await tableFingerprint(table);
      let moved;
      try {
        moved = await moveToNextCreatorPage(page, drawer, table, fingerprint);
      } catch (error) {
        lastError = error;
        selectionFailed = true;
        break;
      }
      if (!moved) break;
    }

    if (!selectionFailed && selectedCount >= 1 && selectedCount <= 50) {
      validateSelectableCreatorCount(selectedCount);
      if (selectedCount !== expectedCount) {
        process.stdout.write(
          `[${tagName}] 현재 선택 가능 인원 ${selectedCount}명으로 진행합니다 `
          + `(체크포인트 예상 ${expectedCount}명)\n`,
        );
      }
      await drawer.getByRole('button', { name: 'Add', exact: true }).click();
      await drawer.waitFor({ state: 'hidden' });
      return selectedCount;
    }

    process.stderr.write(
      `[${tagName}] ${lastError.message}; 20/Page 누적 선택을 처음부터 재시도합니다 `
      + `(${drawerAttempt + 1}/3)\n`,
    );
    await discardPartialCreatorSelection(page, drawer);
  }
  throw lastError || new Error(`${tagName} creator 선택을 완료하지 못했습니다.`);
}

async function moveInvitationOverlaps(page, selectedCount, config = {}) {
  const banner = page.getByText(/\d+ creators cannot be invited/i).first();
  try { await banner.waitFor({ state: 'visible', timeout: 3_500 }); }
  catch { return 0; }
  const overlapCount = Number(/(\d+)/.exec(await banner.innerText())?.[1] || 0);
  assert(overlapCount >= 1 && overlapCount <= selectedCount, `중복 인원을 읽지 못했습니다: ${overlapCount}`);

  await page.getByRole('button', { name: 'Resolve overlaps', exact: true }).click();
  const move = page.getByRole('radio', { name: /Move creators to this invitation/i });
  await move.waitFor({ state: 'attached' });
  if (!(await move.isChecked())) await move.evaluate(element => element.click());
  assert(await move.isChecked(), '중복 처리 옵션을 Move로 선택하지 못했습니다.');
  await page.getByRole('button', { name: 'Resolve', exact: true }).click();
  await page.getByText(new RegExp(`Move ${overlapCount} creators to this invitation\\?`, 'i')).waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Move', exact: true }).click();
  const timeoutMs = Math.max(1_000, Number(config.overlap_resolution_timeout_ms || 5_000));
  try {
    await banner.waitFor({ state: 'hidden', timeout: timeoutMs });
  } catch {
    throw new Error(
      `OVERLAP_RESOLUTION_STALE: ${overlapCount} creators cannot be invited 경고가 `
      + `${Math.round(timeoutMs / 1_000)}초 안에 사라지지 않았습니다.`,
    );
  }
  return overlapCount;
}

export async function applyInvitationText(page, text) {
  if (text == null) return;
  const expected = validateInvitationText(text);
  const input = page.locator('#target_complete_details_message_input');
  const limit = await input.evaluate(element => element.maxLength);
  assert(limit < 0 || expected.length <= limit, `Invitation text가 화면의 ${limit}자 한도를 초과합니다.`);
  await input.fill(expected);
  const proof = verifyInvitationText(expected, await input.inputValue());
  if (proof.emoji_removed) process.stdout.write('[OUTREACH] Invitation editor removed unsupported emoji; all other text verified.\n');
  return proof;
}

export async function waitInvitationEditorReady(page,config){
  if(!config.products)return;
  const table=page.getByRole('table').filter({hasText:'Standard commission rate'}).filter({visible:true});
  if(!await table.count())await page.getByText('Choose products',{exact:true}).last().click();
  await table.waitFor({state:'visible'});
  const anchors=config.products.map(p=>`tbody input[type="checkbox"][value="${p.id}"]`).join(', ');
  await table.locator(anchors).first().waitFor({state:'attached',timeout:60000});
  await page.waitForFunction(()=>Boolean(document.querySelector('#target_complete_details_message_input')?.value.trim()),null,{timeout:60000});
}

export async function verifyInvitationFields(page,config){
  assert(await page.getByPlaceholder('Invitation name').inputValue()===config.invitation_name,'OFFER_MISMATCH: 초대 이름이 변경됐습니다.');
  assert(await page.getByPlaceholder('End date').first().inputValue()===config.valid_until,'OFFER_MISMATCH: 만료일이 변경됐습니다.');
  if(config.invitation_text!=null)return verifyInvitationText(config.invitation_text,await page.locator('#target_complete_details_message_input').inputValue());
}

export async function configureInvitationOffer(page, config) {
  let productProof;
  const standardRate = Number(config.commission_rate ?? 30);
  const shopAdsRate = Number(config.shop_ads_commission_rate ?? 15);
  if(config.products){productProof=await configureInvitationProducts(page,config.products);}else{
    let rates = page.getByPlaceholder('1.00-80.00').filter({ visible: true });
    if (!(await rates.count())) await page.getByText('Choose products', { exact: true }).last().click();
    let table = page.getByRole('table').filter({ visible: true });
    if (config.expected_product_name) table = table.filter({ hasText: config.expected_product_name });
    await table.waitFor({ state: 'visible' });
    assert(await table.count() === 1, 'OFFER_MISMATCH: 연결 상품이 확정 상품과 다릅니다.');
    const rows = table.locator('tbody tr').filter({ has: page.getByPlaceholder('1.00-80.00') });
    assert(await rows.count() > 0, 'OFFER_MISMATCH: 커미션을 설정할 상품이 없습니다.');
    for (const row of await rows.all()) {
      rates = row.getByPlaceholder('1.00-80.00').filter({ visible: true });
      const standard = rates.first();
      const rate = Number(await standard.inputValue());
      assert(rate === standardRate, `OFFER_MISMATCH: 실제 커미션 ${rate}%가 확정 ${standardRate}%와 다릅니다.`);
      const toggle = row.getByRole('switch');
      assert(await toggle.count() === 1, 'OFFER_MISMATCH: Shop Ads 커미션 스위치가 명확하지 않습니다.');
      if (await toggle.getAttribute('aria-checked') !== 'true') await toggle.click();
      const ads = rates.nth(1);
      await ads.fill(String(shopAdsRate));
      await ads.press('Tab');
      assert(await toggle.getAttribute('aria-checked') === 'true' && Number(await ads.inputValue()) === shopAdsRate,
        `OFFER_MISMATCH: Shop Ads 커미션 ${shopAdsRate}%를 설정하지 못했습니다.`);
      assert(Number(await standard.inputValue()) === standardRate, 'OFFER_MISMATCH: 일반 커미션이 변경됐습니다.');
    }
  }
  if (config.sample_policy === 'PRODUCT_LEVEL') {
    const label = page.locator('label').filter({ hasText: 'Use product-level sample settings' });
    if (!(await label.isVisible())) await page.getByText('Set up free samples', { exact: true }).last().click();
    await label.waitFor({ state: 'visible' });
    const radio = label.locator('input[type="radio"][value="follow"]');
    if (!(await radio.isChecked())) await label.click();
    assert(await radio.isChecked(), 'OFFER_MISMATCH: 상품별 기존 샘플 승인 설정을 선택하지 못했습니다.');
  }
  return productProof;
}

export async function prepareInvitation(page, config, item) {
  let lastError;
  const retryLimit = Math.max(0, Number(config.invitation_prepare_retry_limit ?? 2));
  for (let preparationAttempt = 0; preparationAttempt <= retryLimit; preparationAttempt += 1) {
    try {
      await page.goto(config.duplicate_url, { waitUntil: 'domcontentloaded' });
      if (/login/i.test(page.url())) throw new Error('SESSION_EXPIRED: TikTok 로그인이 필요합니다.');
      await page.getByText('Create invitation', { exact: true }).first().waitFor({ state: 'visible' });
      if (await page.getByText(/captcha|verification code|verify your identity/i).filter({ visible: true }).count()) {
        throw new Error('AUTH_CHALLENGE: CAPTCHA 또는 추가 인증이 필요합니다.');
      }
      await waitInvitationEditorReady(page,config);
      await page.getByPlaceholder('Invitation name').fill(config.invitation_name);
      await applyInvitationText(page, config.invitation_text);
      await selectDate(page, config.valid_until);
      await configureInvitationOffer(page, config);
      const selectedCount = await addTagCreators(page, item.tag_name, item.expected_count);
      assert(!config.require_full_creator_selection||selectedCount===item.expected_count,`CREATOR_SELECTION_INCOMPLETE: ${selectedCount}/${item.expected_count}; Send 전에 중단합니다.`);
      const overlapCount = await moveInvitationOverlaps(page, selectedCount, config);
      const totalText = page.getByText(/\d+\s*\/\s*50\s*creators in total/i).first();
      const totalCount = parseCreatorCount(await totalText.innerText(), 'creators in total');
      assert(totalCount === selectedCount, `${item.tag_name} 최종 인원이 다릅니다: ${selectedCount} != ${totalCount}`);
      const offerProof=config.products?await verifyInvitationProducts(page,config.products):undefined;
      if(config.products)await verifyInvitationFields(page,config);
      return { selectedCount, overlapCount, offerProof };
    } catch (error) {
      lastError = error;
      const decision = invitationPreparationRetryDecision(preparationAttempt, config, {
        fatal: isFatalError(error),
      });
      if (decision.action === 'STOP_FATAL' || decision.action === 'FAIL_TAG_AND_CONTINUE') throw error;
      process.stderr.write(
        `[${item.tag_name}] INVITE PREP RETRY: ${String(error?.message || error).slice(0, 500)} `
        + `새 Duplicate 폼 ${decision.next}/${decision.limit}으로 다시 시도합니다.\n`,
      );
      await page.waitForTimeout(Math.min(2_000, decision.next * 750));
    }
  }
  throw lastError || new Error(`${item.tag_name} 준비를 완료하지 못했습니다.`);
}

export async function waitForInvitationSendResult(page, config, onBlocked = async () => {}) {
  const success = page.getByText('Collab invite sent!', { exact: true });
  const blocked = page.getByText(/\d+ creators are already invited to collaborate/i).filter({ visible: true }).first();
  const timeout = Number(config.invite_success_timeout_ms || 60_000);
  let deadline = Date.now() + timeout;
  let resolved = 0;
  while (Date.now() < deadline) {
    if (await success.isVisible()) return;
    if (await blocked.isVisible()) {
      assert(resolved < Math.max(1, config.products?.length || 1), 'POST_SEND_OVERLAP_UNRESOLVED: 중복 해결 창이 반복됐습니다.');
      const label = await blocked.innerText();
      await onBlocked(label);
      // TikTok rejected this submission. Resolve that official blocking dialog
      // in place; never click Send again or create another Duplicate here.
      await page.getByRole('button', { name: 'Resolve', exact: true }).filter({ visible: true }).last().click();
      const confirmation=page.getByText(/Move \d+ creators to this invitation\?/i).filter({ visible: true }).last();
      const move = page.getByRole('radio', { name: /Move creators to this invitation/i }).filter({ visible: true }).last();
      const choiceDeadline=Date.now()+10_000;
      while(!await confirmation.isVisible()&&!await move.isVisible()&&Date.now()<choiceDeadline)await page.waitForTimeout(100);
      // TikTok remembers Move and can skip the radio-choice screen entirely.
      if(!await confirmation.isVisible()){
        await move.waitFor({ state: 'visible', timeout: 1_000 });
        if (!(await move.isChecked())) await move.evaluate(element => element.click());
        assert(await move.isChecked(), 'POST_SEND_OVERLAP_UNRESOLVED: Move 옵션을 확인하지 못했습니다.');
        await page.getByRole('button', { name: 'Resolve', exact: true }).filter({ visible: true }).last().click();
      }
      await confirmation.waitFor({ state: 'visible', timeout: 10_000 });
      await page.getByRole('button', { name: 'Move', exact: true }).filter({ visible: true }).last().click();
      resolved += 1;
      deadline = Date.now() + timeout;
      await blocked.waitFor({ state: 'hidden', timeout: 10_000 });
    }
    await page.waitForTimeout(100);
  }
  throw Error('INVITE_RESULT_UNCONFIRMED: 성공 화면을 확인하지 못했습니다. Send를 반복하지 않습니다.');
}

export async function openMessageCreators(context, invitationPage, previousChatPage = null, config={}) {
  const previousUrl = previousChatPage && !previousChatPage.isClosed() ? previousChatPage.url() : null;
  let button = invitationPage.getByRole('button', { name: 'Message creators', exact: true });
  if(config.existing_invitation_for_message){
    const existing=config.existing_invitation_for_message;
    const row=invitationPage.locator('tbody tr').filter({hasText:existing.name}).filter({hasText:`${existing.expected_count} creators invited`}).filter({hasText:`${existing.product_count} products`});
    await row.waitFor({state:'visible'});assert(await row.count()===1,'기존 초대가 명확하지 않아 재발송 없이 메시지를 건너뜁니다.');
    assert(await row.evaluate((element,name)=>[...element.querySelectorAll('td')].some(cell=>cell.innerText.trim().split('\n')[0].trim()===name),existing.name),'기존 초대 이름이 다릅니다.');
    await row.getByRole('button').last().click();
    await invitationPage.getByText('Share',{exact:true}).filter({visible:true}).last().hover();
    button=invitationPage.getByText('Share via chat',{exact:true}).filter({visible:true}).last();
  }
  await button.waitFor({ state: 'visible' });
  await button.click();

  for (let attempt = 0; attempt < 150; attempt += 1) {
    const candidates = context.pages().filter(candidate => /affiliate-global\.tiktok\.com\/seller\/im/.test(candidate.url()));
    const newChatPage = candidates.find(candidate => candidate !== previousChatPage);
    const reusedChatPage = previousChatPage
      && !previousChatPage.isClosed()
      && previousChatPage.url() !== previousUrl
      ? previousChatPage
      : null;
    const chatPage = newChatPage || reusedChatPage || (!previousChatPage ? candidates[0] : null);
    if (chatPage) {
      await chatPage.waitForLoadState('domcontentloaded').catch(() => {});
      if (/login/i.test(chatPage.url())) throw new Error('SESSION_EXPIRED: TikTok 로그인이 필요합니다.');
      return chatPage;
    }
    await invitationPage.waitForTimeout(200);
  }
  throw new Error('MESSAGE_PAGE_NOT_OPENED: Cooperation Chat 탭을 찾지 못했습니다.');
}

async function findSendInvitationDialog(chatPage, timeoutMs = 60_000) {
  const title = chatPage.getByText('Send invitation', { exact: true }).filter({ visible: true }).last();
  await title.waitFor({ state: 'visible', timeout: timeoutMs });

  let dialog = title.locator('xpath=ancestor::*[@role="dialog"][1]');
  if (!(await dialog.count())) {
    dialog = title.locator(
      'xpath=ancestor::*[.//button[normalize-space(.)="Share"] and .//*[contains(normalize-space(.), "creators selected")]][1]',
    );
  }
  assert(await dialog.count(), 'Send invitation 모달 범위를 찾지 못했습니다.');
  await dialog.waitFor({ state: 'visible' });
  return dialog;
}

async function leftCreatorListHandles(dialog, expectedCount) {
  const dialogHandle = await dialog.elementHandle();
  assert(dialogHandle, 'Send invitation 모달 DOM을 읽지 못했습니다.');
  const selectTitle = dialog.getByText('Select creators', { exact: true }).filter({ visible: true }).last();
  const previewTitle = dialog.getByText('Preview', { exact: true }).filter({ visible: true }).last();
  await selectTitle.waitFor({ state: 'visible' });
  await previewTitle.waitFor({ state: 'visible' });
  const previewHandle = await previewTitle.elementHandle();
  assert(previewHandle, 'Preview 패널 DOM을 읽지 못했습니다.');

  const candidates = await selectTitle.evaluate((title, { root, preview }) => {
    const collect = (container, predicate = () => true) => {
      const values = [];
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const textNode = walker.currentNode;
        const parent = textNode.parentElement;
        if (!parent || !predicate(parent)) continue;
        const style = window.getComputedStyle(parent);
        const rect = parent.getBoundingClientRect();
        if (style.display === 'none' || style.visibility === 'hidden' || rect.width === 0 || rect.height === 0) continue;
        const value = String(textNode.textContent || '').trim();
        if (/^@[A-Za-z0-9._]+$/.test(value)) values.push(value.slice(1));
      }
      return [...new Set(values)];
    };

    let leftPanel = title;
    while (leftPanel.parentElement && leftPanel.parentElement !== root && !leftPanel.parentElement.contains(preview)) {
      leftPanel = leftPanel.parentElement;
    }
    const previewLeft = preview.getBoundingClientRect().left;
    return {
      structural: collect(leftPanel),
      geometric: collect(root, element => element.getBoundingClientRect().right <= previewLeft),
    };
  }, { root: dialogHandle, preview: previewHandle });

  const ranked = [candidates.structural, candidates.geometric]
    .sort((left, right) => {
      const distance = Math.abs(left.length - expectedCount) - Math.abs(right.length - expectedCount);
      if (distance !== 0) return distance;
      return right.length - left.length;
    });
  const accepted = ranked.find(handles => handles.length >= 1);
  if (accepted) return accepted;
  process.stderr.write(
    `[MESSAGE] 왼쪽 creator handle을 읽지 못했습니다. `
    + `구조 ${candidates.structural.length}, 위치 ${candidates.geometric.length}, 선택 ${expectedCount}; `
    + `Share 후 결과는 미확인으로 기록합니다.\n`,
  );
  return [];
}

async function waitForMessageSelection(chatPage, selectedText, expectedCount, timeoutMs = 2_500,allowPartial=false) {
  const startedAt = Date.now();
  let selection = parseCreatorSelectionProgress(await selectedText.innerText());
  let partialCount=-1,partialSince=0;
  while (Date.now() - startedAt < timeoutMs) {
    selection = parseCreatorSelectionProgress(await selectedText.innerText());
    assert(
      selection.total === expectedCount,
      `메시지 전체 인원이 초대 인원과 다릅니다: ${selection.total}/${expectedCount}`,
    );
    if (selection.selected === expectedCount) return selection;
    if(allowPartial&&selection.selected>0){if(partialCount!==selection.selected){partialCount=selection.selected;partialSince=Date.now();}if(Date.now()-partialSince>=200)return selection;}else{partialCount=-1;partialSince=0;}
    await chatPage.waitForTimeout(100);
  }
  return selection;
}

export async function completeMessageSelection(chatPage, dialog, selectedText, expectedCount,allowPartial=false) {
  let selection = parseCreatorSelectionProgress(await selectedText.innerText());
  if (selection.selected === expectedCount||(allowPartial&&selection.selected>0)) return selection;

  const roleCheckboxes = dialog.getByRole('checkbox').filter({ visible: true });
  if (await roleCheckboxes.count()) {
    await roleCheckboxes.first().click();
    selection = await waitForMessageSelection(chatPage, selectedText, expectedCount,2500,allowPartial);
    if (selection.selected === expectedCount||(allowPartial&&selection.selected>0)) return selection;
    if (selection.selected === 0) {
      await roleCheckboxes.first().click();
      selection = await waitForMessageSelection(chatPage, selectedText, expectedCount,2500,allowPartial);
      if (selection.selected === expectedCount||(allowPartial&&selection.selected>0)) return selection;
    }
  }

  const creatorsLabel = dialog.getByText('Creators', { exact: true }).filter({ visible: true }).first();
  await creatorsLabel.waitFor({ state: 'visible' });
  const labelBox = await creatorsLabel.boundingBox();
  assert(labelBox, '메시지 Creators 헤더 위치를 읽지 못했습니다.');
  const clickY = labelBox.y + (labelBox.height / 2);

  for (const offset of [24, 18, 30]) {
    const clickX = labelBox.x - offset;
    const before = selection.selected;
    await chatPage.mouse.click(clickX, clickY);
    selection = await waitForMessageSelection(chatPage, selectedText, expectedCount,2500,allowPartial);
    if (selection.selected === expectedCount||(allowPartial&&selection.selected>0)) return selection;
    if (selection.selected === 0) {
      await chatPage.mouse.click(clickX, clickY);
      selection = await waitForMessageSelection(chatPage, selectedText, expectedCount,2500,allowPartial);
      if (selection.selected === expectedCount||(allowPartial&&selection.selected>0)) return selection;
    }
    if (selection.selected !== before) break;
  }

  return selection;
}

async function selectMessageRecipients(chatPage, dialog, expectedCount, config={}) {
  const selectedText = dialog.getByText(/\d+\s*\/\s*\d+\s*creators selected/i).last();
  await selectedText.waitFor({ state: 'visible', timeout: 60_000 });
  let selection = parseCreatorSelectionProgress(await selectedText.innerText());
  assert(
    selection.total === expectedCount,
    `메시지 전체 인원이 초대 인원과 다릅니다: ${selection.total}/${expectedCount}`,
  );
  let selectedCount = selection.selected;
  const allowPartial=!config.require_full_message_selection&&!config.fail_fast;
  if (selectedCount !== expectedCount&&!(allowPartial&&selectedCount>0)) {
    selection = await completeMessageSelection(chatPage, dialog, selectedText, expectedCount,allowPartial);
    selectedCount = selection.selected;
  }
  validateRecipientSelection(selectedCount,expectedCount,{requireFull:Boolean(config.require_full_message_selection||config.fail_fast)});
  if (selectedCount !== expectedCount) {
    process.stderr.write(
      `[MESSAGE] 전체선택이 ${selectedCount}/${expectedCount}에서 멈췄습니다. `
      + `Share가 활성화되면 현재 ${selectedCount}명에게 그대로 전송합니다.\n`,
    );
  }

  const handles = await leftCreatorListHandles(dialog, selectedCount);
  const verificationTarget = messageVerificationTarget(selectedCount, handles.length);
  if (handles.length !== selectedCount) {
    process.stdout.write(
      `[MESSAGE] UI 선택 ${selectedCount}명, handle 후보 ${handles.length}명, `
      + `완료 확인 ${verificationTarget}명으로 진행합니다.\n`,
    );
  }
  return { handles, verificationTarget, selectedCount };
}

export async function startMessageShare(context, invitationPage, previousChatPage, expectedCount, messageText, config = {}) {
  const chatPage = await openMessageCreators(context, invitationPage, previousChatPage,config);
  try {
    const dialogTimeoutMs = Math.max(1_000, Number(config.message_dialog_timeout_ms || 20_000));
    const reloadRetries = Math.max(0, Number(config.message_dialog_reload_retries ?? 2));
    let dialog;
    let lastDialogError;
    for (let attempt = 0; attempt <= reloadRetries; attempt += 1) {
      try {
        dialog = await findSendInvitationDialog(chatPage, dialogTimeoutMs);
        break;
      } catch (error) {
        lastDialogError = error;
        if (attempt >= reloadRetries) break;
        process.stderr.write(
          `[MESSAGE] Send invitation 창이 나타나지 않아 Cooperation Chat을 새로고침합니다 `
          + `(${attempt + 1}/${reloadRetries}).\n`,
        );
        await chatPage.reload({ waitUntil: 'domcontentloaded' });
        if (/login/i.test(chatPage.url())) throw new Error('SESSION_EXPIRED: TikTok 로그인이 필요합니다.');
        if (await chatPage.getByText(/captcha|verification code|verify your identity/i).filter({ visible: true }).count()) {
          throw new Error('AUTH_CHALLENGE: CAPTCHA 또는 추가 인증이 필요합니다.');
        }
      }
    }
    if (!dialog) throw lastDialogError;
    const recipients = await selectMessageRecipients(chatPage, dialog, expectedCount, config);
    const cleanMessageText = String(messageText || '').trim();
    assert(cleanMessageText.length >= 1 && cleanMessageText.length <= 500, '메시지 본문은 1~500자여야 합니다.');
    const messageBox = dialog.getByPlaceholder('Write a message', { exact: true }).filter({ visible: true }).last();
    await messageBox.waitFor({ state: 'visible' });
    await messageBox.fill(cleanMessageText);
    assert(
      (await messageBox.inputValue()) === cleanMessageText,
      '메시지 본문이 지정 문구와 정확히 일치하지 않습니다.',
    );
    const share = dialog.getByRole('button', { name: 'Share', exact: true });
    await share.waitFor({ state: 'visible' });
    assert(await share.isEnabled(), '메시지 Share 버튼이 활성화되지 않았습니다.');
    const finalSelection=parseCreatorSelectionProgress(await dialog.getByText(/\d+\s*\/\s*\d+\s*creators selected/i).last().innerText());
    assert(finalSelection.total===expectedCount,'메시지 전체 인원이 변경됐습니다.');validateRecipientSelection(finalSelection.selected,expectedCount,{requireFull:Boolean(config.require_full_message_selection||config.fail_fast)});
    return { chatPage, ...recipients, selectedCount:finalSelection.selected,verificationTarget:messageVerificationTarget(finalSelection.selected,recipients.handles.length),share };
  } catch (error) {
    error.capturePage = chatPage;
    throw error;
  }
}

export async function waitForMessageCompletion(chatPage, handles, verificationTarget, config, onProgress = () => {}) {
  const pollMs = Number(config.message_poll_ms || 2_000);
  const stabilizeMs = Number(config.message_stabilize_ms || 10_000);
  const quietTimeoutMs = Number(config.message_quiet_timeout_ms || 20_000);
  const totalTimeoutMs = Number(config.message_total_timeout_ms || 900_000);
  const started = Date.now();
  let lastProgressAt = started;
  let lastCount = 0;
  let allReachedAt = null;
  let latest = new Map();

  const summarize = reason => {
    const verified = [...latest.values()].slice(0, verificationTarget);
    const delivered = verified.filter(value => value === 'DELIVERED').length;
    const restricted = verified.filter(value => value === 'RESTRICTED').length;
    const actualTarget = Number(config.current_message_target || verificationTarget);
    return {
      delivered,
      restricted,
      verified: verified.length,
      unverified: Math.max(0, actualTarget - verified.length),
      total: actualTarget,
      candidate_count: handles.length,
      monitoring_status: reason,
      elapsed_seconds: Math.round((Date.now() - started) / 100) / 10,
    };
  };

  while (Date.now() - started < totalTimeoutMs) {
    const bodyText = await chatPage.locator('body').innerText();
    const observed = classifyMessageOutcomes(
      bodyText,
      handles,
      config.message_text || DEFAULT_INVITATION_SHARE_MESSAGE,
      {restrictionFirst:Boolean(config.fail_fast)},
    );
    // Chat rotates recipients as Share proceeds. Keep observations from prior
    // recipients instead of resetting progress to only the current screen.
    for (const [handle, outcome] of observed) latest.set(handle, outcome);
    if(config.fail_fast&&[...latest.values()].includes('RESTRICTED'))return summarize('RESTRICTED_STOP');
    if(config.fail_fast&&hasMessageRestriction(bodyText))return summarize('VISIBLE_RESTRICTION_STOP');
    if (latest.size > lastCount) {
      lastCount = latest.size;
      lastProgressAt = Date.now();
      onProgress({ count: Math.min(lastCount, verificationTarget), total: verificationTarget });
    }
    const actualTarget = Number(config.current_message_target || verificationTarget);
    if (actualTarget > 0 && latest.size >= actualTarget) {
      allReachedAt ||= Date.now();
      if (Date.now() - allReachedAt >= stabilizeMs) {
        return summarize('COMPLETE');
      }
    } else if (Date.now() - lastProgressAt >= quietTimeoutMs) {
      return summarize('QUIET_TIMEOUT_BEST_EFFORT');
    }
    await chatPage.waitForTimeout(pollMs);
  }
  return summarize('TOTAL_TIMEOUT_BEST_EFFORT');
}

function queueForRun(state, options) {
  return state.tags.filter(item => {
    if (item.status === 'PENDING') return true;
    if(item.status==='MESSAGE_FAILED'&&state.config.defer_existing_message_failures)return false;
    if (item.status === 'INVITE_SENT' || item.status === 'MESSAGE_FAILED') return Boolean(state.config.share_to_im);
    if (item.status === 'FAILED') return Boolean(options['--retry-failed']);
    if (item.status === 'UNCERTAIN' || item.status === 'MESSAGE_UNCERTAIN') {
      return Boolean(options['--retry-uncertain']);
    }
    return false;
  });
}

export function isFatalError(error) {
  return /SESSION_EXPIRED|AUTH_CHALLENGE|OFFER_MISMATCH|Target (?:page, context or browser|page|context|browser) has been closed|Browser has been closed/i.test(String(error?.message || error));
}

async function captureFailure(page, evidenceDir, item, error) {
  await fs.mkdir(evidenceDir, { recursive: true });
  const basename = `${new Date().toISOString().replaceAll(':', '-')}-${item.tag_name}`;
  try { await page.screenshot({ path: path.join(evidenceDir, `${basename}.png`), fullPage: true }); }
  catch { /* Preserve the original error. */ }
  await fs.writeFile(path.join(evidenceDir, `${basename}.txt`), String(error?.stack || error));
}

async function runBatch(options) {
  const stored=await readJson(options.checkpoint);
  assert(stored.status!=='STOPPED_BY_USER','사용자가 중단한 계획입니다. 기존 계획을 자동 재개하지 말고 새로 승인된 별도 계획을 사용하세요.');
  if(stored.config.manual_start_only&&!stored.tags.some(item=>item.send_clicked_at))assert(stored.config.start_date===kstDate(), '계획 시작일이 오늘 KST와 다릅니다. 실제 발송일 기준으로 5주 계획을 다시 준비하세요.');
  let state = recoverInterruptedStates(upgradeInvitationCheckpoint(stored));
  const failFast=Boolean(options['--fail-fast']||state.config.fail_fast);
  if(failFast)Object.assign(state.config,{fail_fast:true,invitation_prepare_retry_limit:0,unconfirmed_invite_retry_limit:0,continue_after_unconfirmed_invite:false,message_dialog_reload_retries:0,reinvite_on_message_prepare_failure:false,message_reinvite_limit:0});
  if (state.config.invitation_text != null) validateInvitationText(state.config.invitation_text);
  const queue = queueForRun(state, options);
  assert(queue.length, '전송할 PENDING 태그가 없습니다. status 또는 retry 옵션을 확인하세요.');
  const expected = invitationConfirmation(state, queue);
  await askExact(expected);
  if (options['--stop-on-error']) {
    process.stderr.write(
      '[OUTREACH] --stop-on-error는 진단용입니다. Send 전 UI 오류는 새 폼 재시도를 마친 뒤 '
      + '해당 태그만 FAILED로 남기고 다음 태그를 계속합니다.\n',
    );
  }
  state.status = 'RUNNING';
  state.started_at ||= new Date().toISOString();
  state.confirmation = expected;
  await writeJsonAtomic(options.checkpoint, state);

  const context = await launchProfile(options.profileDir);
  const page = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(options.timeoutMs);
  let activeMessage = null;
  let chatPage = null;

  const settleActiveMessage = async () => {
    if (!activeMessage) return;
    const current = activeMessage;
    activeMessage = null;
    const outcome = await current.promise;
    if (!outcome.ok) {
      const expected = Number(current.item.message_expected_count || current.item.selected_count || current.item.expected_count || 0);
      current.item.status = 'SENT';
      current.item.sent_at = new Date().toISOString();
      current.item.failed_at = new Date().toISOString();
      current.item.message_verified_count = 0;
      current.item.message_unverified_count = expected;
      current.item.message_monitoring_status = 'MONITOR_ERROR_BEST_EFFORT';
      current.item.note = `Message Share was clicked; monitoring error was not retried: ${String(outcome.error?.message || outcome.error).slice(0, 800)}`;
      refreshPlanSummary(state);
      await writeJsonAtomic(options.checkpoint, state);
      await captureFailure(current.chatPage, options.evidenceDir, current.item, outcome.error);
      process.stderr.write(`[${current.item.tag_name}] MESSAGE MONITOR WARNING: ${current.item.note}\n`);
      if (failFast||isFatalError(outcome.error)) throw outcome.error;
      return;
    }
    current.item.status = 'SENT';
    current.item.sent_at = new Date().toISOString();
    current.item.message_elapsed_seconds = outcome.result.elapsed_seconds;
    current.item.message_delivered_count = outcome.result.delivered;
    current.item.message_restricted_count = outcome.result.restricted;
    current.item.message_verified_count = outcome.result.verified;
    current.item.message_unverified_count = outcome.result.unverified;
    current.item.message_monitoring_status = outcome.result.monitoring_status;
    delete current.item.message_recovery_active;
    current.item.note = `Invite and message Share completed; delivered=${outcome.result.delivered}; restricted=${outcome.result.restricted}; unverified=${outcome.result.unverified}; monitoring=${outcome.result.monitoring_status}.`;
    refreshPlanSummary(state);
    await writeJsonAtomic(options.checkpoint, state);
    process.stdout.write(
      `[${current.item.tag_name}] MESSAGE COMPLETE ${outcome.result.verified}/${outcome.result.total}명 확인 `
      + `(정상 ${outcome.result.delivered}, 제한 ${outcome.result.restricted}, 미확인 ${outcome.result.unverified}), `
      + `${outcome.result.elapsed_seconds}s\n`,
    );
    if(failFast&&(outcome.result.restricted>0||outcome.result.unverified>0||outcome.result.monitoring_status!=='COMPLETE')){
      state.fail_fast_error=`MESSAGE_STOP: restricted=${outcome.result.restricted}; unverified=${outcome.result.unverified}; status=${outcome.result.monitoring_status}`;
      state.stopped_at=new Date().toISOString();await writeJsonAtomic(options.checkpoint,state);
      throw Error(state.fail_fast_error);
    }
  };

  const handlePreShareRecoveryFailure = async ({ item, error, capturePage, index, phase }) => {
    if (failFast||isFatalError(error) || !state.config.reinvite_on_message_prepare_failure) return false;

    item.status = 'MESSAGE_FAILED';
    item.failed_at = new Date().toISOString();
    const decision = messageReinviteDecision(item, state.config);
    const detail = String(error?.message || error).slice(0, 700);
    state.failures.push({
      tag_name: item.tag_name,
      status: item.status,
      failed_at: item.failed_at,
      error: `${phase}: ${detail}`,
    });

    if (decision.action === 'REINVITE') {
      item.note = `${phase} failed before Message Share; fresh invitation retry ${decision.next}/${decision.limit} queued: ${detail}`;
      refreshPlanSummary(state);
      await writeJsonAtomic(options.checkpoint, state);
      await captureFailure(capturePage, options.evidenceDir, item, error);
      process.stderr.write(
        `[${item.tag_name}] MESSAGE RECOVERY: ${phase} failed; `
        + `fresh invitation ${decision.next}/${decision.limit} will be created.\n`,
      );
      queue.splice(index + 1, 0, item);
      return true;
    }

    item.status = 'SENT';
    item.sent_at = new Date().toISOString();
    delete item.message_recovery_active;
    item.message_monitoring_status = decision.action === 'SKIP_RESUME_UNAVAILABLE'
      ? 'SKIPPED_RESUME_UNAVAILABLE'
      : 'SKIPPED_AFTER_REINVITE';
    item.message_skipped_count = Number(item.selected_count || item.expected_count || 0);
    item.note = `${phase} failed before Message Share after ${decision.used} fresh invitation retries; message skipped and continuing: ${detail}`;
    refreshPlanSummary(state);
    await writeJsonAtomic(options.checkpoint, state);
    await captureFailure(capturePage, options.evidenceDir, item, error);
    process.stderr.write(`[${item.tag_name}] MESSAGE SKIPPED: fresh invitation retry limit reached; continuing.\n`);
    return true;
  };

  try {
    for (let index = 0; index < queue.length; index += 1) {
      if(failFast)await settleActiveMessage();
      const item = queue[index];
      const started = Date.now();
      const reinviteDecision = messageReinviteDecision(item, state.config);
      if (reinviteDecision.action === 'SKIP' || reinviteDecision.action === 'SKIP_RESUME_UNAVAILABLE') {
        item.status = 'SENT';
        item.sent_at = new Date().toISOString();
        delete item.message_recovery_active;
        item.message_monitoring_status = reinviteDecision.action === 'SKIP'
          ? 'SKIPPED_AFTER_REINVITE'
          : 'SKIPPED_RESUME_UNAVAILABLE';
        item.message_skipped_count = Number(item.selected_count || item.expected_count || 0);
        item.note = reinviteDecision.action === 'SKIP'
          ? `Message preparation failed after ${reinviteDecision.used} fresh invitation retries; message skipped and continuing.`
          : 'Stored invitation success pages cannot be restored and fresh reinvites are disabled; message skipped and continuing.';
        refreshPlanSummary(state);
        await writeJsonAtomic(options.checkpoint, state);
        process.stderr.write(`[${item.tag_name}] MESSAGE SKIPPED: ${item.note}\n`);
        continue;
      }

      const messageRecoveryAttempt = reinviteDecision.action === 'REINVITE'
        || item.message_recovery_active === true;
      if (reinviteDecision.action === 'REINVITE') {
        const previousStatus = item.status;
        item.message_reinvite_count = reinviteDecision.next;
        item.message_reinvite_started_at = new Date().toISOString();
        item.message_reinvite_reason = previousStatus;
        item.message_recovery_active = true;
        item.unconfirmed_send_count = 0;
        delete item.success_url;
        delete item.ready_at;
        delete item.send_clicked_at;
        delete item.invite_sent_at;
        delete item.invite_confirmation_status;
        delete item.message_expected_count;
        delete item.message_candidate_count;
        delete item.message_verification_target;
        delete item.message_share_clicked_at;
        process.stderr.write(
          `[${item.tag_name}] MESSAGE PREP RECOVERY: fresh invitation `
          + `${reinviteDecision.next}/${reinviteDecision.limit} will be created.\n`,
        );
      }

      const resumeMessage = reinviteDecision.action !== 'REINVITE' && (
        item.status === 'INVITE_SENT'
        || item.status === 'MESSAGE_FAILED'
        || item.status === 'MESSAGE_UNCERTAIN'
      );

      if (!resumeMessage) {
        item.status = 'PREPARING';
        item.attempts += 1;
        item.started_at = new Date().toISOString();
        delete item.failed_at;
        refreshPlanSummary(state);
        await writeJsonAtomic(options.checkpoint, state);
        process.stdout.write(`[${index + 1}/${queue.length}] ${item.tag_name} 초대 준비\n`);
        try {
          const prepared = await prepareInvitation(page, state.config, item);
          item.selected_count = prepared.selectedCount;
          if(prepared.offerProof)item.offer_verification=prepared.offerProof;
          item.overlap_count = prepared.overlapCount;
          item.status = 'READY';
          item.ready_at = new Date().toISOString();
          refreshPlanSummary(state);
          await writeJsonAtomic(options.checkpoint, state);

          item.status = 'SEND_CLICKED';
          item.send_clicked_at = new Date().toISOString();
          refreshPlanSummary(state);
          await writeJsonAtomic(options.checkpoint, state);
          await page.getByRole('button', { name: 'Send', exact: true }).click();
          await waitForInvitationSendResult(page, state.config, async label => {
            item.blocked_overlap_resolutions ||= [];
            item.blocked_overlap_resolutions.push({ observed_at: new Date().toISOString(), label });
            await writeJsonAtomic(options.checkpoint, state);
            await captureFailure(page, options.evidenceDir, item, new Error(`POST_SEND_OVERLAP_BLOCKED: ${label}`));
            process.stdout.write(`[${item.tag_name}] 기존 초대 중복 창에서 Move 절차를 처리합니다. Send는 반복하지 않습니다.\n`);
          });

          item.invite_sent_at = new Date().toISOString();
          item.invite_confirmation_status = 'VERIFIED';
          item.success_url = page.url();
          item.elapsed_seconds = Math.round((Date.now() - started) / 100) / 10;
          item.status = state.config.share_to_im ? 'INVITE_SENT' : 'SENT';
          if (!state.config.share_to_im) {
            item.sent_at = item.invite_sent_at;
            item.note = `Success screen verified; overlap=${prepared.overlapCount}; Share to IM skipped.`;
          }
          refreshPlanSummary(state);
          await writeJsonAtomic(options.checkpoint, state);
          process.stdout.write(
            `[${item.tag_name}] INVITE SENT ${prepared.selectedCount}명, `
            + `중복 이동 ${prepared.overlapCount}명, ${item.elapsed_seconds}s\n`,
          );
        } catch (error) {
          const afterSend = item.status === 'SEND_CLICKED';
          const fatal = isFatalError(error);
          if (messageRecoveryAttempt && !fatal) {
            const handled = await handlePreShareRecoveryFailure({
              item,
              error,
              capturePage: page,
              index,
              phase: afterSend ? 'Fresh invitation confirmation' : 'Fresh invitation preparation',
            });
            if (handled) continue;
          }
          const continueAfterUnconfirmed = afterSend
            && state.config.continue_after_unconfirmed_invite
            && !fatal;
          if (continueAfterUnconfirmed) {
            const retryLimit = Math.max(0, Number(state.config.unconfirmed_invite_retry_limit || 0));
            item.unconfirmed_send_count = Number(item.unconfirmed_send_count || 0) + 1;
            item.failed_at = new Date().toISOString();
            item.elapsed_seconds = Math.round((Date.now() - started) / 100) / 10;
            await captureFailure(page, options.evidenceDir, item, error);

            if (item.unconfirmed_send_count <= retryLimit) {
              item.status = 'FAILED';
              item.invite_confirmation_status = 'RETRY_PENDING';
              item.note = `Send was clicked but the success screen was not confirmed; duplicate retry ${item.unconfirmed_send_count}/${retryLimit} is allowed.`;
              refreshPlanSummary(state);
              await writeJsonAtomic(options.checkpoint, state);
              process.stderr.write(`[${item.tag_name}] INVITE CONFIRMATION WARNING: ${item.note}\n`);
              queue.splice(index + 1, 0, item);
              continue;
            }

            item.status = 'SENT';
            item.invite_sent_at ||= item.send_clicked_at;
            item.sent_at = new Date().toISOString();
            item.invite_confirmation_status = 'ASSUMED_SENT';
            item.message_monitoring_status = 'SKIPPED_NO_SUCCESS_PAGE';
            item.message_skipped_count = Number(item.selected_count || item.expected_count || 0);
            item.note = `Send was clicked ${item.unconfirmed_send_count} times without a success screen; treated as sent, message skipped, continuing to the next tag.`;
            refreshPlanSummary(state);
            await writeJsonAtomic(options.checkpoint, state);
            process.stderr.write(`[${item.tag_name}] INVITE ASSUMED SENT: ${item.note}\n`);
            continue;
          }

          item.status = afterSend ? 'UNCERTAIN' : 'FAILED';
          item.failed_at = new Date().toISOString();
          item.elapsed_seconds = Math.round((Date.now() - started) / 100) / 10;
          item.note = String(error?.message || error).slice(0, 1000);
          state.failures.push({
            tag_name: item.tag_name,
            status: item.status,
            failed_at: item.failed_at,
            error: item.note,
          });
          refreshPlanSummary(state);
          await writeJsonAtomic(options.checkpoint, state);
          await captureFailure(page, options.evidenceDir, item, error);
          process.stderr.write(`[${item.tag_name}] ${item.status}: ${item.note}\n`);
          if(afterSend&&state.config.continue_after_uncertain_without_retry){item.invite_confirmation_status='UNCONFIRMED_NO_RETRY';item.message_monitoring_status='SKIPPED_UNCONFIRMED_INVITE';item.message_skipped_count=Number(item.selected_count||item.expected_count||0);await writeJsonAtomic(options.checkpoint,state);}
          if (failFast||isFatalError(error) || (afterSend&&!state.config.continue_after_uncertain_without_retry)) throw error;
          continue;
        }
      } else {
        const resumeUrl=reinviteDecision.action==='RESUME_EXISTING'?item.message_resume_url:item.success_url;
        assert(resumeUrl, `${item.tag_name} 초대 성공 URL이 없어 메시지를 안전하게 재개할 수 없습니다.`);
        try{
          await page.goto(resumeUrl, { waitUntil: 'domcontentloaded' });
          if(reinviteDecision.action==='RESUME_EXISTING'&&item.message_resume_mode!=='LIST_SHARE_IM')await page.getByRole('button',{name:'Message creators',exact:true}).waitFor({state:'visible',timeout:30000});
          else if(reinviteDecision.action!=='RESUME_EXISTING')await page.getByText('Collab invite sent!', { exact: true }).waitFor({ state: 'visible', timeout: 60_000 });
        }catch(error){
          if(failFast||isFatalError(error))throw error;
          item.status='SENT';item.message_monitoring_status='SKIPPED_RESUME_ERROR';item.message_skipped_count=Number(item.selected_count||item.expected_count||0);item.note='Invitation is already verified; message resume failed without repeating Send: '+error.message;refreshPlanSummary(state);await writeJsonAtomic(options.checkpoint,state);await captureFailure(page,options.evidenceDir,item,error);continue;
        }
      }

      if (!state.config.share_to_im) continue;

      // The next invitation is prepared while the previous Share runs. Never open the
      // next Message creators page until the previous batch has an explicit result for all recipients.
      await settleActiveMessage();

      try {
        item.status = 'MESSAGE_PREPARING';
        refreshPlanSummary(state);
        await writeJsonAtomic(options.checkpoint, state);
        const preparedMessage = await startMessageShare(
          context,
          page,
          chatPage,
          item.selected_count || item.expected_count,
          state.config.message_text || DEFAULT_INVITATION_SHARE_MESSAGE,
          {...state.config,existing_invitation_for_message:reinviteDecision.action==='RESUME_EXISTING'&&item.message_resume_mode==='LIST_SHARE_IM'?{name:state.config.invitation_name,expected_count:item.selected_count||item.expected_count,product_count:state.config.products.length}:undefined},
        );
        chatPage = preparedMessage.chatPage;
        chatPage.setDefaultTimeout(options.timeoutMs);
        item.message_expected_count = preparedMessage.selectedCount;
        item.message_candidate_count = preparedMessage.handles.length;
        item.message_verification_target = preparedMessage.verificationTarget;
        item.message_chat_url=chatPage.url();
        item.status = 'MESSAGE_SHARE_CLICKED';
        item.message_share_clicked_at = new Date().toISOString();
        delete item.message_recovery_active;
        refreshPlanSummary(state);
        await writeJsonAtomic(options.checkpoint, state);
        await preparedMessage.share.click();
        const promise = waitForMessageCompletion(
          chatPage,
          preparedMessage.handles,
          preparedMessage.verificationTarget,
          {
            ...state.config,
            current_message_target: preparedMessage.selectedCount,
          },
          progress => process.stdout.write(`[${item.tag_name}] MESSAGE ${progress.count}/${progress.total}\n`),
        ).then(
          result => ({ ok: true, result }),
          error => ({ ok: false, error }),
        );
        activeMessage = { item, chatPage, promise };
      } catch (error) {
        const afterShare = item.status === 'MESSAGE_SHARE_CLICKED';
        if(error.capturePage&&!error.capturePage.isClosed()&&/affiliate-global\.tiktok\.com\/seller\/im/.test(error.capturePage.url()))item.message_chat_url=error.capturePage.url();
        const fatal = isFatalError(error);
        if (!afterShare && !fatal) {
          const handled = await handlePreShareRecoveryFailure({
            item,
            error,
            capturePage: error.capturePage || chatPage || page,
            index,
            phase: 'Message preparation',
          });
          if (handled) continue;
        }
        item.status = afterShare ? 'SENT' : 'MESSAGE_FAILED';
        item.failed_at = new Date().toISOString();
        if (afterShare) {
          const expected = Number(item.message_expected_count || item.selected_count || item.expected_count || 0);
          item.sent_at = new Date().toISOString();
          item.message_verified_count = 0;
          item.message_unverified_count = expected;
          item.message_monitoring_status = 'POST_SHARE_ERROR_BEST_EFFORT';
          delete item.message_recovery_active;
          item.note = `Message Share may have been accepted; no automatic retry: ${String(error?.message || error).slice(0, 800)}`;
        } else {
          item.note = String(error?.message || error).slice(0, 1000);
          state.failures.push({
            tag_name: item.tag_name,
            status: item.status,
            failed_at: item.failed_at,
            error: item.note,
          });
        }
        refreshPlanSummary(state);
        await writeJsonAtomic(options.checkpoint, state);
        await captureFailure(error.capturePage || chatPage || page, options.evidenceDir, item, error);
        process.stderr.write(`[${item.tag_name}] ${afterShare ? 'MESSAGE WARNING' : item.status}: ${item.note}\n`);
        if (failFast||fatal || (!afterShare && options['--stop-on-error'])) throw error;
      }
    }
    await settleActiveMessage();
  } catch(error) {
    if(failFast){state.fail_fast_error=String(error.message||error);state.stopped_at=new Date().toISOString();}
    throw error;
  } finally {
    if (activeMessage) {
      try { await settleActiveMessage(); }
      catch (error) { process.stderr.write(`[MESSAGE FINALIZE] ${error.message}\n`); }
    }
    refreshPlanSummary(state);
    if(state.fail_fast_error)state.status='STOPPED_ON_ERROR';
    if (state.counts.sent === state.counts.total&&!state.fail_fast_error) state.completed_at = new Date().toISOString();
    await writeJsonAtomic(options.checkpoint, state);
    await context.close();
  }
  process.stdout.write(JSON.stringify({
    status: state.status,
    counts: state.counts,
    checkpoint: options.checkpoint,
    failures: state.failures.slice(-20),
  }, null, 2) + '\n');
  return state;
}

async function runLogin(options) {
  const context = await launchProfile(options.profileDir);
  const page = context.pages()[0] || await context.newPage();
  try {
    await page.goto(collaborationListUrl, { waitUntil: 'domcontentloaded' });
    await waitForEnter('열린 Chrome에서 TikTok 로그인을 완료하고 Target Collaboration 화면 접근을 확인하세요.');
  } finally { await context.close(); }
}

async function runStatus(options) {
  const state = recoverInterruptedStates(upgradeInvitationCheckpoint(await readJson(options.checkpoint)));
  await writeJsonAtomic(options.checkpoint, state);
  process.stdout.write(JSON.stringify({
    status: state.status,
    config: state.config,
    counts: state.counts,
    estimate: state.estimate,
    recent_failures: state.failures.slice(-20),
    checkpoint: options.checkpoint,
  }, null, 2) + '\n');
  return state;
}

export async function main(args = process.argv.slice(2)) {
  const options = parseOptions(args);
  if (options.command === 'login') return runLogin(options);
  if (options.command === 'plan') return runPlan(options);
  if (options.command === 'run') return runBatch(options);
  return runStatus(options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptFile) {
  try { await main(); }
  catch (error) { process.stderr.write(`ERROR: ${error.message}\n`); process.exitCode = 1; }
}
