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
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, colorScheme: opts.dark ? 'dark' : 'light', timezoneId: 'America/New_York' });
  // A fixed Friday morning, so "today", "overdue" and the sample tasks look the same whenever the tests run.
  await page.clock.setFixedTime(new Date(opts.at || '2026-11-06T09:00:00-05:00'));
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  // Fonts and Firebase come from CDNs; the preview doesn't need them, and blocking keeps the tests offline-safe.
  await page.route(/gstatic\.com|fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ status: 200, body: '' }));
  await page.goto(`${base}/?preview`);
  await page.waitForSelector('.lane.mine');
  return { page, errors };
}
// Task titles without the small priority badge in front.
const titleText = e => { const c = e.cloneNode(true); c.querySelectorAll('.prio').forEach(p => p.remove()); return c.textContent.trim(); };
const laneTitles = (page, lane) => page.$$eval(`section.lane.${lane} > ul .title`, (els, f) => els.map(new Function('return ' + f)()), titleText.toString());

test('dashboard shows the three lanes with the other person’s name', async () => {
  const { page, errors } = await open();
  const heads = await page.$$eval('.lane-head h3', els => els.map(e => e.textContent));
  assert.deepEqual(heads, ['Mine', 'Leah’s', 'Shared']);
  assert.ok((await laneTitles(page, 'mine')).includes('Pay the electric bill'));
  assert.ok((await laneTitles(page, 'theirs')).includes('Take out recycling'), 'claimed shared task is in Leah’s lane');
  assert.ok((await laneTitles(page, 'shared')).includes('Call the plumber about the kitchen sink'));
  assert.deepEqual(errors, []);
});

test('overdue tasks sit at the top of their own tile, with nothing above the tiles', async () => {
  const { page, errors } = await open();
  assert.equal(await page.$('nav.today'), null, 'no strip above the tiles');
  const firstHead = await page.$eval('section.lane.mine .cat-head', e => e.textContent);
  assert.equal(firstHead, 'Overdue');
  const late = await page.$$eval('section.lane.mine > ul.overdue .title', (els, f) => els.map(new Function('return ' + f)()), titleText.toString());
  assert.deepEqual(late, ['Pay the electric bill']);
  // The overdue list comes before the tile's other tasks.
  const order = await page.$$eval('section.lane.mine > ul', els => els.map(e => e.classList.contains('overdue')));
  assert.equal(order[0], true);
  assert.deepEqual(errors, []);
});

test('the chat line sends a message to the assistant, which adds it to the plate', async () => {
  const { page, errors } = await open();
  await page.fill('#ask-line input', 'Add call the dentist');
  await page.press('#ask-line input', 'Enter');
  await page.waitForSelector('.assistant-view');
  await page.waitForFunction(() => [...document.querySelectorAll('#chat .msg:not(.mine) .bubble')].some(e => e.textContent.includes('Call the dentist')));
  const mine = await page.$$eval('#chat .msg.mine .bubble', els => els.map(e => e.textContent));
  assert.deepEqual(mine, ['Add call the dentist']);
  assert.ok(await page.$('#chat .msg .when'), 'says the plate was updated');
  // Back on the dashboard it's on my tile, and the chat is still there next time.
  await page.click('[data-act=home]');
  assert.ok((await laneTitles(page, 'mine')).includes('Call the dentist'));
  await page.fill('#ask-line input', 'what is up');
  await page.click('#ask-line .send');
  await page.waitForFunction(() => document.querySelectorAll('#chat .msg:not(.mine)').length === 2);
  assert.equal(await page.$$eval('#chat .msg.mine', e => e.length), 2);
  // Examples show on an empty chat.
  await page.click('[data-act=chat-clear]');
  assert.ok(await page.$('[data-act=chat-example]'));
  assert.deepEqual(errors, []);
});

test('Hours: totals per client and person, a timer, and logging time by hand', async () => {
  const { page, errors } = await open();
  await page.click('[data-act=hours]');
  await page.waitForSelector('.hrs-sum');
  const head = await page.$$eval('.hrs-sum thead th', els => els.map(e => e.textContent));
  assert.deepEqual(head, ['Client', 'Avi', 'Leah', 'Total']);
  const rows = await page.$$eval('.hrs-sum tbody tr', trs => trs.map(tr => [...tr.children].map(c => c.textContent)));
  assert.deepEqual(rows, [['Acme Dental', '1h 30m', '2h', '3h 30m$297.50'], ['Brightside Realty', '–', '45m', '45m']]);
  assert.equal(await page.$eval('.hrs-sum tfoot td:last-child', e => e.textContent), '4h 15m$297.50');
  // Start a timer for Leah on Cohen & Co; it shows as running, and on the dashboard clock for her only.
  await page.click('[data-act=hrs-who]:has-text("Leah")');
  await page.click('[data-act=hrs-client]:has-text("Cohen & Co")');
  await page.click('[data-act=hrs-start]');
  await page.waitForSelector('.hrs-running li');
  assert.match(await page.$eval('.hrs-running li', e => e.textContent), /Cohen & Co[\s\S]*Leah/);
  await page.clock.setFixedTime(new Date('2026-11-06T10:05:00-05:00'));
  await page.click('.hrs-running [data-act=hrs-stop]');
  await page.waitForFunction(() => !document.querySelector('.hrs-running'));
  const cohen = await page.$$eval('.hrs-sum tbody tr', trs => trs.map(tr => [...tr.children].map(c => c.textContent).join('|')).find(t => t.startsWith('Cohen')));
  assert.equal(cohen, 'Cohen & Co|–|1h 5m|1h 5m$65.00');
  // Log time by hand for me.
  await page.click('[data-act=hrs-log]');
  await page.click('#hrs-form-who [data-uid=me]');
  await page.selectOption('#hrs-form select[name=client]', { label: 'Brightside Realty' });
  await page.fill('#hrs-form [name=dur]', 'lots');
  await page.click('#hrs-form [type=submit]');
  assert.ok(await page.$('#hrs-form'), 'a bad duration keeps the sheet open');
  await page.fill('#hrs-form [name=dur]', '1.25');
  await page.fill('#hrs-form [name=note]', 'Listing photos');
  await page.click('#hrs-form [type=submit]');
  await page.waitForFunction(() => [...document.querySelectorAll('.hrs-entry')].some(e => e.textContent.includes('Listing photos')));
  const bright = await page.$$eval('.hrs-sum tbody tr', trs => trs.map(tr => [...tr.children].map(c => c.textContent).join('|')).find(t => t.startsWith('Brightside')));
  assert.equal(bright, 'Brightside Realty|1h 15m|45m|2h');
  // Tapping a client shows only its entries.
  await page.click('.hrs-sum [data-act=hrs-filter]:has-text("Acme Dental")');
  const whats = await page.$$eval('.hrs-entry b', els => [...new Set(els.map(e => e.textContent))]);
  assert.deepEqual(whats, ['Acme Dental']);
  // Last month has the older entry.
  await page.click('[data-act=hrs-filter][data-id=""]');
  await page.click('[data-act=hrs-period][data-key=lastmonth]');
  assert.ok(await page.$('.hrs-sum') || await page.$('.empty'));
  assert.deepEqual(errors, []);
});

