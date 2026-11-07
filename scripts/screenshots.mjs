#!/usr/bin/env node
// Screenshots for the docs: the production frontend in Playwright's WebKit with a small IPC mock
// (scripts/e2e/mock-ipc.js) fed from samples/. `npm run build` first. Writes docs/screenshots/.
import { createServer } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { webkit } from 'playwright';
import { makeEntry } from './gen-log.mjs';

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

async function page(browser, { theme, withFiles = true, only = null }) {
  const context = await browser.newContext({
    viewport: { width: 1240, height: 680 },
    deviceScaleFactor: 2,
    colorScheme: theme,
  });
  const p = await context.newPage();
  p.on('pageerror', (e) => console.error('page error:', e.message));
  await p.addInitScript({ path: join(root, 'scripts/e2e/mock-ipc.js') });
  await p.addInitScript((data) => window.__mock.setup(data), {
    files: only ?? (withFiles ? files : {}),
    recent: ['/var/log/shop/app.log', '/srv/worker/worker.log', '/var/log/nginx/error.log'],
  });
  await p.goto(url);
  await p.waitForSelector(withFiles ? '.lt-cell' : 'app-start-screen');
  await p.waitForTimeout(200);
  return p;
}

const browser = await webkit.launch();
// The overview ruler loads at most twice a second (prompt 007): give it that time before each picture.
const shot = async (p, name) => {
  await p.waitForTimeout(600);
  await p.screenshot({ path: join(outDir, `${name}.png`) });
};

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

// Sidebar (prompt 005): the active filter in the tree, saved under a name, the statistics below.
await dark.fill('input[type=search]', 'order');
await dark.waitForTimeout(350);
await dark.click('app-log-tree button.save');
await dark.fill('app-log-tree input.name', 'Fehler zu Bestellungen');
await dark.keyboard.press('Enter');
await dark.waitForTimeout(200);
await shot(dark, 'sidebar');
await dark.fill('input[type=search]', '');
await dark.waitForTimeout(350);
await dark.click('button:text-is("Alle")');

// Filter tree (prompt 010): two conditions joined with OR, added through the form.
const addCondition = async (button, text) => {
  await dark.click(button);
  await dark.waitForSelector('app-condition-dialog dialog[open]');
  await dark.fill('app-condition-dialog #cond-text', text);
  await dark.click('app-condition-dialog button[type=submit]:not([disabled])');
  await dark.waitForTimeout(300);
};
await addCondition('app-log-tree [role=treeitem].kind-file.current button.add', 'order');
await addCondition('app-log-tree [role=treeitem].kind-expr-group button.add', 'Pool usage');
await dark.click('app-log-tree [role=treeitem].kind-expr-group button.op');
await dark.waitForTimeout(300);
await shot(dark, 'filter-tree');
await dark.click('app-log-tree [role=treeitem].kind-expr-group button[aria-label$="entfernen"]');
await dark.waitForTimeout(300);

await dark.selectOption('select[aria-label=Suchmodus]', 'highlight');
await dark.fill('input[type=search]', 'order');
await dark.waitForTimeout(350);
await dark.keyboard.press('Enter');
await dark.waitForTimeout(150);
await shot(dark, 'search');

await dark.fill('input[type=search]', '');
await dark.waitForTimeout(350);
await dark.selectOption('select[aria-label=Suchmodus]', 'filter');

// Filter tabs (prompt 013): ERROR+ as a tab of its own, in it only the orders, the chain in tab and tree.
await dark.click('button:text-is("ERROR+")');
await dark.waitForTimeout(150);
await dark.click('button.filter-tab');
await dark.waitForSelector('.tab.view.active');
await dark.fill('input[type=search]', 'order');
await dark.waitForTimeout(400);
await dark.evaluate(() => document.activeElement?.blur());
await shot(dark, 'drilldown');
await dark.click('.tab.view .close');
await dark.waitForTimeout(150);
await dark.click('.tab .title >> text=app.log');
await dark.click('button:text-is("Alle")');
await dark.waitForTimeout(150);
await dark.click('button[title=Einstellungen]');
await dark.waitForTimeout(150);
await shot(dark, 'settings');
await dark.keyboard.press('Escape');
await dark.waitForTimeout(150);

