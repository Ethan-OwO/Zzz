// M1 local verification: static checks on dist/, then serve dist/ with the
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

let browser;
try {
  browser = await chromium.launch();
  const page = await browser.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(err.message));
  page.on('requestfailed', (req) => failedRequests.push(`${req.url()} ${req.failure()?.errorText ?? ''}`));

  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__cspViolations.push({ violatedDirective: e.violatedDirective, blockedURI: e.blockedURI });
    });
  });

  const response = await page.goto(baseUrl, { waitUntil: 'load' });
  const gotCsp = response?.headers()['content-security-policy'];
  expect(
    gotCsp === expectedCsp,
    'main document carries the CSP from _headers',
    { expected: expectedCsp, got: gotCsp },
  );

  const heading = page.getByRole('heading', { name: 'Zzz', exact: true });
  expect((await heading.count()) === 1, 'heading "Zzz" is visible');
  const button = page.getByRole('button', { name: '開始', exact: true });
  expect((await button.count()) === 1, 'button "開始" is visible');

  if ((await button.count()) === 1) {
    await button.click();
    const tables = page.locator('table');
    await tables.first().waitFor({ timeout: 5000 }).catch(() => {});
    const rowIds = await page.locator('table tbody tr').evaluateAll((rows) => rows.map((r) => r.dataset.id));
    expect((await tables.count()) === 1, 'clicking 開始 renders one <table>');
    expect(
      JSON.stringify(rowIds) === JSON.stringify(EXPECTED_IDS),
      'table has 8 rows with the expected ids in order',
      rowIds,
    );

    await button.click();
    expect((await tables.count()) === 1, 'clicking 開始 again still leaves exactly one <table>');
  }

  // Let any late violation/console events flush.
  await page.waitForTimeout(200);
  const violations = await page.evaluate(() => window.__cspViolations);
  expect(violations.length === 0, 'no CSP violations', violations);
  expect(consoleErrors.length === 0, 'no console errors', consoleErrors);
  expect(pageErrors.length === 0, 'no page errors', pageErrors);
  expect(failedRequests.length === 0, 'no failed requests', failedRequests);
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
