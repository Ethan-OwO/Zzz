// M5 browser checks (design_M5 §7.2). Serves dist/ with `vite preview` and drives it
// with Playwright Chromium, feeding synthetic DeviceMotionEvents into the page.
// CSP/header checks stay in check.mjs; vite preview does not apply _headers.
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { preview } from 'vite';

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

/** Press and hold a hold-button for ms. */
async function press(page, locator, ms) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('button not visible');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(ms);
  await page.mouse.up();
}

/** Reads both stores of the zzz-motion database. */
function readMotionDb(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const req = indexedDB.open('zzz-motion');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('sessions')) {
        db.close();
        resolve({ sessions: [], epochs: [] });
        return;
      }
      const tx = db.transaction(['sessions', 'epochs'], 'readonly');
      const a = tx.objectStore('sessions').getAll();
      const b = tx.objectStore('epochs').getAll();
      tx.oncomplete = () => {
        db.close();
        resolve({ sessions: a.result, epochs: b.result });
      };
    };
  }));
}

/**
 * Sends one sample every 20 ms for `sec` seconds. Between moveFrom and moveTo seconds
 * adds a 1 m/s² 2 Hz sine on z. Runs inside the page so timing does not depend on CDP.
 */
function feedMotion(page, sec, moveFrom, moveTo) {
  return page.evaluate(([sec, moveFrom, moveTo]) => new Promise((resolve) => {
    const t0 = performance.now();
    let seed = 7;
    const noise = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return (seed / 2147483648 - 0.5) * 0.01;
    };
    const id = setInterval(() => {
      const t = (performance.now() - t0) / 1000;
      if (t >= sec) {
        clearInterval(id);
        resolve();
        return;
      }
      const wiggle = t >= moveFrom && t < moveTo ? Math.sin(2 * Math.PI * 2 * t) : 0;
      window.dispatchEvent(new DeviceMotionEvent('devicemotion', {
        accelerationIncludingGravity: { x: noise(), y: noise(), z: 9.81 + noise() + wiggle },
        acceleration: { x: null, y: null, z: null },
        interval: 20,
      }));
    }, 20);
  }), [sec, moveFrom, moveTo]);
}

const server = await preview({
  configFile: false,
  root: new URL('..', import.meta.url).pathname,
  logLevel: 'error',
  preview: { host: '127.0.0.1', port: 4179, strictPort: false },
});
const baseUrl = server.resolvedUrls?.local?.[0] ?? 'http://127.0.0.1:4179/';

