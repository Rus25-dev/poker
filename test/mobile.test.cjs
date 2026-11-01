// Скриншоты мобильной версии во всех основных состояниях на нескольких телефонах
const { chromium, devices } = require('playwright');
const { spawn } = require('child_process');
const OUT = process.argv[2] || '.';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const DEVICES = (process.env.DEVS || 'iPhone SE,iPhone 13,Pixel 7').split(',');
(async () => {
  const srv = spawn('python3', ['-m', 'http.server', '8771'], { cwd: __dirname + '/..', stdio: 'ignore' });
  await sleep(700);
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const errors = [];
  for (const dev of DEVICES) {
    const tag = dev.replace(/\s+/g, '');
    const ctx = await browser.newContext({ ...devices[dev], locale: 'ru-RU' });
    await ctx.addInitScript({ path: __dirname + '/fakepeer.js' });
    await ctx.addInitScript(p => { if (!localStorage.getItem('rp_prefs')) localStorage.setItem('rp_prefs', JSON.stringify(p)); }, { lang: 'ru', sound: false, avatar: '🐯', ...(process.env.PREFS ? JSON.parse(process.env.PREFS) : {}) });
    await ctx.route(/jsdelivr/, r => r.abort());
    const p = await ctx.newPage();
    p.on('pageerror', e => errors.push(`${dev}: ${e.message}`));
    p.on('dialog', d => d.accept());
    await p.goto('http://localhost:8771/');
    await sleep(300);
    await p.screenshot({ path: `${OUT}/m-${tag}-1-lobby.png` });
    await p.fill('#inName', 'Рус');
    await p.click('#btnCreate'); await sleep(200);
    await p.screenshot({ path: `${OUT}/m-${tag}-2-create.png` });
    await p.click('#fGo'); await sleep(400);
    await p.click('#aAddBot'); await p.click('#aAddBot'); await p.click('#aAddBot'); await sleep(200);
    await p.screenshot({ path: `${OUT}/m-${tag}-3-waiting.png` });
    await p.click('#aStart');
    const shot = { pre: 0, flop: 0, raise: 0, over: 0 };
    for (let i = 0; i < 400 && !(shot.pre && shot.flop && shot.raise && shot.over); i++) {
      await sleep(200);
      const v = await p.evaluate(() => { const v = window.__poker.view; return v && { b: v.board.length, ph: v.phase, my: !!document.querySelector('#aCall') }; });
      if (!v) continue;
      if (v.my && v.b === 0 && !shot.pre) { await sleep(900); await p.screenshot({ path: `${OUT}/m-${tag}-4-preflop.png` }); shot.pre = 1; }
      if (v.my && v.b >= 3 && !shot.flop) { await sleep(900); await p.screenshot({ path: `${OUT}/m-${tag}-5-flop.png` }); shot.flop = 1; }
      if (v.my && shot.flop && !shot.raise && await p.$('#aRaise')) { await p.click('#aRaise'); await sleep(250); await p.screenshot({ path: `${OUT}/m-${tag}-6-raise.png` }); await p.click('#rBack', { timeout: 3000 }).catch(() => { console.log(dev + ': кнопка «Назад» недоступна'); return p.evaluate(() => document.querySelector('#rBack').click()); }); shot.raise = 1; }
      if (v.ph === 'over' && shot.flop && !shot.over) { await sleep(600); await p.screenshot({ path: `${OUT}/m-${tag}-7-over.png` }); shot.over = 1; }
      if (v.my) await p.click('#aCall').catch(() => {});
    }
    await p.click('#btnChat'); await sleep(250);
    await p.screenshot({ path: `${OUT}/m-${tag}-8-chat.png` });
    await p.click('#drawerClose');
    await p.click('#btnMenu'); await sleep(250);
    await p.screenshot({ path: `${OUT}/m-${tag}-9-menu.png` });
    await ctx.close();
  }
  console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
  await browser.close(); srv.kill();
})().catch(e => { console.error(e); process.exit(1); });