test('Hours: add a client with a rate, edit and delete an entry', async () => {
  const { page, errors } = await open();
  await page.click('[data-act=hours]');
  await page.click('[data-act=hrs-new-client]');
  await page.fill('#client-form [name=name]', 'acme dental');
  await page.click('#client-form [type=submit]');
  assert.ok(await page.$('#client-form'), 'no duplicate clients');
  await page.fill('#client-form [name=name]', 'Delta Plumbing');
  await page.fill('#client-form [name=rate]', '70');
  await page.click('#client-form [type=submit]');
  await page.waitForSelector('[data-act=hrs-client][aria-pressed=true]:has-text("Delta Plumbing")');
  await page.click('[data-act=hrs-log]');
  await page.fill('#hrs-form [name=dur]', '2:00');
  await page.click('#hrs-form [type=submit]');
  await page.waitForFunction(() => [...document.querySelectorAll('.hrs-sum tbody tr')].some(tr => tr.textContent.includes('Delta Plumbing') && tr.textContent.includes('$140.00')));
  await page.click('.hrs-entry:has-text("Delta Plumbing")');
  await page.fill('#hrs-form [name=dur]', '1');
  await page.click('#hrs-form [type=submit]');
  await page.waitForFunction(() => [...document.querySelectorAll('.hrs-sum tbody tr')].some(tr => tr.textContent.includes('Delta Plumbing') && tr.textContent.includes('$70.00')));
  await page.click('.hrs-entry:has-text("Delta Plumbing")');
  await page.click('[data-act=hrs-delete]');
  await page.waitForFunction(() => ![...document.querySelectorAll('.hrs-entry')].some(e => e.textContent.includes('Delta Plumbing')));
  // Archive it: gone from the chips, still in Manage clients.
  await page.click('[data-act=hrs-clients]');
  await page.click('[data-act=hrs-edit-client]:has-text("Delta Plumbing")');
  await page.check('#client-form [name=archived]');
  await page.click('#client-form [type=submit]');
  await page.waitForFunction(() => ![...document.querySelectorAll('[data-act=hrs-client]')].some(e => e.textContent.includes('Delta')));
  assert.deepEqual(errors, []);
});

test('what you type in the chat line survives the dashboard redrawing', async () => {
  const { page } = await open();
  await page.fill('#ask-line input', 'Add half a thought');
  await page.click('section.lane.shared .row-wrap:has-text("Order birthday gift") [data-act=take]');
  await page.waitForFunction(() => [...document.querySelectorAll('section.lane.mine .title')].some(e => e.textContent.includes('Order birthday gift')));
  assert.equal(await page.inputValue('#ask-line input'), 'Add half a thought');
});

test('an old unclaimed shared task gets a gentle nudge', async () => {
  const { page } = await open();
  const nudges = await page.$$eval('.nudge', (els, f) => els.map(e => new Function('return ' + f)()(e.closest('.task').querySelector('.title'))), titleText.toString());
  assert.deepEqual(nudges, ['Call the plumber about the kitchen sink']);
});

test('“Take it” moves a shared task to my lane', async () => {
  const { page } = await open();
  await page.click('section.lane.shared .row-wrap:has-text("Order birthday gift") [data-act=take]');
  await page.waitForFunction(() => [...document.querySelectorAll('section.lane.mine > ul .title')].some(e => e.textContent.includes('Order birthday gift')));
  assert.match(await page.textContent('section.lane.mine'), /Shared, you took it/);
  assert.ok(!(await laneTitles(page, 'shared')).includes('Order birthday gift for Grandma'));
});

test('quick add puts a task in the chosen lane', async () => {
  const { page, errors } = await open();
  await page.click('.fab');
  await page.fill('#task-form [name=title]', 'Buy light bulbs');
  await page.click('#owner-seg [data-owner=shared]');
  await page.click('#task-form [type=submit]');
  await page.waitForFunction(() => [...document.querySelectorAll('section.lane.shared > ul .title')].some(e => e.textContent === 'Buy light bulbs'));
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
  await page.waitForFunction(() => ![...document.querySelectorAll('section.lane.mine > ul .title')].some(e => e.textContent.includes('Renew car')));
  await page.click('[data-act=show-done]');
  assert.match(await page.textContent('main'), /Renew car registration/);
  await page.click('.done-list .row-wrap:has-text("Renew car registration") [data-act=undo]');
  await page.click('[data-act=home]');
  await page.waitForFunction(() => [...document.querySelectorAll('section.lane.mine > ul .title')].some(e => e.textContent.includes('Renew car')));
});

