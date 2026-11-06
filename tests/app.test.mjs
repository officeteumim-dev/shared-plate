// Automated checks of the app in preview mode (sample household in memory: no sign-in, no Firebase).
// Run locally: cd tests && npm install && npx playwright install chromium && npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from 'playwright';
import { serve } from './serve.mjs';

let server, browser, base;
before(async () => {
  server = await serve(path.resolve(import.meta.dirname, '../public'));
  base = `http://localhost:${server.address().port}`;
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); server?.close(); });

async function open(opts = {}) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, colorScheme: opts.dark ? 'dark' : 'light' });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  // Fonts and Firebase come from CDNs; the preview doesn't need them, and blocking keeps the tests offline-safe.
  await page.route(/gstatic\.com|fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ status: 200, body: '' }));
  await page.goto(`${base}/?preview`);
  await page.waitForSelector('.lane.mine');
  return { page, errors };
}
const laneTitles = (page, lane) => page.$$eval(`section.lane.${lane} .title`, els => els.map(e => e.textContent.trim()));

test('dashboard shows the three lanes with the other person’s name', async () => {
  const { page, errors } = await open();
  const heads = await page.$$eval('.lane-head h3', els => els.map(e => e.textContent));
  assert.deepEqual(heads, ['Mine', 'Leah’s', 'Shared']);
  assert.ok((await laneTitles(page, 'mine')).includes('Pay the electric bill'));
  assert.ok((await laneTitles(page, 'theirs')).includes('Take out recycling'), 'claimed shared task is in Leah’s lane');
  assert.ok((await laneTitles(page, 'shared')).includes('Call the plumber about the kitchen sink'));
  assert.deepEqual(errors, []);
});

test('today strip lists overdue and today’s tasks, not later ones', async () => {
  const { page } = await open();
  const chips = await page.$$eval('.today .chip .t', els => els.map(e => e.textContent));
  assert.ok(chips.includes('Pay the electric bill'));
  assert.ok(chips.includes('Pick up challah'));
  assert.ok(!chips.includes('Renew car registration'));
});

test('an old unclaimed shared task gets a gentle nudge', async () => {
  const { page } = await open();
  const nudges = await page.$$eval('.nudge', els => els.map(e => e.closest('.task').querySelector('.title').textContent));
  assert.deepEqual(nudges, ['Call the plumber about the kitchen sink']);
});

test('“Take it” moves a shared task to my lane', async () => {
  const { page } = await open();
  await page.click('section.lane.shared .row-wrap:has-text("Order birthday gift") [data-act=take]');
  await page.waitForFunction(() => [...document.querySelectorAll('section.lane.mine .title')].some(e => e.textContent.includes('Order birthday gift')));
  assert.match(await page.textContent('section.lane.mine'), /Shared, you took it/);
  assert.ok(!(await laneTitles(page, 'shared')).includes('Order birthday gift for Grandma'));
});

test('quick add puts a task in the chosen lane', async () => {
  const { page, errors } = await open();
  await page.click('.fab');
  await page.fill('#task-form [name=title]', 'Buy light bulbs');
  await page.click('#owner-seg [data-owner=shared]');
  await page.click('#task-form [type=submit]');
  await page.waitForFunction(() => [...document.querySelectorAll('section.lane.shared .title')].some(e => e.textContent === 'Buy light bulbs'));
  assert.deepEqual(errors, []);
});

test('a repeating task needs a due date', async () => {
  const { page } = await open();
  await page.click('.fab');
  await page.fill('#task-form [name=title]', 'Water plants');
  await page.click('#task-form details.more summary');
  await page.selectOption('#task-form [name=repeat]', 'weekly');
  await page.click('#task-form [type=submit]');
  assert.match(await page.textContent('#task-err'), /due date/);
});

test('marking done moves it to Completed, and Undo brings it back', async () => {
  const { page } = await open();
  await page.click('section.lane.mine .row-wrap:has-text("Renew car registration") [data-act=done]');
  await page.waitForFunction(() => ![...document.querySelectorAll('section.lane.mine .title')].some(e => e.textContent.includes('Renew car')));
  await page.click('[data-act=show-done]');
  assert.match(await page.textContent('main'), /Renew car registration/);
  await page.click('.done-list .row-wrap:has-text("Renew car registration") [data-act=undo]');
  await page.click('[data-act=home]');
  await page.waitForFunction(() => [...document.querySelectorAll('section.lane.mine .title')].some(e => e.textContent.includes('Renew car')));
});

test('finishing a repeating task schedules the next one', async () => {
  const { page } = await open();
  await page.click('section.lane.mine .row-wrap:has-text("Pick up challah") [data-act=done]');
  await page.waitForFunction(() => /Next one/.test(document.querySelector('#toast')?.textContent || ''));
  const titles = await laneTitles(page, 'mine');
  assert.ok(titles.includes('Pick up challah'), 'the next week’s copy is on the plate');
  const meta = await page.textContent('section.lane.mine .row-wrap:has-text("Pick up challah") .meta');
  assert.doesNotMatch(meta, /Today/);
});

test('swiping a task to the right marks it done', async () => {
  const { page } = await open();
  const row = page.locator('section.lane.mine .row-wrap:has-text("Renew car registration") .task');
  const box = await row.boundingBox();
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 60, y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(box.x + 60 + i * 26, y);
  await page.mouse.up();
  await page.waitForFunction(() => ![...document.querySelectorAll('section.lane.mine .title')].some(e => e.textContent.includes('Renew car')));
});

test('snoozing hides a task until its date', async () => {
  const { page } = await open();
  await page.click('section.lane.mine .row-wrap:has-text("Renew car registration") [data-act=edit]');
  await page.click('[data-act=snooze-menu]');
  await page.click('[data-snooze]:has-text("Tomorrow")');
  await page.waitForFunction(() => ![...document.querySelectorAll('section.lane.mine .title')].some(e => e.textContent.includes('Renew car')));
  assert.match(await page.textContent('details.more summary'), /Snoozed \(2\)/);
});

test('settings show quiet hours and the invite code', async () => {
  const { page, errors } = await open();
  await page.click('[data-act=settings]');
  assert.equal(await page.inputValue('#q-start'), '22:00');
  assert.match(await page.textContent('.code'), /PLATE234/);
  assert.deepEqual(errors, []);
});

test('the phone layout has no sideways scrolling, in light and dark mode', async () => {
  for (const dark of [false, true]) {
    const { page } = await open({ dark });
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(over <= 0, `page is ${over}px too wide`);
  }
});

test('tap targets are at least 44px', async () => {
  const { page } = await open();
  const small = await page.$$eval('main button', els => els.filter(e => {
    const r = e.getBoundingClientRect(); return r.width && (r.height < 44 || r.width < 44);
  }).map(e => e.outerHTML.slice(0, 80)));
  assert.deepEqual(small, []);
});

test('the manifest and service worker are in place', async () => {
  const res = await fetch(`${base}/manifest.webmanifest`);
  const m = await res.json();
  assert.equal(m.display, 'standalone');
  assert.ok(m.icons.some(i => i.purpose === 'maskable'));
  assert.equal((await fetch(`${base}/sw.js`)).status, 200);
});
