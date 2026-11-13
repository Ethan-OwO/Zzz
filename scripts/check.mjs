// Local verification (M1 + M2): static checks on dist/, then serve dist/ with the
// headers from dist/_headers and drive it with Playwright Chromium.
import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const DIST = resolve(fileURLToPath(new URL('../dist', import.meta.url)));
const EXPECTED_IDS = [
  'secure-context',
  'get-user-media',
  'audio-worklet',
  'wake-lock',
  'indexed-db',
  'device-motion',
  'file-share',
  'user-agent',
];
const ALLOWED_URLS = new Set(['http://www.w3.org/2000/svg']);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

let failed = false;
const details = [];

function pass(msg) {
  console.log(`PASS ${msg}`);
}
function fail(msg, extra) {
  failed = true;
  console.log(`FAIL ${msg}`);
  if (extra !== undefined) details.push({ check: msg, extra });
}
function expect(cond, msg, extra) {
  if (cond) pass(msg);
  else fail(msg, extra);
}

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

/** Parse Cloudflare Pages `_headers`: a path rule line, then `  Name: value` lines. */
function parseHeaders(text) {
  const rules = [];
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) continue;
    if (/^\s/.test(raw)) {
      if (!current) throw new Error(`_headers: header line without rule: ${raw}`);
      const idx = raw.indexOf(':');
      if (idx === -1) throw new Error(`_headers: malformed header line: ${raw}`);
      current.headers.push([raw.slice(0, idx).trim(), raw.slice(idx + 1).trim()]);
    } else {
      current = { pattern: raw.trim(), headers: [] };
      rules.push(current);
    }
  }
  return rules;
}

function matches(pattern, pathname) {
  if (pattern.endsWith('*')) return pathname.startsWith(pattern.slice(0, -1));
  return pathname === pattern;
}

function headersFor(rules, pathname) {
  const out = {};
  for (const rule of rules) {
    if (!matches(rule.pattern, pathname)) continue;
    for (const [name, value] of rule.headers) out[name] = value;
  }
  return out;
}

// ---------- 1. Static checks ----------

const headersPath = join(DIST, '_headers');
if (!existsSync(DIST)) {
  console.log('FAIL dist/ missing (run `pnpm build` first)');
  process.exit(1);
}
expect(existsSync(headersPath), 'dist/_headers exists');
const rules = existsSync(headersPath) ? parseHeaders(await readFile(headersPath, 'utf8')) : [];
const expectedCsp = headersFor(rules, '/')['Content-Security-Policy'];
expect(typeof expectedCsp === 'string' && expectedCsp.length > 0, '_headers defines Content-Security-Policy for /');

const indexHtml = await readFile(join(DIST, 'index.html'), 'utf8');
const inlineScripts = [...indexHtml.matchAll(/<script\b(?![^>]*\bsrc\s*=)[^>]*>/gi)].map((m) => m[0]);
expect(inlineScripts.length === 0, 'index.html has no inline <script>', inlineScripts);
const styleTags = [...indexHtml.matchAll(/<style\b[^>]*>/gi)].map((m) => m[0]);
expect(styleTags.length === 0, 'index.html has no <style>', styleTags);
const styleAttrs = [...indexHtml.matchAll(/\sstyle\s*=/gi)].map((m) => m[0]);
expect(styleAttrs.length === 0, 'index.html has no style= attribute', styleAttrs);

const textFiles = (await walk(DIST)).filter((f) => ['.html', '.js', '.css'].includes(extname(f)));
const externalUrls = [];
for (const file of textFiles) {
  const content = await readFile(file, 'utf8');
  for (const m of content.matchAll(/https?:\/\/[^\s"'`)<>]+/g)) {
    if (!ALLOWED_URLS.has(m[0])) externalUrls.push(`${file.slice(DIST.length + 1)}: ${m[0]}`);
  }
}
expect(externalUrls.length === 0, `no external URLs in ${textFiles.length} html/js/css files`, externalUrls);

// ---------- 2. Local server ----------

const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    let filePath = normalize(join(DIST, pathname));
    if (filePath !== DIST && !filePath.startsWith(DIST + sep)) {
      res.writeHead(403).end();
      return;
    }
    if (existsSync(filePath) && (await stat(filePath)).isDirectory()) {
      filePath = join(filePath, 'index.html');
    }
    if (!existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    const body = await readFile(filePath);
    res.writeHead(200, {
      ...headersFor(rules, pathname),
      'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream',
    });
    res.end(body);
  } catch (err) {
    res.writeHead(500).end(String(err));
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const { port } = server.address();
const baseUrl = `http://127.0.0.1:${port}/`;

// ---------- 3. Browser checks ----------

const FILE_RE = /^zzz-m2-\d{8}-\d{4}\.json$/;

/** Long-press (or short-press) the button: mouse down, wait, mouse up. */
async function press(page, locator, ms) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('button has no bounding box');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(ms);
  await page.mouse.up();
}

async function downloadJson(page, button) {
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }), button.click()]);
  const name = download.suggestedFilename();
  const path = await download.path();
  const text = await readFile(path, 'utf8');
  return { name, text, json: JSON.parse(text) };
}