test('finishing a weekly task: next week’s copy is only on the calendar until a day before', async () => {
  const { page } = await open();
  await page.click('section.lane.mine > ul .row-wrap:has-text("Pick up challah") [data-act=done]');
  await page.waitForFunction(() => /Next one/.test(document.querySelector('#toast')?.textContent || ''));
  await page.waitForFunction(() => ![...document.querySelectorAll('section.lane.mine .title')].some(e => e.textContent.includes('Pick up challah')));
  assert.equal(await page.locator('section.lane.mine details').filter({ hasText: 'Pick up challah' }).count(), 0, 'not in any dropdown either');
  await page.click('[data-act=calendar]');
  await page.click('[data-act=cal-next]');
  assert.match(await page.textContent('.wk-day:nth-child(6)'), /Pick up challah/, 'next Friday on the calendar');
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
  await page.waitForFunction(() => ![...document.querySelectorAll('section.lane.mine > ul .title')].some(e => e.textContent.includes('Renew car')));
});

test('snoozing hides a task until its date', async () => {
  const { page } = await open();
  await page.click('section.lane.mine .row-wrap:has-text("Renew car registration") [data-act=edit]');
  await page.click('[data-act=snooze-menu]');
  await page.click('[data-snooze]:has-text("Tomorrow")');
  await page.waitForFunction(() => ![...document.querySelectorAll('section.lane.mine > ul .title')].some(e => e.textContent.includes('Renew car')));
  assert.match(await page.textContent('section.lane.mine details.drawer[data-drawer="mine-snoozed"] summary'), /Snoozed\s*1/);
});

test('settings show quiet hours and the invite code', async () => {
  const { page, errors } = await open();
  await page.click('[data-act=settings]');
  assert.equal(await page.inputValue('#q-start'), '22:00');
  assert.match(await page.textContent('.code'), /PLATE234/);
  assert.deepEqual(errors, []);
});

