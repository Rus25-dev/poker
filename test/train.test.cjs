const { chromium, devices } = require('playwright');
const OUT = process.argv[2];
(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ ...devices['Pixel 7'] });
  await ctx.addInitScript({ path: __dirname + '/fakepeer.js' });
  await ctx.route(/jsdelivr/, r => r.abort());
  const p = await ctx.newPage(); const errs = [];
  p.on('pageerror', e => errs.push(e.message)); p.on('dialog', d => d.accept());
  await p.goto('http://localhost:8765/');
  await p.fill('#inName', 'Рус'); await p.click('#btnTrain');
  await p.click('#segMode button[data-v=tournament]');
  await p.selectOption('#fBots', '5');
  await p.click('#fGo');
  let allinShot = false, sdShot = false, flopShot = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 90000 && !(allinShot && sdShot)) {
    const v = await p.evaluate(() => { const v = window.__poker.view; return v && { phase: v.phase, board: v.board.length, my: v.legal && v.toAct >= 0, sd: v.lastResult && v.lastResult.showdown }; });
    if (v && v.phase === 'runout' && !allinShot) { await p.waitForTimeout(400); await p.screenshot({ path: OUT + '/11-allin.png' }); allinShot = true; }
    if (v && v.phase === 'over' && v.sd && !sdShot) { await p.screenshot({ path: OUT + '/12-showdown.png' }); sdShot = true; }
    if (await p.$('#aCall')) {
      if (v.board >= 3 && !flopShot) { const t = await p.$('#tglProbs'); if (t) { await t.click(); await p.waitForTimeout(150); await p.screenshot({ path: OUT + '/10-flop-hints.png' }); flopShot = true; } }
      // иногда идём олл-ин, чтобы увидеть проценты на столе
      if (Math.random() < 0.25 && await p.$('#aRaise')) { await p.click('#aRaise'); await p.click('.presets .btn:last-child'); await p.click('#rGo'); }
      else await p.click('#aCall');
    }
    await p.waitForTimeout(200);
  }
  console.log('shots', { allinShot, sdShot, flopShot }, 'errors', errs);
  await browser.close();
})();
