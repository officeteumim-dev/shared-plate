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

test('today strip lists overdue and today’s tasks, not later ones', async () => {
  const { page } = await open();
  const chips = await page.$$eval('.today .chip .t', (els, f) => els.map(new Function('return ' + f)()), titleText.toString());
  assert.ok(chips.includes('Pay the electric bill'));
  assert.ok(chips.includes('Pick up challah'));
  assert.ok(!chips.includes('Renew car registration'));
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

test('finishing a repeating task schedules the next one', async () => {
  const { page } = await open();
  await page.click('section.lane.mine .row-wrap:has-text("Pick up challah") [data-act=done]');
  await page.waitForFunction(() => /Next one/.test(document.querySelector('#toast')?.textContent || ''));
  // The list redraws just after the toast. Wait until exactly one challah row is left: next week's copy.
  const challah = () => page.$$eval('section.lane.mine .row-wrap', els =>
    els.filter(e => e.querySelector('.title')?.textContent === 'Pick up challah').map(e => e.querySelector('.meta')?.textContent || ''));
  await page.waitForFunction(() => [...document.querySelectorAll('section.lane.mine .row-wrap .meta')]
    .filter(m => m.closest('.row-wrap').querySelector('.title').textContent === 'Pick up challah')
    .every(m => !/Today|Overdue/.test(m.textContent)));
  const metas = await challah();
  assert.equal(metas.length, 1, 'the next week’s copy is on the plate');
  assert.doesNotMatch(metas[0], /Today|Overdue/);
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
  assert.deepEqual(heads, ['Car', 'House', 'Work', 'Other']);
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