test('the phone layout has no sideways scrolling, and stays light when the phone is in dark mode', async () => {
  for (const dark of [false, true]) {
    const { page } = await open({ dark });
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(over <= 0, `page is ${over}px too wide`);
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(238, 242, 240)');
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

test('importing a list adds open, snoozed and done tasks, and skips ones already on the plate', async () => {
  const { page, errors } = await open();
  const json = JSON.stringify({ v: 1, tasks: [
    { title: 'Call Rieber swap dumpster', status: 'open' },
    { title: 'Follow up on the salmon', status: 'snoozed', back: '2026-11-04' },
    { title: 'Schedule RJJ', status: 'snoozed', back: '2026-11-10', notes: 'During the day' },
    { title: 'Shabbos plans', status: 'done' },
    { title: 'Pay the electric bill', status: 'open' }
  ] });
  const code = Buffer.from(json).toString('base64url');
  await page.click('[data-act=settings]');
  await page.fill('#import-code', code);
  await page.click('[data-act=import-preview]');
  assert.match(await page.textContent('.sheet h2'), /Add 4 tasks/);
  assert.match(await page.textContent('.sheet'), /1 already on the plate will be skipped/);
  await page.click('[data-act=import-go]');
  await page.waitForFunction(() => [...document.querySelectorAll('section.lane.mine > ul .title')].some(e => e.textContent === 'Call Rieber swap dumpster'));
  const mine = await laneTitles(page, 'mine');
  assert.ok(mine.includes('Follow up on the salmon'), 'a snooze date in the past comes in as open');
  assert.ok(!mine.includes('Schedule RJJ'), 'a future snooze stays hidden');
  assert.match(await page.textContent('section.lane.mine details.drawer[data-drawer="mine-snoozed"] summary'), /Snoozed\s*1/);
  await page.click('[data-act=show-done]');
  assert.match(await page.textContent('main'), /Shabbos plans/);
  assert.deepEqual(errors, []);
});

test('a broken import code gives a clear message', async () => {
  const { page } = await open();
  await page.click('[data-act=settings]');
  await page.fill('#import-code', 'not-a-real-code');
  await page.click('[data-act=import-preview]');
  assert.match(await page.textContent('#toast'), /isn’t complete/);
});

test('calendar shows the month with tasks colored by owner, and lists a tapped day', async () => {
  const { page, errors } = await open();
  await page.click('[data-act=calendar]');
  await page.click('[data-act=cal-mode][data-mode=month]');
  assert.match(await page.textContent('.cal-nav h2'), /November/);
  // Friday Nov 6: challah (mine), pediatrician (Leah's), recycling (Leah took it).
  const today = page.locator('.day.is-today');
  assert.equal(await today.locator('.mark').count(), 4, 'five tasks today: four marks and a +');
  assert.match(await page.textContent('.cal-agenda'), /Pick up challah/);
  assert.match(await page.textContent('.cal-agenda'), /Pediatrician appointment/);
  // Weekly challah repeats on Nov 13 (shown as a ring).
  await page.click('.day:not(.out) >> text="13"');
  assert.match(await page.textContent('.cal-agenda h3'), /13/);
  assert.match(await page.textContent('.cal-agenda'), /Pick up challah/);
  assert.equal(await page.locator('.day.sel .mark.rep').count() >= 1, true);
  assert.deepEqual(errors, []);
});

test('calendar moves between months, and Add uses the chosen day', async () => {
  const { page } = await open();
  await page.click('[data-act=calendar]');
  await page.click('[data-act=cal-mode][data-mode=month]');
  await page.click('[data-act=cal-next]');
  assert.match(await page.textContent('.cal-nav h2'), /December/);
  await page.click('.day:not(.out) >> text="24"');
  await page.click('[data-act=add-on-day]');
  assert.equal(await page.inputValue('#task-form [name=date]'), '2026-12-24');
  await page.fill('#task-form [name=title]', 'Light the menorah');
  await page.click('#task-form [type=submit]');
  await page.waitForFunction(() => /Light the menorah/.test(document.querySelector('.cal-agenda')?.textContent || ''));
});

test('colors can be changed in Settings and show in the lanes and calendar', async () => {
  const { page, errors } = await open();
  await page.click('[data-act=settings]');
  await page.click('.color-row[data-key=me] [data-color="#2f5fa8"]');
  await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--mine').trim() === '#2f5fa8');
  assert.equal(await page.getAttribute('.color-row[data-key=me] [data-color="#2f5fa8"]', 'aria-pressed'), 'true');
  await page.click('[data-act=colors-reset]');
  await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--mine').trim() === '#1e6f6a');
  assert.deepEqual(errors, []);
});

test('tasks are grouped by category inside each tile, and the filter shows one category', async () => {
  const { page, errors } = await open();
  const heads = await page.$$eval('section.lane.mine .cat-head', els => els.map(e => e.textContent));
  assert.deepEqual(heads, ['Overdue', 'Car', 'Work', 'Other'], 'overdue first, then categories (the only House task is overdue)');
  await page.click('.cats [data-cat="Car"]');
  assert.deepEqual((await laneTitles(page, 'mine')).sort(), ['Renew car registration', 'Rotate the tires']);
  assert.equal(await page.locator('section.lane.mine .cat-head').count(), 0);
  await page.click('.cats [data-cat=""]');
  assert.ok((await laneTitles(page, 'mine')).includes('Pick up challah'));
  assert.deepEqual(errors, []);
});

test('a priority code shows in small before the title', async () => {
  const { page } = await open();
  const p = page.locator('section.lane.mine .row-wrap:has-text("Pay the electric bill") .prio');
  assert.equal(await p.textContent(), '1');
  assert.match(await p.getAttribute('class'), /p1/);
});

test('adding a task with a category and priority files it under that category', async () => {
  const { page } = await open();
  await page.click('.fab');
  await page.fill('#task-form [name=title]', 'Book the oil change');
  await page.click('.quick-cats [data-qcat="Car"]');
  await page.click('.quick-cats [data-qprio="2"]');
  assert.equal(await page.inputValue('#task-form [name=category]'), 'Car');
  await page.click('#task-form [type=submit]');
  await page.waitForFunction(() => [...document.querySelectorAll('section.lane.mine ul[data-sortable="mine/Car"] .title')].some(e => e.textContent.includes('Book the oil change')));
  assert.equal(await page.textContent('section.lane.mine .row-wrap:has-text("Book the oil change") .prio'), '2');
});

test('dragging the handle reorders tasks, and the order sticks', async () => {
  const { page, errors } = await open();
  const car = () => page.$$eval('ul[data-sortable="mine/Car"] .title', els => els.map(e => e.lastChild.textContent.trim()));
  assert.deepEqual(await car(), ['Renew car registration', 'Rotate the tires']);
  const grip = page.locator('ul[data-sortable="mine/Car"] li:nth-child(2) .grip');
  const box = await grip.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - i * 12);
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('ul[data-sortable="mine/Car"] li .title')?.textContent.includes('Rotate the tires'));
  assert.deepEqual(await car(), ['Rotate the tires', 'Renew car registration']);
  // Keyboard: move it back down with the arrow key.
  await page.focus('ul[data-sortable="mine/Car"] li:nth-child(1) .grip');
  await page.keyboard.press('ArrowDown');
  await page.waitForFunction(() => document.querySelector('ul[data-sortable="mine/Car"] li .title')?.textContent.includes('Renew car'));
  assert.deepEqual(errors, []);
});

test('Hebrew dates and holidays appear when turned on in Settings', async () => {
  const { page, errors } = await open();
  assert.equal(await page.locator('.heb').count(), 0, 'off by default');
  await page.click('[data-act=settings]');
  await page.check('#p-hebrew');
  await page.click('.sheet [data-act=close]');
  assert.match(await page.textContent('.hello .heb'), /כ״ו חשוון תשפ״ז/);
  await page.click('[data-act=calendar]');
  await page.click('[data-act=cal-mode][data-mode=month]');
  // Dec 2026: Chanukah starts on the 5th.
  await page.click('[data-act=cal-next]');
  await page.click('.day:not(.out) >> text="5"');
  assert.match(await page.textContent('.cal-agenda'), /Chanukah, day 1/);
  assert.ok(await page.locator('.day.sel .hol-dot').count() === 1);
  assert.deepEqual(errors, []);
});

test('Settings makes a calendar link for Apple and Google Calendar, and can turn it off', async () => {
  const { page, errors } = await open();
  page.on('dialog', d => d.accept());
  await page.click('[data-act=settings]');
  await page.click('[data-act=feed-make]');
  const apple = await page.getAttribute('.feed a:has-text("Apple")', 'href');
  assert.match(apple, /^webcal:\/\/localhost:\d+\/cal\/[A-Za-z0-9_-]{32}\.ics$/);
  assert.match(await page.getAttribute('.feed a:has-text("Google")', 'href'), /^https:\/\/calendar\.google\.com\/calendar\/r\?cid=webcal%3A%2F%2F/);
  await page.click('[data-act=feed-who][data-who=all]');
  assert.match(await page.getAttribute('.feed a:has-text("Apple")', 'href'), /\?who=all$/);
  await page.click('[data-act=feed-off]');
  await page.waitForSelector('[data-act=feed-make]');
  assert.deepEqual(errors, []);
});


test('daily tasks come onto the tile 3 hours before they are due; the Daily list always has them', async () => {
  const { page, errors } = await open(); // 9:00am: vitamins due 9:30 (on the tile), dishes due 8pm (not yet)
  assert.ok((await laneTitles(page, 'mine')).includes('Take vitamins'));
  assert.equal(await page.locator('section.lane.mine > ul .row-wrap.compact:has-text("Take vitamins")').count(), 1, 'shown smaller');
  assert.ok(!(await laneTitles(page, 'shared')).includes('Do the dishes'));
  const d = page.locator('section.lane.shared details[data-drawer="shared-daily"]');
  assert.match(await d.locator('summary').textContent(), /Daily list\s*1/);
  await d.locator('summary').click();
  assert.match(await d.textContent(), /Do the dishes/);
  assert.match(await page.textContent('section.lane.mine details[data-drawer="mine-daily"] summary'), /Daily list\s*1/, 'the list includes ones already showing');
  assert.deepEqual(errors, []);
});

test('at 5pm the 8pm daily task is on the tile', async () => {
  const { page } = await open({ at: '2026-11-06T17:00:00-05:00' });
  assert.ok((await laneTitles(page, 'shared')).includes('Do the dishes'));
});

test('tasks more than two weeks out wait in their own drawer', async () => {
  const { page } = await open();
  assert.ok(!(await laneTitles(page, 'mine')).includes('Renew passports'));
  const d = page.locator('section.lane.mine details[data-drawer="mine-far"]');
  assert.match(await d.locator('summary').textContent(), /More than 2 weeks out\s*1/);
  await d.locator('summary').click();
  assert.match(await d.textContent(), /Renew passports/);
});

test('a shared repeating task someone took comes back tomorrow on the Shared plate, unclaimed', async () => {
  const { page } = await open({ at: '2026-11-06T19:30:00-05:00' });
  await page.click('section.lane.shared .row-wrap:has-text("Do the dishes") [data-act=take]');
  await page.waitForFunction(() => [...document.querySelectorAll('section.lane.mine > ul .title')].some(e => e.textContent.includes('Do the dishes')));
  await page.click('section.lane.mine .row-wrap:has-text("Do the dishes") [data-act=done]');
  await page.waitForFunction(() => /Next one/.test(document.querySelector('#toast')?.textContent || ''));
  await page.waitForFunction(() => document.querySelector('section.lane.shared [data-drawer="shared-daily"]')?.textContent.includes('Do the dishes'));
  assert.ok(!(await laneTitles(page, 'mine')).includes('Do the dishes'));
  assert.doesNotMatch(await page.textContent('section.lane.mine [data-drawer="mine-daily"]'), /Do the dishes/, 'not on my list any more');
});

test('snoozed tasks sit in a drawer at the bottom of their person’s tile', async () => {
  const { page } = await open();
  const d = page.locator('section.lane.theirs details[data-drawer="theirs-snoozed"]');
  assert.match(await d.locator('summary').textContent(), /Snoozed\s*1/);
  await d.locator('summary').click();
  assert.match(await d.textContent(), /Book the summer camp/);
  assert.equal(await page.locator('main > section details.more').count(), 0, 'no separate snoozed list any more');
});

test('the calendar shows the weekly parsha and Daf Yomi when turned on', async () => {
  const { page, errors } = await open();
  await page.click('[data-act=settings]');
  await page.check('#p-parsha'); await page.check('#p-daf');
  await page.click('.sheet [data-act=close]');
  await page.click('[data-act=calendar]');
  await page.click('[data-act=cal-mode][data-mode=month]');
  await page.click('.day:not(.out) >> text="14"');
  const learning = await page.textContent('.cal-agenda .learning');
  assert.match(learning, /Parshas Toldos/);
  assert.match(learning, /Daf Yomi: Bechoros 57/);
  assert.deepEqual(errors, []);
});

test('the back button and the browser back gesture leave the calendar and close sheets', async () => {
  const { page } = await open();
  await page.click('[data-act=calendar]');
  await page.goBack();
  await page.waitForSelector('section.lane.mine');
  await page.click('[data-act=settings]');
  await page.goBack();
  await page.waitForFunction(() => !document.querySelector('.sheet'));
  await page.click('[data-act=show-done]');
  await page.click('[data-act=home]');
  await page.waitForSelector('section.lane.mine');
});

test('swiping in from the left edge goes back', async () => {
  const { page } = await open();
  await page.click('[data-act=calendar]');
  const swipe = async () => page.evaluate(async () => {
    const fire = (type, x) => {
      const t = new Touch({ identifier: 1, target: document.body, clientX: x, clientY: 400 });
      document.body.dispatchEvent(new TouchEvent(type, { touches: type === 'touchend' ? [] : [t], changedTouches: [t], bubbles: true }));
    };
    fire('touchstart', 5); for (let x = 20; x <= 260; x += 40) fire('touchmove', x); fire('touchend', 260);
    await new Promise(r => setTimeout(r, 300));
  });
  await swipe();
  await page.waitForSelector('section.lane.mine');
  await page.click('[data-act=settings]');
  await swipe();
  await page.waitForFunction(() => !document.querySelector('.sheet'));
});

test('Settings makes a personal Claude link with setup steps, and can turn it off', async () => {
  const { page, errors } = await open();
  page.on('dialog', d => d.accept());
  await page.click('[data-act=settings]');
  await page.click('[data-act=claude-make]');
  assert.match(await page.inputValue('#claude-url'), /^http:\/\/localhost:\d+\/mcp\/[A-Za-z0-9_-]{32}$/);
  assert.match(await page.textContent('#claude'), /Add custom connector/);
  assert.match(await page.textContent('#claude'), /No sign in/);
  await page.click('[data-act=claude-off]');
  await page.waitForSelector('[data-act=claude-make]');
  assert.deepEqual(errors, []);
});


test('on a phone the calendar opens to this week, with task titles, and moves week by week', async () => {
  const { page, errors } = await open();
  await page.click('[data-act=calendar]');
  assert.equal(await page.getAttribute('[data-act=cal-mode][data-mode=week]', 'aria-pressed'), 'true');
  assert.match(await page.textContent('.cal-nav h2'), /Nov 1 – 7/);
  assert.equal(await page.locator('.wk-day').count(), 7);
  const today = page.locator('.wk-day.is-today');
  assert.match(await today.textContent(), /Pick up challah/);
  assert.match(await today.textContent(), /Pediatrician appointment for Noa/);
  await page.click('[data-act=cal-next]');
  assert.match(await page.textContent('.cal-nav h2'), /Nov 8 – 14/);
  assert.match(await page.textContent('.wk-day:nth-child(6)'), /Pick up challah/, 'next week’s copy of a weekly task');
  await page.click('.wk-day:nth-child(3) [data-act=add-on]');
  assert.equal(await page.inputValue('#task-form [name=date]'), '2026-11-10');
  assert.deepEqual(errors, []);
});

test('the week view shows Hebrew dates, holidays, parsha and daf when they are on', async () => {
  const { page } = await open();
  await page.click('[data-act=settings]');
  await page.check('#p-hebrew'); await page.check('#p-parsha'); await page.check('#p-daf');
  await page.click('.sheet [data-act=close]');
  await page.click('[data-act=calendar]');
  await page.click('[data-act=cal-next]');
  const shabbos = await page.textContent('.wk-day:nth-child(7)');
  assert.match(shabbos, /Toldos/);
  assert.match(shabbos, /Bechoros 57/);
  assert.match(await page.textContent('.wk-day:nth-child(3)'), /Rosh Chodesh Kislev/);
});

test('a wide screen opens the calendar to the month', async () => {
  const { page } = await open();
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.click('[data-act=calendar]');
  assert.equal(await page.getAttribute('[data-act=cal-mode][data-mode=month]', 'aria-pressed'), 'true');
  assert.equal(await page.locator('.day').count() >= 28, true);
});


test('a weekly task is on the tile from a day before it is due', async () => {
  const { page, errors } = await open(); // Friday 9am: challah due today 3pm
  assert.ok((await laneTitles(page, 'mine')).includes('Pick up challah'));
  assert.equal(await page.locator('[data-drawer$="-weekly"]').count(), 0, 'no Weekly list dropdown');
  assert.deepEqual(errors, []);
});

test('a weekly task due in two days is only on the calendar', async () => {
  const { page } = await open({ at: '2026-11-07T09:00:00-05:00' }); // Saturday 9am; the new task is due Monday 6pm
  await page.click('.fab');
  await page.fill('#task-form [name=title]', 'Take out the garbage');
  await page.click('#task-form details.more summary');
  await page.fill('#task-form [name=date]', '2026-11-09');
  await page.fill('#task-form [name=time]', '18:00');
  await page.selectOption('#task-form [name=repeat]', 'weekly');
  await page.click('#task-form [type=submit]');
  await page.waitForTimeout(200);
  assert.ok(!(await laneTitles(page, 'mine')).includes('Take out the garbage'));
  assert.doesNotMatch(await page.textContent('section.lane.mine'), /Take out the garbage/);
  await page.click('[data-act=calendar]');
  await page.click('[data-act=cal-next]');
  assert.match(await page.textContent('.wk-day:nth-child(2)'), /Take out the garbage/);
});


test('shopping list: add several at once, check off, uncheck, and clear', async () => {
  const { page, errors } = await open();
  assert.match(await page.getAttribute('[data-act=shopping]', 'aria-label'), /4 to get/);
  await page.click('[data-act=shopping]');
  assert.match(await page.textContent('.shop-list[data-list="Groceries"]'), /Milk/);
  await page.fill('#shop-add input', 'bananas, coffee');
  await page.press('#shop-add input', 'Enter');
  await page.waitForFunction(() => /coffee/.test(document.querySelector('.shop-list[data-list="Groceries"]').textContent));
  assert.match(await page.textContent('.shop-list[data-list="Groceries"] .count'), /^4$/);
  await page.click('.shop-list[data-list="Groceries"] .shop-item:has-text("bananas") [data-act=shop-toggle]');
  await page.waitForFunction(() => document.querySelector('.shop-list[data-list="Groceries"] .count').textContent === '3');
  const got = page.locator('.shop-list[data-list="Groceries"] details.got');
  await got.locator('summary').click();
  assert.match(await got.textContent(), /bananas/);
  await got.locator('[data-act=shop-clear]').click();
  await page.waitForFunction(() => !document.querySelector('.shop-list[data-list="Groceries"] details.got'));
  assert.deepEqual(errors, []);
});

test('shopping list: move an item from Groceries to Amazon, or to a new list', async () => {
  const { page } = await open();
  await page.click('[data-act=shopping]');
  await page.click('.shop-list[data-list="Groceries"] .shop-item:has-text("Challah flour") [data-act=shop-edit]');
  await page.click('.shop-move [data-move="Amazon"]');
  await page.click('#item-form [type=submit]');
  await page.waitForFunction(() => /Challah flour/.test(document.querySelector('.shop-list[data-list="Amazon"]').textContent));
  assert.doesNotMatch(await page.textContent('.shop-list[data-list="Groceries"]'), /Challah flour/);
  await page.click('.shop-list[data-list="Amazon"] .shop-item:has-text("Paper towels") [data-act=shop-edit]');
  await page.fill('#item-form [name=newlist]', 'Costco');
  await page.click('#item-form [type=submit]');
  await page.waitForSelector('.shop-list[data-list="Costco"]');
  assert.match(await page.textContent('.shop-list[data-list="Costco"]'), /Paper towels/);
  await page.click('.cats [data-act=shop-filter][data-list="Costco"]');
  assert.equal(await page.locator('.shop-list').count(), 1);
});

test('shopping: adding goes to the chosen list, and back leaves the screen', async () => {
  const { page } = await open();
  await page.click('[data-act=shopping]');
  await page.click('.shop-to [data-list="Amazon"]');
  await page.fill('#shop-add input', 'HDMI cable');
  await page.click('#shop-add [type=submit]');
  await page.waitForFunction(() => /HDMI cable/.test(document.querySelector('.shop-list[data-list="Amazon"]').textContent));
  await page.goBack();
  await page.waitForSelector('section.lane.mine');
});

test('comments on a shopping item: unread dot, read the thread, ask with a quick question', async () => {
  const { page, errors } = await open();
  assert.equal(await page.locator('[data-act=shopping] .new-dot').count(), 1, 'the cart shows there is a new comment');
  await page.click('[data-act=shopping]');
  const btn = page.locator('.shop-item:has-text("Phone charger") [data-act=shop-chat]');
  assert.match(await btn.getAttribute('class'), /unread/);
  await btn.click();
  await page.waitForFunction(() => /USB-C or Lightning/.test(document.querySelector('#msgs')?.textContent || ''));
  assert.match(await page.textContent('#msgs'), /Leah/);
  await page.click('.quick [data-quick="How many?"]');
  await page.waitForFunction(() => document.querySelectorAll('#msgs .msg.mine').length === 1);
  await page.fill('#say textarea', 'USB-C, two of them');
  await page.press('#say textarea', 'Enter');
  await page.waitForFunction(() => document.querySelectorAll('#msgs .msg.mine').length === 2);
  await page.click('.sheet [data-act=shop-edit]');
  await page.waitForSelector('#item-form');
  await page.goBack();
  await page.waitForFunction(() => !document.querySelector('.sheet'));
  assert.doesNotMatch(await page.locator('.shop-item:has-text("Phone charger") [data-act=shop-chat]').getAttribute('class'), /unread/, 'seen now');
  assert.match(await page.textContent('.shop-item:has-text("Phone charger") [data-act=shop-chat] .n'), /^3$/);
  assert.deepEqual(errors, []);
});

test('comments on a task live in its edit sheet and show on the row', async () => {
  const { page } = await open();
  await page.click('section.lane.mine > ul .row-wrap:has-text("Renew car registration") [data-act=edit]');
  assert.match(await page.textContent('.sheet .thread-title'), /Comments/);
  await page.fill('#say textarea', 'Do we have the insurance card?');
  await page.click('#say [type=submit]');
  await page.waitForFunction(() => document.querySelectorAll('#msgs .msg.mine').length === 1);
  await page.keyboard.press('Escape');
  assert.match(await page.textContent('section.lane.mine > ul .row-wrap:has-text("Renew car registration") .meta'), /1 comment/);
});


test('on a touch screen the handle must be held before a task moves; a quick swipe does nothing', async () => {
  const { page } = await open();
  const order = () => page.$$eval('ul[data-sortable="mine/Car"] .title', els => els.map(e => e.lastChild.textContent.trim()));
  const drag = holdMs => page.evaluate(async hold => {
    const grip = document.querySelector('ul[data-sortable="mine/Car"] li:nth-child(2) .grip');
    const r = grip.getBoundingClientRect(), x = r.left + r.width / 2;
    let y = r.top + r.height / 2;
    const fire = (type, yy) => {
      const t = new Touch({ identifier: 7, target: grip, clientX: x, clientY: yy });
      grip.dispatchEvent(new TouchEvent(type, { touches: type === 'touchend' ? [] : [t], changedTouches: [t], bubbles: true, cancelable: true }));
    };
    fire('touchstart', y);
    await new Promise(res => setTimeout(res, hold));
    for (let i = 0; i < 8; i++) { y -= 12; fire('touchmove', y); }
    fire('touchend', y);
    await new Promise(res => setTimeout(res, 150));
  }, holdMs);
  assert.deepEqual(await order(), ['Renew car registration', 'Rotate the tires']);
  await drag(50); // a quick swipe over the handle
  assert.deepEqual(await order(), ['Renew car registration', 'Rotate the tires'], 'nothing moved');
  await drag(600); // press and hold, then drag up
  await page.waitForFunction(() => document.querySelector('ul[data-sortable="mine/Car"] li .title')?.textContent.includes('Rotate the tires'));
});

test('opening a finished task offers Mark not done, which puts it back', async () => {
  const { page, errors } = await open();
  await page.click('[data-act=show-done]');
  await page.click('.done-list [data-act=edit]:has-text("Water the plants")');
  assert.equal(await page.locator('.sheet [data-act=done-from-sheet]').count(), 0, 'no Mark done on a finished task');
  assert.equal(await page.locator('.sheet [data-act=snooze-menu]').count(), 0, 'no Snooze either');
  assert.match(await page.textContent('.sheet'), /You finished this/);
  await page.click('.sheet [data-act=undone-from-sheet]');
  await page.click('[data-act=home]');
  await page.waitForFunction(() => [...document.querySelectorAll('section.lane.mine > ul .title')].some(e => e.textContent.includes('Water the plants')));
  assert.deepEqual(errors, []);
});

test('marking a repeating task not done removes the next copy it created', async () => {
  const { page } = await open();
  await page.click('section.lane.mine > ul .row-wrap:has-text("Pick up challah") [data-act=done]');
  await page.waitForFunction(() => /Next one/.test(document.querySelector('#toast')?.textContent || ''));
  await page.click('[data-act=show-done]');
  await page.click('.done-list [data-act=edit]:has-text("Pick up challah")');
  await page.click('.sheet [data-act=undone-from-sheet]');
  await page.click('[data-act=home]');
  await page.click('[data-act=calendar]');
  await page.click('[data-act=cal-next]');
  const copies = await page.locator('.wk-day:nth-child(6) .title:has-text("Pick up challah")').count();
  assert.equal(copies, 1, 'just the projected repeat of the reopened task, not a second copy');
});

test('Daf Yomi reminder settings: same time, or a time for each day', async () => {
  const { page, errors } = await open();
  await page.click('[data-act=settings]');
  await page.check('#p-hebrew');
  assert.match(await page.textContent('.shabbos-note'), /no notifications on Shabbos or Yom Tov/);
  assert.equal(await page.locator('#daf-on').count(), 0, 'only once Daf Yomi is shown');
  await page.check('#p-daf');
  await page.check('#daf-on');
  assert.equal(await page.inputValue('#daf-time'), '21:00');
  await page.fill('#daf-time', '06:30');
  await page.dispatchEvent('#daf-time', 'change');
  await page.click('[data-daf-mode=days]');
  assert.equal(await page.locator('.day-time input').count(), 6, 'no time for Shabbos when Hebrew dates are on');
  assert.match(await page.textContent('.day-times'), /No reminder on Shabbos/);
  assert.equal(await page.inputValue('.day-time input[data-day="3"]'), '06:30', 'each day starts at the same time');
  await page.fill('.day-time input[data-day="5"]', '');
  await page.dispatchEvent('.day-time input[data-day="5"]', 'change');
  assert.match(await page.textContent('#daf-rem'), /None are sent on Shabbos or Yom Tov/);
  // Back to one time, change it, then to different days again: every day starts from the new time.
  await page.click('[data-daf-mode=same]');
  await page.fill('#daf-time', '22:15');
  await page.dispatchEvent('#daf-time', 'change');
  await page.click('[data-daf-mode=days]');
  assert.equal(await page.inputValue('.day-time input[data-day="5"]'), '22:15');
  await page.fill('.day-time input[data-day="5"]', '');
  await page.dispatchEvent('.day-time input[data-day="5"]', 'change');
  const saved = await page.evaluate(() => window.SP.profile.prefs.dafReminder);
  assert.equal(saved.enabled, true);
  assert.equal(saved.same, false);
  assert.equal(saved.days[5], '');
  assert.equal(saved.days[0], '22:15');
  assert.deepEqual(errors, []);
});

test('linked family: a suggestion waits in the inbox; approving puts it on the chosen plate', async () => {
  const { page, errors } = await open();
  assert.match(await page.textContent('.inbox-banner'), /1 suggestion.*Grandma & Grandpa/);
  await page.click('.inbox-banner');
  assert.match(await page.textContent('.sugg'), /Bring the kids for lunch on Sunday/);
  assert.equal(await page.getAttribute('.sugg [data-o=shared]', 'aria-pressed'), 'true', 'Shared by default');
  await page.click('.sugg [data-o=leah]');
  await page.click('.sugg [data-sugg=approve]');
  await page.waitForFunction(() => !document.querySelector('.sheet'));
  await page.waitForFunction(() => !document.querySelector('.inbox-banner'));
  await page.click('[data-act=calendar]');
  await page.click('[data-act=cal-next]'); // Sunday is next week
  assert.match(await page.textContent('.wk-day:nth-child(1)'), /Bring the kids for lunch on Sunday[\s\S]*Leah/);
  assert.deepEqual(errors, []);
});

test('linked family: declining removes it', async () => {
  const { page } = await open();
  await page.click('.inbox-banner');
  await page.click('.sugg [data-sugg=decline]');
  await page.waitForFunction(() => !document.querySelector('.inbox-banner'));
});

test('linked family: their shared events show on the calendar, read-only, in the family color', async () => {
  const { page } = await open();
  await page.click('[data-act=calendar]');
  await page.click('[data-act=cal-next]');
  await page.waitForFunction(() => /Grandma’s doctor visit|Grandpa’s birthday dinner/.test(document.querySelector('.week')?.textContent || ''));
  const item = page.locator('.cal-task.linked').first();
  assert.match(await item.textContent(), /Grandma & Grandpa/);
  assert.equal(await item.locator('[data-act=edit]').count(), 0, 'not editable');
  assert.match(await page.textContent('.cal-legend'), /Family/);
});

test('sending a new task to a linked family instead of a plate', async () => {
  const { page } = await open();
  await page.click('.fab');
  await page.fill('#task-form [name=title]', 'Can you take the kids Thursday?');
  await page.click('.send-fam [data-owner="family:g9"]');
  assert.match(await page.textContent('#task-form [type=submit]'), /Send to Grandma & Grandpa/);
  await page.click('#task-form [type=submit]');
  await page.waitForFunction(() => /Sent to Grandma & Grandpa/.test(document.querySelector('#toast')?.textContent || ''));
  assert.ok(!(await laneTitles(page, 'mine')).includes('Can you take the kids Thursday?'), 'not added to our own plate');
});

test('Settings: link with a family by code, choosing what they see; change and unlink', async () => {
  const { page, errors } = await open();
  page.on('dialog', d => d.accept());
  await page.click('[data-act=settings]');
  assert.match(await page.textContent('#families'), /Grandma & Grandpa/);
  await page.click('[data-act=link-make]');
  await page.click('.choice[data-k=share] [data-v=events]');
  await page.click('#make-code');
  await page.waitForSelector('#code-out .code');
  assert.equal(await page.textContent('#code-out .code'), 'FAMLY234');
  await page.keyboard.press('Escape');
  await page.click('[data-act=settings]');
  await page.click('[data-act=link-enter]');
  await page.fill('#link-form [name=code]', 'ABCD2345');
  await page.click('.choice[data-k=share] [data-v=calendar]');
  await page.click('.choice[data-k=accept] [data-v=false]');
  await page.click('#link-form [type=submit]');
  await page.waitForFunction(() => /Linked with The Cohens/.test(document.querySelector('#toast')?.textContent || ''));
  await page.click('[data-act=settings]');
  assert.match(await page.textContent('#links-box'), /The Cohens[\s\S]*They see: Your whole calendar\. They can’t send you suggestions/);
  await page.click('[data-act=link-edit][data-id=g10]');
  await page.click('#link-remove');
  await page.waitForFunction(() => /Unlinked from The Cohens/.test(document.querySelector('#toast')?.textContent || ''));
  assert.deepEqual(errors, []);
});

test('a task can be marked to share with linked families once you share events', async () => {
  const { page } = await open();
  await page.click('.fab');
  assert.equal(await page.locator('#task-form [name=familyShare]').count(), 0, 'hidden while sharing nothing');
  await page.keyboard.press('Escape');
  await page.click('[data-act=settings]');
  await page.click('[data-act=link-edit][data-id=g9]');
  await page.click('.choice[data-k=share] [data-v=events]');
  await page.click('#link-save');
  await page.waitForFunction(() => !document.querySelector('.sheet'));
  await page.click('.fab');
  await page.fill('#task-form [name=title]', 'Noa’s recital');
  await page.click('#task-form details.more summary');
  await page.check('#task-form [name=familyShare]');
  await page.click('#task-form [type=submit]');
  await page.waitForFunction(() => window.SP.open.some(t => t.title === 'Noa’s recital' && t.familyShare === true));
});
