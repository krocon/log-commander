#!/usr/bin/env node
// Screenshots for the docs: the production frontend in Playwright's WebKit with a small IPC mock
// (scripts/e2e/mock-ipc.js) fed from samples/. `npm run build` first. Writes docs/screenshots/.
import { createServer } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { webkit } from 'playwright';

const root = new URL('..', import.meta.url).pathname;
const dist = join(root, 'dist/log-commander/browser');
const outDir = join(root, 'docs/screenshots');
mkdirSync(outDir, { recursive: true });

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
};
const server = createServer((req, res) => {
  const path = normalize(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
  try {
    const body = readFileSync(join(dist, path));
    res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;

const files = {
  'app.log': readFileSync(join(root, 'samples/spring-boot.log'), 'utf8'),
  'worker.log': readFileSync(join(root, 'samples/python.log'), 'utf8'),
};

async function page(browser, { theme, withFiles = true }) {
  const context = await browser.newContext({
    viewport: { width: 1240, height: 680 },
    deviceScaleFactor: 2,
    colorScheme: theme,
  });
  const p = await context.newPage();
  p.on('pageerror', (e) => console.error('page error:', e.message));
  await p.addInitScript({ path: join(root, 'scripts/e2e/mock-ipc.js') });
  await p.addInitScript((data) => window.__mock.setup(data), {
    files: withFiles ? files : {},
    recent: ['/var/log/shop/app.log', '/srv/worker/worker.log', '/var/log/nginx/error.log'],
  });
  await p.goto(url);
  await p.waitForSelector(withFiles ? '.lt-cell' : 'app-start-screen');
  await p.waitForTimeout(200);
  return p;
}

const browser = await webkit.launch();
const shot = (p, name) => p.screenshot({ path: join(outDir, `${name}.png`) });

const dark = await page(browser, { theme: 'dark' });
await dark.click('.tab .title >> text=app.log');
await dark.waitForTimeout(150);
await shot(dark, 'dark');

// Detail panel (prompt 004): double click on the stack trace shows the whole entry below the log.
await dark.dblclick('.lt-cell >> text=Caused by');
await dark.waitForTimeout(300);
await dark.evaluate(() => getSelection()?.removeAllRanges());
await dark.waitForTimeout(100);
await shot(dark, 'detail');
await dark.keyboard.press('d');
await dark.keyboard.press('Escape');
await dark.waitForTimeout(150);

await dark.click('button:text-is("ERROR+")');
await dark.waitForTimeout(150);
await shot(dark, 'filter-error');
await dark.click('button:text-is("Alle")');

await dark.selectOption('select[aria-label=Suchmodus]', 'highlight');
await dark.fill('input[type=search]', 'order');
await dark.waitForTimeout(350);
await dark.keyboard.press('Enter');
await dark.waitForTimeout(150);
await shot(dark, 'search');

await dark.fill('input[type=search]', '');
await dark.waitForTimeout(350);
await dark.click('button[title=Einstellungen]');
await dark.waitForTimeout(150);
await shot(dark, 'settings');

const light = await page(browser, { theme: 'light' });
await light.click('.tab .title >> text=app.log');
await light.waitForTimeout(150);
await shot(light, 'light');

const start = await page(browser, { theme: 'dark', withFiles: false });
await shot(start, 'start');

await start.click('button:text-is("Pfad eingeben …")');
await start.fill('app-open-path-dialog input', '/tmp/app.log');
await start.waitForTimeout(150);
await shot(start, 'open-path');

const narrow = await page(browser, { theme: 'dark' });
await narrow.setViewportSize({ width: 760, height: 520 });
await narrow.waitForTimeout(200);
await shot(narrow, 'narrow');

await browser.close();
server.close();
console.log(`screenshots written to ${outDir}`);