let browser;
try {
  browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });
  const context = await browser.newContext({ permissions: ['microphone'], acceptDownloads: true });
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    // Wake lock may be refused in headless Chromium; that is not a failure (design §7.2).
    if (/wake ?lock/i.test(msg.text())) return;
    consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(err.message));
  page.on('requestfailed', (req) => failedRequests.push(`${req.url()} ${req.failure()?.errorText ?? ''}`));

  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__cspViolations.push({ violatedDirective: e.violatedDirective, blockedURI: e.blockedURI });
    });
  });

  const response = await page.goto(`${baseUrl}?hb=2`, { waitUntil: 'load' });
  const gotCsp = response?.headers()['content-security-policy'];
  expect(
    gotCsp === expectedCsp,
    'main document carries the CSP from _headers',
    { expected: expectedCsp, got: gotCsp },
  );

  const heading = page.getByRole('heading', { name: 'Zzz', exact: true });
  expect((await heading.count()) === 1, 'heading "Zzz" is visible');
  const startButton = page.getByRole('button', { name: '開始', exact: true });
  expect((await startButton.count()) === 1, 'button "開始" is visible');

  // M1 env-check table, now behind 環境檢查.
  const envButton = page.getByRole('button', { name: '環境檢查', exact: true });
  await envButton.click();
  const tables = page.locator('table');
  await tables.first().waitFor({ timeout: 5000 }).catch(() => {});
  const rowIds = await page.locator('table tbody tr').evaluateAll((rows) => rows.map((r) => r.dataset.id));
  expect((await tables.count()) === 1, 'clicking 環境檢查 renders one <table>');
  expect(
    JSON.stringify(rowIds) === JSON.stringify(EXPECTED_IDS),
    'table has 8 rows with the expected ids in order',
    rowIds,
  );
  await envButton.click();
  expect((await tables.count()) === 1, 'clicking 環境檢查 again still leaves exactly one <table>');

  // C1
  const select = page.getByLabel('測試情境');
  const storedText = page.getByText('已存的測試紀錄');
  await page.waitForTimeout(300); // let the async stored-sessions lookup finish
  expect(
    (await select.count()) === 1 && (await select.inputValue()) === 'N1' && (await storedText.count()) === 0,
    'C1 home has 測試情境 select defaulting to N1 and no stored sessions',
  );

  // C2
  await select.selectOption('P0');
  await startButton.click();
  const recording = await page
    .waitForFunction(() => document.body.classList.contains('recording'), null, { timeout: 3000 })
    .then(() => true, () => false);
  const visibleText = await page.evaluate(() => document.body.innerText.trim());
  expect(recording && visibleText === '', 'C2 recording screen within 3 s, no visible text', { recording, visibleText });

  // C3
  await page.mouse.click(10, 10);
  const stopButton = page.getByRole('button', { name: '長按 2 秒停止' });
  const overlayShown = await stopButton.isVisible();
  await page.waitForTimeout(1200);
  const ctxText = await page.locator('[data-field="ctx"]').textContent();
  expect(overlayShown && ctxText === 'running', 'C3 tap shows overlay with 長按 2 秒停止 and AudioContext running', {
    overlayShown, ctxText,
  });

  // C4
  await press(page, stopButton, 300);
  await page.waitForTimeout(300);
  const stillRecording = await page.evaluate(() => document.body.classList.contains('recording'));
  expect(stillRecording, 'C4 short press keeps recording');

  // C5
  await page.waitForTimeout(5000);
  await page.mouse.click(10, 10); // keep the overlay visible
  await press(page, stopButton, 2300);
  const hbCell = page.locator('[data-field="heartbeats"]');
  await hbCell.waitFor({ timeout: 5000 }).catch(() => {});
  const hbCount = Number(await hbCell.textContent().catch(() => 'NaN'));
  const leftRecording = await page.evaluate(() => !document.body.classList.contains('recording'));
  expect(leftRecording && hbCount >= 2, 'C5 long press 2.3 s shows result with >= 2 heartbeats', { hbCount });

  // C6
  try {
    const { name, json } = await downloadJson(page, page.getByRole('button', { name: '下載全部 JSON' }));
    const s = json.sessions?.[0];
    const goodHb = (s?.heartbeats ?? []).some(
      (h) => h.frames > 0 && h.zeroFrames < h.frames && typeof h.meanDb === 'number' && h.meanDb > -120,
    );
    const types = new Set((s?.events ?? []).map((e) => e.type));
    const ok =
      FILE_RE.test(name) &&
      json.schema === 'zzz-m2/1' &&
      json.sessions.length === 1 &&
      s.scenario === 'P0' &&
      s.stoppedAt !== null &&
      typeof s.ctxSampleRate === 'number' && s.ctxSampleRate > 0 &&
      s.trackSettings?.echoCancellation === false &&
      goodHb &&
      types.has('start') && types.has('stop');
    expect(ok, 'C6 downloaded JSON has the expected shape and content', {
      name,
      schema: json.schema,
      sessions: json.sessions?.length,
      scenario: s?.scenario,
      stoppedAt: s?.stoppedAt,
      ctxSampleRate: s?.ctxSampleRate,
      trackSettings: s?.trackSettings,
      heartbeats: s?.heartbeats,
      eventTypes: [...types],
    });
    console.log(`     C6 sample: ${name}, ctxSampleRate ${s?.ctxSampleRate}, ` +
      `heartbeat[0] frames ${s?.heartbeats?.[0]?.frames} meanDb ${s?.heartbeats?.[0]?.meanDb?.toFixed?.(1)}, ` +
      `events ${[...types].join(',')}`);
  } catch (err) {
    fail('C6 downloaded JSON has the expected shape and content', String(err));
  }

  // C7
  await page.getByRole('button', { name: '回首頁' }).click();
  await page.getByText('已存的測試紀錄：1 筆').waitFor({ timeout: 3000 }).then(
    () => pass('C7 home shows 已存的測試紀錄：1 筆'),
    () => fail('C7 home shows 已存的測試紀錄：1 筆'),
  );

  // C8
  await page.getByLabel('測試情境').selectOption('X');
  await page.getByRole('button', { name: '開始', exact: true }).click();
  await page.waitForFunction(() => document.body.classList.contains('recording'), null, { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(3000);
  await page.reload({ waitUntil: 'load' });
  try {
    await page.getByText('已存的測試紀錄：2 筆').waitFor({ timeout: 3000 });
    const { json } = await downloadJson(page, page.getByRole('button', { name: '下載全部 JSON' }));
    const s2 = json.sessions?.[1];
    expect(
      json.sessions.length === 2 && s2.stoppedAt === null && s2.heartbeats.length >= 1,
      'C8 reload mid-session: 2 sessions, second has stoppedAt null and >= 1 heartbeat',
      { sessions: json.sessions.length, stoppedAt: s2?.stoppedAt, heartbeats: s2?.heartbeats?.length },
    );
  } catch (err) {
    fail('C8 reload mid-session: 2 sessions, second has stoppedAt null and >= 1 heartbeat', String(err));
  }

  // C9
  await press(page, page.getByRole('button', { name: '刪除全部' }), 2300);
  await page.waitForTimeout(500);
  expect((await page.getByText('已存的測試紀錄').count()) === 0, 'C9 long-press 刪除全部 clears stored sessions');

  // C10
  await page.waitForTimeout(200);
  const violations = await page.evaluate(() => window.__cspViolations);
  expect(violations.length === 0, 'C10 no CSP violations', violations);
  expect(consoleErrors.length === 0, 'C10 no console errors', consoleErrors);
  expect(pageErrors.length === 0, 'C10 no page errors', pageErrors);
  expect(failedRequests.length === 0, 'C10 no failed requests', failedRequests);
} catch (err) {
  fail('browser checks threw', err instanceof Error ? err.stack : String(err));
} finally {
  await browser?.close();
  await new Promise((r) => server.close(r));
}

if (failed) {
  console.log('\nDetails:');
  for (const d of details) console.log(`- ${d.check}:`, JSON.stringify(d.extra, null, 2));
  process.exit(1);
}
process.exit(0);
