// Local verification (M1–M4): static checks on dist/, then serve dist/ with the
// headers from dist/_headers and drive it with Playwright Chromium, using a
// synthetic WAV (scripts/make-fixture.mjs) as the microphone.
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
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

const FILE_RE = /^zzz-m4-\d{8}-\d{4}\.json$/;
const fixtureDir = await mkdtemp(join(tmpdir(), 'zzz-fixture-'));
const fixturePath = join(fixtureDir, 'mic.wav');
execFileSync(process.execPath, [fileURLToPath(new URL('./make-fixture.mjs', import.meta.url)), fixturePath]);

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
  const text = await readFile(await download.path(), 'utf8');
  return { name, text, json: JSON.parse(text) };
}

/** Reads every M3 store (chunks only as eventId/seq/length) straight from IndexedDB. */
function readDb(page) {
  return page.evaluate(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('zzz');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const all = (name) => new Promise((res, rej) => {
      const r = db.transaction(name, 'readonly').objectStore(name).getAll();
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const [nights, sessions, soundEvents, chunks, snoreEpisodes] = await Promise.all(
      ['nights', 'sessions', 'soundEvents', 'chunks', 'snoreEpisodes'].map(all));
    db.close();
    return {
      nights, sessions, soundEvents, snoreEpisodes,
      chunks: chunks.map((c) => ({ eventId: c.eventId, seq: c.seq, samples: c.pcm.byteLength / 2 })),
    };
  });
}

/** One event's audio, concatenated by seq, as a plain array. */
function readAudio(page, eventId) {
  return page.evaluate(async (id) => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('zzz');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const chunks = await new Promise((res, rej) => {
      const r = db.transaction('chunks', 'readonly').objectStore('chunks').getAll(IDBKeyRange.bound([id], [id, []]));
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    db.close();
    const out = [];
    for (const c of chunks) out.push(...new Int16Array(c.pcm));
    return out;
  }, eventId);
}

function rmsDb(samples) {
  if (samples.length === 0) return -120;
  let s = 0;
  for (const v of samples) s += (v / 32768) ** 2;
  return 10 * Math.log10(s / samples.length);
}

const isRecording = (page) => page.evaluate(() => document.body.classList.contains('recording'));
const waitRecording = (page, timeout = 5000) =>
  page.waitForFunction(() => document.body.classList.contains('recording'), null, { timeout }).then(() => true, () => false);

/** Home → 開始 → calibration finished (result step visible). */
async function startAndCalibrate(page) {
  await page.getByRole('button', { name: '開始', exact: true }).click();
  await page.getByRole('button', { name: '開始睡覺' }).waitFor({ timeout: 40000 });
}

async function stopRecording(page) {
  await page.mouse.click(10, 10);
  await press(page, page.getByRole('button', { name: '長按 2 秒停止' }), 2300);
  await page.locator('.timeline').waitFor({ timeout: 10000 });
}

async function deleteNightFromHome(page) {
  await press(page, page.getByRole('button', { name: '長按 2 秒刪除這一晚' }), 2300);
  await page.getByRole('button', { name: '開始', exact: true }).waitFor({ timeout: 5000 });
}

// ---------- 4. M4 checks (design_M4 §7.2): own Chromium with the M4 fixture ----------

const m4FixturePath = join(fixtureDir, 'mic-m4.wav');
execFileSync(process.execPath, [fileURLToPath(new URL('./make-fixture.mjs', import.meta.url)), '--m4', m4FixturePath]);

/** Every event's total chunk samples, by event id. */
function chunkSamples(db) {
  const m = new Map();
  for (const c of db.chunks) m.set(c.eventId, (m.get(c.eventId) ?? 0) + c.samples);
  return m;
}

async function m4Checks() {
  const b = await chromium.launch({
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${m4FixturePath}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  try {
    const context = await b.newContext({ permissions: ['microphone'], acceptDownloads: true });
    const page = await context.newPage();
    const consoleErrors = [];
    const pageErrors = [];
    const failedRequests = [];
    page.on('console', (msg) => {
      if (msg.type() !== 'error' || /wake ?lock/i.test(msg.text())) return;
      consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));
    page.on('requestfailed', (req) => failedRequests.push(`${req.url()} ${req.failure()?.errorText ?? ''}`));
    await page.addInitScript(() => {
      window.__cspViolations = [];
      document.addEventListener('securitypolicyviolation', (e) => {
        window.__cspViolations.push({ violatedDirective: e.violatedDirective, blockedURI: e.blockedURI });
      });
      // F1: remember whether the progress line ever said 分析聲音中.
      window.__sawProgress = false;
      new MutationObserver(() => {
        const p = document.querySelector('[data-field="classify-progress"]');
        if (p && !p.hidden && /分析聲音中/.test(p.textContent ?? '')) window.__sawProgress = true;
      }).observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
    });
    // dropconf=0: in formal mode every snore-classified event would lose its audio (F14);
    // test mode must ignore it (F15).
    await page.goto(`${baseUrl}?hb=2&cal=5&dropconf=0`, { waitUntil: 'load' });

    // F1 — test mode so the snore samples keep their audio and get classified.
    await startAndCalibrate(page);
    await page.getByRole('radio', { name: /測試/ }).check();
    await page.getByRole('button', { name: '開始睡覺' }).click();
    await waitRecording(page);
    const t0 = (await readDb(page)).sessions[0]?.startedAt ?? Date.now();
    const waitMs = t0 + 105_000 - Date.now();
    console.log(`     F1 waiting ${(waitMs / 1000).toFixed(0)} s for the M4 fixture to reach 105 s…`);
    if (waitMs > 0) await page.waitForTimeout(waitMs);
    await stopRecording(page);
    const doneOk = await page.waitForFunction(() => {
      const p = document.querySelector('[data-field="classify-progress"]');
      const c = document.querySelector('[data-field="class-summary"]');
      return p?.hidden === true && c && !/分析中/.test(c.textContent ?? '');
    }, null, { timeout: 60000 }).then(() => true, () => false);
    const saw = await page.evaluate(() => window.__sawProgress);
    expect(doneOk && saw, 'F1 result page shows 分析聲音中 and it goes away', { doneOk, saw });

    // F13
    console.log(`     F13 ${await page.locator('[data-field="classify-timing"]').textContent()}`);

    // F2
    const db = await readDb(page);
    const rel = (t) => (t - t0) / 1000;
    const evs = db.soundEvents.map((e) => ({ ...e, core: rel(e.coreStartAt) }));
    const summary = evs.map((e) => ({
      core: +e.core.toFixed(2), len: +(e.sampleCount / 16000).toFixed(2), sample: e.snoreEpisodeId !== null,
      snoreLike: e.snoreLike, cls: e.classification?.cls, conf: e.classification && +e.classification.confidence.toFixed(2),
      reason: e.classification?.reason,
    }));
    console.log(`     F2 sample: ${JSON.stringify(summary)}`);
    const withAudio = evs.filter((e) => e.hasAudio && e.sampleCount > 0);
    expect(db.nights[0]?.mode === 'test' && withAudio.length > 0 &&
      withAudio.every((e) => e.features?.version === 1 && e.classification && typeof e.classification.cls === 'string'),
      'F2 every event with audio has features (version 1) and a classification', summary);

    // F3 / F4 / F5
    const evTalk = evs.find((e) => Math.abs(e.core - 30) <= 1.5);
    const evRustle = evs.find((e) => Math.abs(e.core - 92) <= 1.5);
    const evKnock = evs.filter((e) => Math.abs(e.core - 100) <= 1.5);
    expect(evTalk?.classification?.cls === 'talk', 'F3 the event at 30 s ± 1.5 is talk', summary);
    expect(evRustle?.classification?.cls === 'other' && evKnock.every((e) => e.classification?.cls === 'other'),
      'F4 the event at 92 s ± 1.5 is other; any event at 100 s ± 1.5 is other', summary);
    const samples = evs.filter((e) => e.snoreEpisodeId !== null);
    expect(samples.length >= 1 && samples.every((e) => e.classification && e.classification.cls !== 'talk'),
      'F5 snore sample events exist, none is talk', summary);

    const row = (id) => page.locator(`li[data-event-id="${id}"]`);
    const labelBtn = (id, l) => row(id).locator(`button[data-label="${l}"]`);
    const labelText = () => page.locator('[data-field="label-summary"]');
    const dbEvent = async (id) => (await readDb(page)).soundEvents.find((e) => e.id === id);

    if (evTalk && evRustle) {
      // F6
      await labelBtn(evTalk.id, 'talk').click();
      await page.waitForTimeout(300);
      await page.reload({ waitUntil: 'load' });
      await page.getByRole('button', { name: '查看' }).click();
      await page.locator('.timeline').waitFor({ timeout: 10000 });
      await page.waitForFunction(() => document.querySelector('[data-field="classify-progress"]')?.hidden === true);
      const sel = await labelBtn(evTalk.id, 'talk').evaluate((el) => el.classList.contains('selected'));
      const lt = await labelText().textContent();
      expect(sel && (await dbEvent(evTalk.id))?.userLabel === 'talk' && lt === '已標記 1 段，和自動分類一致 100%',
        'F6 label 說話 survives a reload; summary 已標記 1 段，和自動分類一致 100%', { sel, lt });

      // F7
      await labelBtn(evTalk.id, 'talk').click();
      await page.waitForTimeout(300);
      expect((await dbEvent(evTalk.id))?.userLabel === null && !(await labelText().isVisible()),
        'F7 tapping 說話 again clears the label and hides the label line');

      // F8
      await labelBtn(evRustle.id, 'talk').click();
      await page.waitForTimeout(300);
      const clsText = await row(evRustle.id).locator('[data-field="class"]').textContent();
      const lt8 = await labelText().textContent();
      expect(/≠/.test(clsText ?? '') && /一致 0%$/.test(lt8 ?? ''), 'F8 labeling the 92 s event 說話 shows ≠ and 0% agreement', { clsText, lt8 });

      // F9
      const reminder = page.locator('[data-field="label-reminder"]');
      const before = await reminder.isVisible();
      const { name, text, json } = await downloadJson(page, page.getByRole('button', { name: '下載除錯 JSON' }));
      await page.waitForTimeout(300);
      const after = await reminder.isVisible();
      const jev = json.nights?.[0]?.soundEvents?.find((e) => e.id === evRustle.id);
      expect(before && !after && FILE_RE.test(name) && json.schema === 'zzz-m4/1' && json.classifyParams?.version === 1 &&
        json.featuresVersion === 1 && jev?.userLabel === 'talk' && jev?.features?.version === 1 && !text.includes('"pcm"'),
        'F9 reminder shows, download hides it; JSON zzz-m4/1 with classifyParams, featuresVersion, label and features, no pcm',
        { before, after, name, schema: json.schema });

      // F10
      const jsonPath = join(fixtureDir, 'f10.json');
      await import('node:fs/promises').then((fs) => fs.writeFile(jsonPath, text));
      let out = '';
      let code = 0;
      try {
        out = execFileSync(process.execPath, [fileURLToPath(new URL('./eval-labels.mjs', import.meta.url)), jsonPath], { encoding: 'utf8' });
      } catch (err) {
        code = err.status ?? 1;
        out = String(err.stdout ?? err);
      }
      const all = out.slice(out.indexOf('===== all modes'));
      const talkRow = all.split('\n').find((l) => /^\s+talk\s/.test(l))?.trim().split(/\s+/);
      expect(code === 0 && /n = 1 /.test(all) && talkRow?.[3] === '1',
        'F10 eval-labels.mjs on that JSON: exit 0, n = 1, matrix talk→other = 1', { code, talkRow });
    } else {
      fail('F6–F10 label checks', 'missing the 30 s or 92 s event');
    }

    // F11
    const epRow = page.locator('li[data-episode-id]').first();
    if ((await epRow.count()) === 1 && (await epRow.locator('button[data-label="snore"]').count()) === 1) {
      await epRow.locator('button[data-label="snore"]').click();
      await page.waitForTimeout(300);
      expect((await readDb(page)).snoreEpisodes[0]?.userLabel === 'snore', 'F11 是打呼 on the snore episode stores userLabel snore');
    } else {
      fail('F11 是打呼 on the snore episode stores userLabel snore', 'no episode row with label buttons');
    }

    // F12
    await page.locator('button[data-filter="talk"]').click();
    const visible = await page.locator('.timeline li:visible').evaluateAll((lis) => lis.map((li) => li.dataset.eventId ?? li.dataset.episodeId));
    const db12 = await readDb(page);
    const okVisible = visible.every((id) => {
      const e = db12.soundEvents.find((x) => x.id === id);
      return e && (e.classification?.cls === 'talk' || e.userLabel === 'talk');
    });
    expect(!!evTalk && visible.includes(evTalk.id) && okVisible, 'F12 filter 說話 shows only talk events (auto or labeled)', visible);
    await page.locator('button[data-filter="all"]').click();

    // F15 — test mode: leaving the page drops nothing.
    const chunksBefore = chunkSamples(await readDb(page));
    await page.getByRole('button', { name: '回首頁' }).click();
    await page.getByRole('button', { name: '查看' }).waitFor({ timeout: 10000 });
    const db15 = await readDb(page);
    const chunksAfter = chunkSamples(db15);
    expect(db15.soundEvents.every((e) => !e.audioDroppedAs) &&
      [...chunksBefore].every(([id, n]) => chunksAfter.get(id) === n),
      'F15 test mode + dropconf=0: leaving the result page deletes no audio');

    // F14 — the same night as formal (set in IndexedDB). The 92 s event was labeled talk in F8,
    // so it must keep its audio; the label exclusions themselves are unit-tested (D1).
    await page.evaluate(async () => {
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open('zzz');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      await new Promise((res, rej) => {
        const tx = db.transaction('nights', 'readwrite');
        const st = tx.objectStore('nights');
        const g = st.getAll();
        g.onsuccess = () => { for (const n of g.result) st.put({ ...n, mode: 'formal' }); };
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
      });
      db.close();
    });
    await page.getByRole('button', { name: '查看' }).click();
    await page.locator('.timeline').waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: '回首頁' }).click();
    await page.getByRole('button', { name: '查看' }).waitFor({ timeout: 10000 });
    const db14 = await readDb(page);
    const ch14 = chunkSamples(db14);
    const shouldGo = db14.soundEvents.filter((e) => e.userLabel !== 'talk' && e.userLabel !== 'other' &&
      (e.snoreEpisodeId !== null || e.classification?.cls === 'snore'));
    const gone = shouldGo.filter((e) => e.hasAudio === false && e.sampleCount === 0 && !ch14.has(e.id) &&
      (e.audioDroppedAs === 'snore' || !chunksBefore.has(e.id)) && e.startAt && e.coreStartAt && e.endAt && e.features);
    const kept = (id) => !!id && ch14.get(id) === chunksBefore.get(id) && db14.soundEvents.find((e) => e.id === id)?.hasAudio;
    expect(shouldGo.length >= 1 && gone.length === shouldGo.length && kept(evTalk?.id) && kept(evRustle?.id),
      'F14 formal + dropconf=0: snore events lose all audio (times and features kept); the talk event and the event labeled 說話 keep theirs',
      { shouldGo: shouldGo.length, gone: gone.length });

    // C10 for this page
    const violations = await page.evaluate(() => window.__cspViolations);
    expect(violations.length === 0 && consoleErrors.length === 0 && pageErrors.length === 0 && failedRequests.length === 0,
      'F C10 no CSP violations, console errors, page errors or failed requests', { violations, consoleErrors, pageErrors, failedRequests });
  } finally {
    await b.close();
  }
}

let browser;
try {
  browser = await chromium.launch({
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${fixturePath}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const context = await browser.newContext({ permissions: ['microphone'], acceptDownloads: true });
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    // Wake lock may be refused in headless Chromium; that is not a failure (design_M2 §7.2).
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

  const response = await page.goto(`${baseUrl}?hb=2&cal=5`, { waitUntil: 'load' });
  const gotCsp = response?.headers()['content-security-policy'];
  expect(gotCsp === expectedCsp, 'main document carries the CSP from _headers', { expected: expectedCsp, got: gotCsp });

  const heading = page.getByRole('heading', { name: 'Zzz', exact: true });
  expect((await heading.count()) === 1, 'heading "Zzz" is visible');

  // M1 env-check table, behind 環境檢查.
  const envButton = page.getByRole('button', { name: '環境檢查', exact: true });
  await envButton.click();
  const tables = page.locator('table');
  await tables.first().waitFor({ timeout: 5000 }).catch(() => {});
  const rowIds = await page.locator('table tbody tr').evaluateAll((rows) => rows.map((r) => r.dataset.id));
  expect((await tables.count()) === 1, 'clicking 環境檢查 renders one <table>');
  expect(JSON.stringify(rowIds) === JSON.stringify(EXPECTED_IDS), 'table has 8 rows with the expected ids in order', rowIds);
  await envButton.click();
  expect((await tables.count()) === 1, 'clicking 環境檢查 again still leaves exactly one <table>');

  // E1
  const startButton = page.getByRole('button', { name: '開始', exact: true });
  await startButton.waitFor({ timeout: 3000 }).catch(() => {});
  expect((await startButton.count()) === 1 && (await page.locator('select').count()) === 0,
    'E1 home has 開始 and no scenario select');

  // E2
  await startButton.click();
  const quietShown = await page.getByText('請保持安靜').waitFor({ timeout: 5000 }).then(() => true, () => false);
  const countdown = await page.locator('[data-field="countdown"]').textContent().catch(() => null);
  expect(quietShown && /^\d+$/.test(countdown ?? ''), 'E2 calibration screen shows 請保持安靜 and a countdown', { countdown });

  // E3
  try {
    await page.getByRole('button', { name: '開始睡覺' }).waitFor({ timeout: 40000 });
    const floorText = await page.locator('[data-field="cal-floor"]').textContent();
    const speechText = await page.locator('[data-field="cal-speech"]').textContent();
    const marginText = await page.locator('[data-field="cal-margin"]').textContent();
    const status = await page.locator('[data-field="cal-status"]').getAttribute('data-status');
    const floor = parseFloat(floorText);
    const speechDb = parseFloat(speechText);
    const margin = parseFloat(marginText.replace(/^背景 \+/, ''));
    expect(floor >= -63 && floor <= -57 && speechDb >= -34 && speechDb <= -24 && margin >= 12 && margin <= 18 && status === 'ok',
      'E3 calibration: floor -63..-57, speech -34..-24, margin 12..18, status ok', { floorText, speechText, marginText, status });
    console.log(`     E3 sample: 背景 ${floorText}, 說話 ${speechText}, 門檻 ${marginText}, ${status}`);
  } catch (err) {
    fail('E3 calibration: floor -63..-57, speech -34..-24, margin 12..18, status ok', String(err));
  }

  // E4 (+ M2 C2–C4 on the recording screen)
  await page.getByRole('button', { name: '開始睡覺' }).click();
  const recording = await waitRecording(page);
  const visibleText = await page.evaluate(() => document.body.innerText.trim());
  expect(recording && visibleText === '', 'E4 開始睡覺 enters body.recording with no visible text', { recording, visibleText });
  await page.mouse.click(10, 10);
  const stopButton = page.getByRole('button', { name: '長按 2 秒停止' });
  await page.waitForTimeout(1200);
  const ctxText = await page.locator('[data-field="ctx"]').textContent();
  const eventsText = await page.locator('[data-field="events"]').textContent();
  expect((await stopButton.isVisible()) && ctxText === 'running' && /個$/.test(eventsText ?? ''),
    'C3 tap shows the overlay: 長按 2 秒停止, AudioContext running, 事件 count', { ctxText, eventsText });
  await press(page, stopButton, 300);
  await page.waitForTimeout(300);
  expect(await isRecording(page), 'C4 short press keeps recording');

  // E5
  const t0 = (await readDb(page)).sessions[0]?.startedAt ?? Date.now();
  const waitMs = t0 + 100_000 - Date.now();
  console.log(`     waiting ${(waitMs / 1000).toFixed(0)} s for the fixture to reach 100 s…`);
  if (waitMs > 0) await page.waitForTimeout(waitMs);
  await stopRecording(page);
  expect(!(await isRecording(page)), 'E5 long press after fixture 100 s shows the result page');

  // E6
  const db = await readDb(page);
  const rel = (t) => (t - t0) / 1000;
  const evs = db.soundEvents.map((e) => ({ ...e, core: rel(e.coreStartAt) }));
  const evA = evs.find((e) => Math.abs(e.core - 30) <= 1.5);
  const evB = evs.find((e) => Math.abs(e.core - 67) <= 1.5);
  const samples = evs.filter((e) => e.snoreEpisodeId !== null);
  const others = evs.filter((e) => e !== evA && e !== evB && !samples.includes(e));
  const ep = db.snoreEpisodes[0];
  const summary = {
    nights: db.nights.map((n) => n.status),
    events: evs.map((e) => ({ core: +e.core.toFixed(2), len: +(e.sampleCount / 16000).toFixed(2), hasAudio: e.hasAudio,
      snore: e.snoreEpisodeId !== null, end: e.endReason, peak: e.peakDb })),
    episodes: db.snoreEpisodes.map((s) => ({ start: +rel(s.startAt).toFixed(2), end: s.endAt && +rel(s.endAt).toFixed(2),
      bursts: s.burstCount, median: +s.medianIntervalSec.toFixed(2), low: +s.meanLowRatio.toFixed(2), reason: s.endReason })),
  };
  console.log(`     E6 sample: ${JSON.stringify(summary)}`);
  expect(db.nights.length === 1 && db.nights[0].status === 'stopped', 'E6 exactly one night, status stopped', summary.nights);
  expect(!!evA && evA.hasAudio && evA.sampleCount / 16000 >= 10 && evA.sampleCount / 16000 <= 14,
    'E6a event A core start at 30 s ± 1.5, has audio, 10–14 s long', summary);
  expect(!!evB && evB.hasAudio && evB.snoreEpisodeId === null, 'E6b event B core start at 67 s ± 1.5, has audio, not a snore sample', summary);
  const sampleChunks = db.chunks.filter((c) => samples.some((e) => e.id === c.eventId));
  expect(samples.length >= 1 && samples.every((e) => !e.hasAudio && e.sampleCount === 0) && sampleChunks.length === 0,
    'E6c at least one snore sample event; formal mode kept no audio for it', summary);
  expect(others.length === 0, 'E6d no other events (no false triggers on background)', others);
  expect(db.snoreEpisodes.length === 1 && Math.abs(rel(ep.startAt) - 45) <= 1.5 && ep.burstCount >= 9 && ep.burstCount <= 10 &&
    ep.medianIntervalSec >= 3.8 && ep.medianIntervalSec <= 4.2,
    'E6 one snore episode from 45 s ± 1.5 with 9–10 bursts, median interval 3.8–4.2 s', summary.episodes);

  // E7
  if (evA) {
    const audio = await readAudio(page, evA.id);
    const at31 = Math.round((31 - rel(evA.startAt)) * 16000);
    const loud = rmsDb(audio.slice(at31 - 8000, at31 + 8000));
    const quiet = rmsDb(audio.slice(0, 16000));
    expect(audio.length === evA.sampleCount && loud - quiet >= 20,
      'E7 event A audio length = sampleCount, 31 s is >= 20 dB above the pre-roll', {
        length: audio.length, sampleCount: evA.sampleCount, loud, quiet,
      });
    console.log(`     E7 sample: ${audio.length} samples, 31 s ${loud.toFixed(1)} dBFS vs pre-roll ${quiet.toFixed(1)} dBFS`);
  } else {
    fail('E7 event A audio length = sampleCount, 31 s is >= 20 dB above the pre-roll', 'no event A');
  }

  // E8
  if (evA) {
    const play = page.locator(`li[data-event-id="${evA.id}"]`).getByRole('button', { name: '播放' });
    const errorsBefore = consoleErrors.length;
    // Watch the text with a MutationObserver: headless Chromium without an audio sink can finish
    // the buffer almost at once, turning the button back into 播放 before a poll would see 停止.
    await play.evaluate((el) => {
      window.__sawStop = false;
      new MutationObserver(() => {
        if (el.textContent === '停止') window.__sawStop = true;
      }).observe(el, { childList: true, characterData: true, subtree: true });
    });
    await play.click();
    const turned = await page.evaluate(() => window.__sawStop);
    await page.waitForTimeout(500);
    expect(turned && consoleErrors.length === errorsBefore,
      'E8 播放 on event A turns into 停止 without console errors', { text: await play.textContent() });
    await play.click();
  } else {
    fail('E8 播放 on event A turns into 停止 without console errors', 'no event A');
  }

  // E9
  try {
    const { name, text, json } = await downloadJson(page, page.getByRole('button', { name: '下載除錯 JSON' }));
    const n = json.nights?.[0];
    expect(FILE_RE.test(name) && json.schema === 'zzz-m4/1' && n?.soundEvents?.length === db.soundEvents.length &&
      n?.snoreEpisodes?.length === db.snoreEpisodes.length && n?.sessions?.[0]?.heartbeats?.length > 0 && !text.includes('"pcm"'),
      'E9 debug JSON: file name, schema zzz-m4/1, events, episodes and heartbeats, no pcm', {
        name, schema: json.schema, events: n?.soundEvents?.length, episodes: n?.snoreEpisodes?.length,
      });
    const hb = n?.sessions?.[0]?.heartbeats?.at(-1);
    console.log(`     E9 sample: ${name}, last heartbeat frames ${hb?.frames} floorDb ${hb?.floorDb} soundEventCount ${hb?.soundEventCount}`);
  } catch (err) {
    fail('E9 debug JSON: file name, schema zzz-m4/1, events, episodes and heartbeats, no pcm', String(err));
  }

  // E10
  await page.getByRole('button', { name: '回首頁' }).click();
  const kept = await page.getByText('上一晚的紀錄還在').waitFor({ timeout: 3000 }).then(() => true, () => false);
  expect(kept && (await page.getByRole('button', { name: '開始', exact: true }).count()) === 0,
    'E10 home shows 上一晚的紀錄還在 and no 開始');

  // E11
  try {
    await deleteNightFromHome(page);
    const after = await readDb(page);
    expect(after.nights.length + after.soundEvents.length + after.chunks.length + after.snoreEpisodes.length === 0,
      'E11 long-press delete: 開始 is back and nights / soundEvents / chunks / snoreEpisodes are empty', {
        nights: after.nights.length, events: after.soundEvents.length, chunks: after.chunks.length,
      });
  } catch (err) {
    fail('E11 long-press delete: 開始 is back and nights / soundEvents / chunks / snoreEpisodes are empty', String(err));
  }

  // E12
  try {
    await startAndCalibrate(page);
    // Test mode for this night: the trigger margin shown drops by testMarginOffsetDb (1 dB).
    const marginOf = async () => parseFloat((await page.locator('[data-field="cal-margin"]').textContent()).replace(/^背景 \+/, ''));
    const formalMargin = await marginOf();
    await page.getByRole('radio', { name: /測試/ }).check();
    const testMargin = await marginOf();
    await page.getByRole('button', { name: '開始睡覺' }).click();
    await waitRecording(page);
    const d12 = await readDb(page);
    expect(d12.nights[0]?.mode === 'test' && Math.abs(Math.max(6, formalMargin - 1) - testMargin) < 1e-9 && testMargin < formalMargin,
      'E12a choosing 測試 lowers the shown margin by 1 dB and stores mode test', { formalMargin, testMargin, mode: d12.nights[0]?.mode });
    await page.waitForTimeout(5000);
    await page.reload({ waitUntil: 'load' });
    const shown = await page.getByText('上次監測沒有正常結束').waitFor({ timeout: 5000 }).then(() => true, () => false);
    expect(shown, 'E12 reload while recording shows 上次監測沒有正常結束');

    // E13
    await page.getByRole('button', { name: '繼續監測' }).click();
    const rec2 = await waitRecording(page);
    const d13 = await readDb(page);
    expect(rec2 && d13.nights.length === 1 && d13.sessions.filter((s) => s.nightId === d13.nights[0].id).length === 2,
      'E13 繼續監測 records again in the same night with 2 sessions', { rec2, sessions: d13.sessions.length });
    await page.waitForTimeout(3000);
    await stopRecording(page);
    pass('E13 stop after resuming shows the result page');
  } catch (err) {
    fail('E12/E13 reload and resume', String(err));
  }

  // E14
  try {
    await page.getByRole('button', { name: '回首頁' }).click();
    await deleteNightFromHome(page);
    await startAndCalibrate(page);
    await page.getByRole('button', { name: '開始睡覺' }).click();
    await waitRecording(page);
    await page.waitForTimeout(5000);
    await page.reload({ waitUntil: 'load' });
    await page.getByRole('button', { name: '結束並查看' }).click({ timeout: 5000 });
    await page.locator('.timeline').waitFor({ timeout: 5000 });
    const d14 = await readDb(page);
    expect(d14.nights.length === 1 && d14.nights[0].status === 'stopped' && d14.sessions.every((s) => s.stoppedAt !== null),
      'E14 reload then 結束並查看: result page, night stopped', { nights: d14.nights.map((n) => n.status) });
  } catch (err) {
    fail('E14 reload then 結束並查看: result page, night stopped', String(err));
  }

  // E15
  try {
    await page.getByRole('button', { name: '回首頁' }).click();
    await deleteNightFromHome(page);
    await page.getByRole('button', { name: '開始', exact: true }).click();
    await page.getByText('請保持安靜').waitFor({ timeout: 5000 });
    await page.waitForTimeout(1500);
    await page.reload({ waitUntil: 'load' });
    await page.getByText('上次校準沒有完成').waitFor({ timeout: 5000 });
    await page.getByRole('button', { name: '重新開始' }).click();
    await page.getByRole('button', { name: '開始', exact: true }).waitFor({ timeout: 5000 });
    const d15 = await readDb(page);
    expect(d15.nights.length === 0, 'E15 reload during calibration: 上次校準沒有完成 → 重新開始 → home with 開始', d15.nights);
  } catch (err) {
    fail('E15 reload during calibration: 上次校準沒有完成 → 重新開始 → home with 開始', String(err));
  }

  // C10
  await page.waitForTimeout(200);
  const violations = await page.evaluate(() => window.__cspViolations);
  expect(violations.length === 0, 'C10 no CSP violations', violations);
  expect(consoleErrors.length === 0, 'C10 no console errors', consoleErrors);
  expect(pageErrors.length === 0, 'C10 no page errors', pageErrors);
  expect(failedRequests.length === 0, 'C10 no failed requests', failedRequests);

  await browser.close();
  browser = undefined;
  await m4Checks();
} catch (err) {
  fail('browser checks threw', err instanceof Error ? err.stack : String(err));
} finally {
  await browser?.close();
  await new Promise((r) => server.close(r));
  await rm(fixtureDir, { recursive: true, force: true });
}

if (failed) {
  console.log('\nDetails:');
  for (const d of details) console.log(`- ${d.check}:`, JSON.stringify(d.extra, null, 2));
  process.exit(1);
}
process.exit(0);
