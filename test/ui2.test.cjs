// Сквозной тест: 3 телефона, честная тасовка, смена хоста, ананас, омаха, горизонтальная раскладка
const { chromium, devices } = require('playwright');
const { spawn } = require('child_process');
const OUT = process.argv[2] || '.';
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const srv = spawn('python3', ['-m', 'http.server', '8766'], { cwd: __dirname + '/..', stdio: 'ignore' });
  await sleep(800);
  const URL = 'http://localhost:8766/';
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const errors = [];
  const ctx = await browser.newContext({ ...devices['iPhone 13'], locale: 'ru-RU' });
  await ctx.addInitScript({ path: __dirname + '/fakepeer.js' });
  await ctx.addInitScript(() => { if (!localStorage.getItem('rp_prefs')) localStorage.setItem('rp_prefs', JSON.stringify({ lang: 'ru', sound: false })); });
  await ctx.route(/jsdelivr/, r => r.abort());
  const mk = async (name, c = ctx) => {
    const p = await c.newPage();
    p.on('pageerror', e => errors.push(name + ': ' + e.message));
    p.on('console', m => { if (m.type() === 'error' && !/ERR_FAILED/.test(m.text())) errors.push(name + ' console: ' + m.text()); });
    p.on('dialog', d => d.accept());
    await p.goto(URL);
    // у каждого «телефона» свой токен (в одном контексте браузера localStorage общий)
    await p.evaluate(n => { window.__poker.token = 'tok-' + n + '-' + Math.random(); }, name);
    return p;
  };
  const log = p => p.evaluate(() => window.__poker.log.join('\n'));
  const play = async (pages, untilHands, maxMs = 60000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      for (const pg of pages) {
        if (pg.isClosed()) continue;
        const b = await pg.$('#aCall');
        if (b) await b.click().catch(() => {});
        const d = await pg.$('.seat.me.discarding .cards .card');
        if (d) await d.click().catch(() => {});
      }
      await sleep(250);
      const n = await pages[pages.length - 1].evaluate(() => window.__poker.view?.handNo || 0);
      if (n >= untilHands) return n;
    }
    return -1;
  };

  // --- 1. три телефона ---
  const host = await mk('host');
  await host.fill('#inName', 'Рус'); await host.click('#btnCreate'); await host.click('#fGo'); await sleep(400);
  const code = (await host.textContent('#roomCode')).trim();
  const c1 = await mk('c1'); await c1.fill('#inName', 'Дана'); await c1.fill('#inCode', code); await c1.click('#btnJoin');
  const c2 = await mk('c2'); await c2.fill('#inName', 'Ерлан'); await c2.fill('#inCode', code); await c2.click('#btnJoin');
  await sleep(1200);
  await host.click('#aStart');
  const n1 = await play([host, c1, c2], 4);
  console.log('hands played before migration:', n1);
  await sleep(600);
  await c1.screenshot({ path: OUT + '/20-c1-ru.png' });
  const l1 = await log(c1);
  console.log('fair verified on c1:', (l1.match(/проверена/g) || []).length, 'bad:', (l1.match(/не прошла/g) || []).length);

  // --- 2. хост пропадает ---
  await host.close();
  const t0 = Date.now();
  let migrated = false;
  while (Date.now() - t0 < 45000) {
    await sleep(1000);
    const st1 = await c1.evaluate(() => ({ host: window.__poker.ctl?.isHost?.(), n: window.__poker.view?.handNo }));
    const st2 = await c2.evaluate(() => ({ host: window.__poker.ctl?.isHost?.(), n: window.__poker.view?.handNo, dot: document.querySelector('#netDot').className }));
    if ((st1.host || st2.host) && st2.dot.includes('ok')) { migrated = true; console.log('migrated after', Date.now() - t0, 'ms', st1, st2); break; }
  }
  console.log('migrated:', migrated);
  const before = await c2.evaluate(() => window.__poker.view?.handNo);
  const n2 = await play([c1, c2], before + 2, 40000);
  console.log('hands after migration:', before, '->', n2);
  const seats = await c2.evaluate(() => window.__poker.view.seats.filter(Boolean).map(s => s.name + ':' + s.chips + (s.connected ? '' : '(off)')).join(' '));
  console.log('seats after migration:', seats);
  console.log('c1 state:', await c1.evaluate(() => JSON.stringify({ phase: window.__poker.view?.phase, hand: window.__poker.view?.handNo, toAct: window.__poker.view?.toAct, started: window.__poker.ctl?.started, pend: window.__poker.view?.legal })));
  for (const pg of [c1, c2]) console.log('ctl internals:', await pg.evaluate(() => { const c = window.__poker.ctl; return c && c.table ? JSON.stringify({ dealing: c._dealing, paused: c.paused, started: c.started, phase: c.table.phase, hand: c.table.handNo, pending: c.table.pending, tour: c.table.tourOver, timers: Object.keys(c.timers), commit: !!c.commitNext }) : 'client'; }));
  console.log('host table:', await c1.evaluate(() => { const c = window.__poker.ctl; return c && c.table ? JSON.stringify(c.table.players().map(p => [p.name, p.chips, p.sitOut, p.out, p.connected, p.inHand])) + ' chat: ' + window.__poker.chat.slice(-5).map(m => m.key || m.text).join('|') : ''; }));
  console.log('c2 client:', await c2.evaluate(() => { const c = window.__poker.ctl; return c && !c.table ? JSON.stringify({ state: c.state, attempt: c.attempt, link: !!c.link, age: Date.now() - c.lastMsgAt, gen: c.gen, myId: c.myId, view: window.__poker.view?.handNo }) : 'host'; }));
  if (0) console.log('manual next:', await c1.evaluate(async () => { const c = window.__poker.ctl; try { const nf = c._nextFor; await c._nextHand(); return 'nextFor=' + nf + ' hand=' + c.table.handNo + ' phase=' + c.table.phase; } catch (e) { return 'ERR ' + e.message + ' ' + e.stack; } }));
  if (process.env.ONLY_MIG) { console.log('ERRORS:', errors.join('\n') || 'none'); await browser.close(); srv.kill(); return; }
  console.log('c1 log tail:\n' + (await log(c1)).split('\n').slice(-12).join('\n'));
  await c2.screenshot({ path: OUT + '/21-after-migration.png' });

  // --- 3. ананас (тренировка) ---
  const pine = await mk('pine');
  await pine.fill('#inName', 'Рус'); await pine.click('#btnTrain'); await pine.click('#segVar button[data-v=pineapple]'); await pine.click('#fGo');
  let shotD = false;
  for (let i = 0; i < 200 && !shotD; i++) {
    await sleep(250);
    if (await pine.$('.seat.me.discarding')) { await sleep(900); await pine.screenshot({ path: OUT + '/22-pineapple-discard.png' }); await pine.click('.seat.me .cards .card'); shotD = true; }
    else { const b = await pine.$('#aCall'); if (b) await b.click().catch(() => {}); }
  }
  console.log('pineapple discard seen:', shotD);
  await pine.close();

  // --- 4. омаха, тренер, четырёхцветная колода, синее сукно ---
  const om = await mk('omaha');
  await om.evaluate(() => localStorage.setItem('rp_prefs', JSON.stringify({ lang: 'kk', sound: false, coach: true, four: true, felt: 'blue', avatar: '🐯' })));
  await om.reload();
  await om.fill('#inName', 'Рус'); await om.click('#btnTrain'); await om.click('#segVar button[data-v=omaha]'); await om.click('#fGo');
  let shotO = false;
  for (let i = 0; i < 200 && !shotO; i++) {
    await sleep(250);
    const v = await om.evaluate(() => { const v = window.__poker.view; return v && { b: v.board.length, my: !!document.querySelector('#aCall'), coach: !document.querySelector('#coachBox').classList.contains('hidden') }; });
    if (v && v.my && v.b >= 3) { await sleep(1500); await om.screenshot({ path: OUT + '/23-omaha-coach-kk.png' }); console.log('omaha hints:', (await om.textContent('#hints')).slice(0, 200), '| coach:', await om.textContent('#coachBox')); shotO = true; }
    else if (v && v.my) await om.click('#aCall').catch(() => {});
  }
  console.log('omaha coach shot:', shotO);
  // история и разбор
  await om.click('#btnMenu'); await om.click('#mHist'); await sleep(300);
  const items = await om.$$('.hist-item');
  if (items.length) { await items[0].click(); await sleep(1500); await om.screenshot({ path: OUT + '/24-review.png' }); }
  console.log('history items:', items.length);
  await om.close();

  // --- 5. горизонтальная раскладка (планшет) ---
  const tctx = await browser.newContext({ viewport: { width: 1180, height: 820 }, locale: 'ru-RU' });
  await tctx.addInitScript({ path: __dirname + '/fakepeer.js' });
  await tctx.addInitScript(() => localStorage.setItem('rp_prefs', JSON.stringify({ lang: 'ru', sound: false, felt: 'red' })));
  await tctx.route(/jsdelivr/, r => r.abort());
  const tab = await mk('tablet', tctx);
  await tab.fill('#inName', 'Рус'); await tab.click('#btnTrain'); await tab.selectOption('#fBots', '5'); await tab.click('#fGo');
  for (let i = 0; i < 60; i++) { await sleep(250); if (await tab.$('#aCall')) { await sleep(500); break; } }
  await tab.screenshot({ path: OUT + '/25-tablet.png' });

  console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
  await browser.close();
  srv.kill();
})().catch(e => { console.error(e); process.exit(1); });