// Merge (prompt 006): both open files ticked in the dialog, then one tab in time order, the source in the gutter.
await dark.keyboard.press('Meta+Shift+M');
await dark.waitForSelector('app-merge-dialog dialog[open]');
for (const box of await dark.$$('app-merge-dialog .open-tab input')) await box.check();
await dark.waitForTimeout(300);
await shot(dark, 'merge-dialog');
await dark.click('app-merge-dialog button[type=submit]');
await dark.waitForSelector('.lt-gutter.lt-src');
await dark.waitForTimeout(300);
await shot(dark, 'merge');

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

// Extracted fields (prompt 011): the suggestions of a log with measurements, then the new columns.
const metrics = await page(browser, {
  theme: 'dark',
  only: { 'metrics.log': readFileSync(join(root, 'samples/metrics.log'), 'utf8') },
});
await metrics.click('button.fields-button');
await metrics.waitForSelector('app-fields-dialog tr.suggestion');
await shot(metrics, 'fields');
await metrics.click('app-fields-dialog button:text-is("Ausgewählte übernehmen")');
await metrics.waitForSelector('app-fields-dialog tr.rule');
await metrics.click('app-fields-dialog button:text-is("Schließen")');
// The new columns come last: scroll right to them.
await metrics.waitForTimeout(300);
const scrollRight = () =>
  metrics.evaluate(() => {
    const viewport = document.querySelector('app-log-table-view .ge-table-scroll-viewport');
    viewport.scrollLeft = viewport.scrollWidth;
    viewport.dispatchEvent(new Event('scroll'));
  });
await scrollRight();
await metrics.waitForSelector('.lt-cell[data-col=cpu]:not(.lt-spanned)');
// The last column widens to its content once drawn: once more to the end.
await metrics.waitForTimeout(300);
await scrollRight();
await shot(metrics, 'extracted');

// Overview ruler on a dense log: a burst like the demo (every level everywhere), a quiet stretch with a single
// ERROR and WARN, then another burst. Shows the densities per lane and that the lone error stays visible.
{
  let state = 815;
  const random = () => (state = (state * 16807) % 2147483647) / 2147483647;
  const start = Date.UTC(2026, 0, 15, 9);
  const at = (i) => new Date(start + i * 200);
  let text = '';
  let i = 0;
  for (; i < 6000; i++) text += `${makeEntry('spring', at(i), random, 0.2)}\n`;
  for (let quiet = 0; quiet < 12000; quiet++, i++) {
    const level = quiet === 5000 ? 'ERROR' : quiet === 9000 ? ' WARN' : ' INFO';
    text += `${at(i).toISOString()}  ${level} 4711 --- [worker-1] c.a.service.Handler : ${level.trim() === 'INFO' ? 'heartbeat ok' : 'payment gateway timed out'}\n`;
  }
  for (const end = i + 3000; i < end; i++) text += `${makeEntry('spring', at(i), random, 0.2)}\n`;
  for (const theme of ['dark', 'light']) {
    const dense = await page(browser, { theme, only: { 'demo.log': text } });
    await shot(dense, theme === 'dark' ? 'ruler-dense' : 'ruler-dense-light');
  }
}

// Dashboard (prompt 012): two hours of a shop with measurements, the default panels.
{
  let state = 4711;
  const random = () => (state = (state * 16807) % 2147483647) / 2147483647;
  const start = Date.UTC(2026, 0, 15, 9);
  let text = '';
  for (let i = 0; i < 1400; i++) {
    text += `${makeEntry('spring', new Date(start + i * 5000 + Math.floor(random() * 4000)), random, 0.2, true)}\n`;
  }
  for (const theme of ['dark', 'light']) {
    const dash = await page(browser, { theme, only: { 'shop.log': text } });
    await dash.keyboard.press('Meta+Shift+D');
    await dash.waitForSelector('app-dashboard-panel .rc[data-ready="1"]');
    await dash.waitForTimeout(500);
    await shot(dash, theme === 'dark' ? 'dashboard' : 'dashboard-light');
    if (theme === 'dark') {
      await dash.click('app-dashboard button.schema-toggle');
      await dash.click('app-dashboard-panel:first-of-type button.edit');
      await dash.waitForTimeout(300);
      await shot(dash, 'dashboard-sql');
    }
  }
}

const narrow = await page(browser, { theme: 'dark' });
await narrow.setViewportSize({ width: 760, height: 520 });
await narrow.waitForTimeout(200);
await shot(narrow, 'narrow');

await browser.close();
server.close();
console.log(`screenshots written to ${outDir}`);