let browser;
try {
  browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });
  // Chromium also exposes DeviceMotionEvent.requestPermission, so grant the sensors.
  const context = await browser.newContext({ permissions: ['microphone', 'accelerometer', 'gyroscope'], acceptDownloads: true });
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    if (/wake ?lock/i.test(msg.text())) return; // headless may refuse wake lock
    consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(err.message));

  const url = `${baseUrl}?hb=2&me=2`;
  await page.goto(url, { waitUntil: 'load' });

  const bed = page.getByRole('radio', { name: /放床上/ });
  const stand = page.getByRole('radio', { name: /放床頭櫃/ });
  const start = page.getByRole('button', { name: '開始', exact: true });

  // C1
  expect(
    (await bed.count()) === 1 && (await stand.getAttribute('aria-checked')) === 'true' &&
      (await bed.getAttribute('aria-checked')) === 'false',
    'C1 home has the placement picker, defaulting to 放床頭櫃',
  );

  // C2
  await bed.click();
  const bedChecked = await bed.getAttribute('aria-checked');
  await page.reload({ waitUntil: 'load' });
  const afterReload = await page.getByRole('radio', { name: /放床頭櫃/ }).getAttribute('aria-checked');
  const lsLen = await page.evaluate(() => localStorage.length);
  expect(bedChecked === 'true' && afterReload === 'true' && lsLen === 0,
    'C2 picking 放床上 is not remembered across reloads and localStorage stays empty', { bedChecked, afterReload, lsLen });

  // C3 bed run: 8 s of samples (movement at 4–6 s), then 2 s with none, then stop.
  await page.getByRole('radio', { name: /放床上/ }).click();
  await page.waitForTimeout(300); // let the permission request settle
  const noHint = await page.locator('.placement-hint').isHidden();
  expect(noHint, 'C3 no permission hint shown when permission is granted or not required');
  await start.click();
  await page.waitForFunction(() => document.body.classList.contains('recording'), null, { timeout: 3000 });
  await feedMotion(page, 8, 4, 6);
  await page.waitForTimeout(2500);
  await page.mouse.click(10, 10);
  const liveText = await page.locator('[data-field="motion"]').textContent();
  expect(/Hz/.test(liveText ?? ''), 'C3 overlay shows a 動作 rate', liveText);
  await press(page, page.getByRole('button', { name: '長按 2 秒停止' }), 2300);
  await page.locator('dd[data-field="motion"]').waitFor({ timeout: 5000 });

  // C4
  const db = await readMotionDb(page);
  const s = db.sessions[0];
  const ep = [...db.epochs].sort((a, b) => a.idx - b.idx);
  const at = (sec) => ep.find((e) => e.startAt - s.startedAt <= sec * 1000 && e.endAt - s.startedAt > sec * 1000);
  const moving = at(5);
  const quiet = ep[0];
  expect(
    db.sessions.length === 1 && ['granted', 'not-required'].includes(s.permission) && s.stoppedAt !== null && s.quality === 'binary',
    'C4 one motion session, permission ok, stopped, quality binary',
    { sessions: db.sessions },
  );
  expect(ep.length >= 5 && ep.length <= 8, 'C4 epoch count 5–8 at 2 s epochs', ep.length);
  expect(!!moving && moving.activeSec >= 1 && quiet.activeSec === 0, 'C4 movement epoch active, first epoch still',
    ep.map((e) => ({ idx: e.idx, samples: e.samples, activeSec: e.activeSec, activity: +e.activity.toFixed(3) })));
  expect(ep.some((e) => e.samples === 0), 'C4 at least one empty epoch');
  console.log(`     C4 rates: ${ep.map((e) => e.rateHz.toFixed(0)).join(',')} Hz`);

  // C5
  const summary = await page.locator('dd[data-field="motion"]').textContent();
  expect(/品質 binary/.test(summary ?? ''), 'C5 result shows the motion summary', summary);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '下載全部 JSON' }).click(),
  ]);
  const json = JSON.parse(await readFile(await download.path(), 'utf8'));
  expect(Array.isArray(json.motion) && json.motion.length === 1 && json.motion[0].epochs.length === ep.length,
    'C5 exported JSON has motion with the epochs', { motion: json.motion?.length });

  // C6 nightstand run
  await page.getByRole('button', { name: '回首頁' }).click();
  await page.getByRole('radio', { name: /放床頭櫃/ }).click();
  await page.getByRole('button', { name: '開始', exact: true }).click();
  await page.waitForFunction(() => document.body.classList.contains('recording'), null, { timeout: 3000 });
  await feedMotion(page, 2, 99, 99);
  await page.mouse.click(10, 10);
  await press(page, page.getByRole('button', { name: '長按 2 秒停止' }), 2300);
  await page.locator('dd[data-field="motion"]').waitFor({ timeout: 5000 });
  const db2 = await readMotionDb(page);
  const summary2 = await page.locator('dd[data-field="motion"]').textContent();
  expect(db2.sessions.length === 1 && summary2 === '未啟用(床頭櫃)',
    'C6 nightstand run records no motion and says 未啟用(床頭櫃)', { sessions: db2.sessions.length, summary2 });

  // C7
  await press(page, page.getByRole('button', { name: '刪除全部' }), 2300);
  await page.waitForTimeout(500);
  const db3 = await readMotionDb(page);
  expect(db3.sessions.length === 0 && db3.epochs.length === 0, 'C7 刪除全部 also clears zzz-motion', db3);

  // C9 denied permission: a context without sensor permissions.
  {
    const ctx2 = await browser.newContext({ permissions: ['microphone'] });
    const p2 = await ctx2.newPage();
    await p2.goto(url, { waitUntil: 'load' });
    const hasPrompt = await p2.evaluate(() => typeof DeviceMotionEvent.requestPermission === 'function');
    if (hasPrompt) {
      await p2.getByRole('radio', { name: /放床上/ }).click();
      const hint = p2.locator('.placement-hint');
      await hint.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
      const text = await hint.textContent();
      expect(/只用聲音/.test(text ?? ''), 'C9 denied permission shows the audio-only hint', text);
      await p2.getByRole('button', { name: '開始', exact: true }).click();
      const rec = await p2.waitForFunction(() => document.body.classList.contains('recording'), null, { timeout: 3000 })
        .then(() => true, () => false);
      expect(rec, 'C9 recording still starts after a denied motion permission');
    } else {
      console.log('SKIP C9 (this Chromium has no DeviceMotionEvent.requestPermission)');
    }
    await ctx2.close();
  }

  // C8
  expect(consoleErrors.length === 0, 'C8 no console errors', consoleErrors);
  expect(pageErrors.length === 0, 'C8 no page errors', pageErrors);
} catch (err) {
  fail('motion browser checks threw', err instanceof Error ? err.stack : String(err));
} finally {
  await browser?.close();
  await new Promise((r) => server.httpServer.close(r));
}

if (failed) {
  console.log('\nDetails:');
  for (const d of details) console.log(`- ${d.check}:`, JSON.stringify(d.extra, null, 2));
  process.exit(1);
}
process.exit(0);
