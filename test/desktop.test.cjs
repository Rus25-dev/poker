// Скриншоты компьютерной версии на типичных мониторах: лобби, стол в разных фазах, окна
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const OUT = process.argv[2] || '.';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SIZES = (process.env.SIZES || '1920x1080,1366x768,1440x900').split(',').map(s => s.split('x').map(Number));
(async () => {
  const srv = spawn('python3', ['-m', 'http.server', '8770'], { cwd: __dirname + '/..', stdio: 'ignore' });
  await sleep(700);
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const errors = [];
  for (const [w, h] of SIZES) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, locale: 'ru-RU' });
    await ctx.addInitScript({ path: __dirname + '/fakepeer.js' });
    await ctx.addInitScript(() => localStorage.setItem('rp_prefs', JSON.stringify({ lang: 'ru', sound: false, coach: true, avatar: '🐯' })));
    await ctx.route(/jsdelivr/, r => r.abort());
    const p = await ctx.newPage();
    p.on('pageerror', e => errors.push(`${w}x${h}: ${e.message}`));
    p.on('dialog', d => d.accept());
    await p.goto('http://localhost:8770/');
    await sleep(300);
    await p.screenshot({ path: `${OUT}/d-${w}-lobby.png` });
    await p.fill('#inName', 'Рус');
    await p.click('#btnTrain');
    await sleep(200);
    await p.screenshot({ path: `${OUT}/d-${w}-create.png` });
    await p.selectOption('#fBots', process.env.BOTS || '5');
    await p.click('#fGo');
    let flop = false, raise = false, over = false;
    for (let i = 0; i < 400 && !(flop && raise && over); i++) {
      await sleep(200);
      const v = await p.evaluate(() => { const v = window.__poker.view; return v && { b: v.board.length, ph: v.phase, my: !!document.querySelector('#aCall') }; });
      if (!v) continue;
      if (v.my && v.b >= 3 && !flop) { await sleep(900); await p.screenshot({ path: `${OUT}/d-${w}-flop.png` }); flop = true; }
      if (v.my && flop && !raise && await p.$('#aRaise')) { await p.click('#aRaise'); await sleep(200); await p.screenshot({ path: `${OUT}/d-${w}-raise.png` }); await p.click('#rBack'); raise = true; }
      if (v.ph === 'over' && flop && !over) { await sleep(500); await p.screenshot({ path: `${OUT}/d-${w}-over.png` }); over = true; }
      if (v.my) await p.click('#aCall').catch(() => {});
    }
    if (process.env.MODALS) {
      await p.click('.dock-tabs button[data-tab=chat]'); await p.fill('#chatIn', 'Привет всем!'); await p.press('#chatIn', 'Enter'); await sleep(300);
      await p.screenshot({ path: `${OUT}/d-${w}-chat.png` });
      await p.click('.dock-tabs button[data-tab=log]'); await sleep(200); await p.screenshot({ path: `${OUT}/d-${w}-log.png` });
      await p.click('.dock-tabs button[data-tab=hints]');
      // горячие клавиши: ждём свой ход, R открывает ставку, Esc закрывает
      for (let i = 0; i < 80; i++) { await sleep(200); if (await p.$('#aCall')) break; }
      await p.locator('body').press('KeyR'); await sleep(200);
      console.log('hotkey R opens raise:', !!(await p.$('.raise-box')));
      await p.keyboard.press('ArrowUp'); await p.keyboard.press('ArrowUp'); await sleep(150);
      console.log('raise amount after ↑↑:', await p.textContent('.raise-box .amt'));
      await p.keyboard.press('Escape'); await sleep(150);
      console.log('Esc closes raise:', !(await p.$('.raise-box')));
      await p.click('#btnMenu'); await p.click('#mStats'); await sleep(300); await p.screenshot({ path: `${OUT}/d-${w}-stats.png` });
    }
    await ctx.close();
  }
  console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
  await browser.close(); srv.kill();
})().catch(e => { console.error(e); process.exit(1); });
