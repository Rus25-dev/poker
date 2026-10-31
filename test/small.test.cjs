// Проверка компоновки на маленьком экране (iPhone SE) в самом «тяжёлом» режиме: омаха + тренер + казахский
const { chromium, devices } = require('playwright');
const { spawn } = require('child_process');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const srv = spawn('python3', ['-m', 'http.server', '8768'], { cwd: __dirname + '/..', stdio: 'ignore' });
  await sleep(700);
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ ...devices['iPhone SE'] });
  await ctx.addInitScript({ path: __dirname + '/fakepeer.js' });
  await ctx.addInitScript(() => localStorage.setItem('rp_prefs', JSON.stringify({ lang: 'kk', sound: false, coach: true, four: true, avatar: '🐯' })));
  await ctx.route(/jsdelivr/, r => r.abort());
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://localhost:8768/');
  await p.fill('#inName', 'Рус'); await p.click('#btnTrain'); await p.click('#segVar button[data-v=omaha]'); await p.click('#fGo');
  for (let i = 0; i < 240; i++) {
    await sleep(250);
    const v = await p.evaluate(() => ({ b: window.__poker.view?.board.length, my: !!document.querySelector('#aCall'), coach: !document.querySelector('#coachBox').classList.contains('hidden') }));
    if (v.my && v.b >= 3 && v.coach) { await sleep(500); break; }
    if (v.my) await p.click('#aCall').catch(() => {});
  }
  const r = await p.evaluate(() => { const a = document.querySelector('#actions').getBoundingClientRect(), b = document.querySelector('.bottombar').getBoundingClientRect(); return { actionsBottom: a.bottom, barTop: b.top }; });
  console.log('layout', r, r.actionsBottom <= r.barTop + 1 ? 'OK' : 'OVERLAP', 'errors', errs);
  await p.screenshot({ path: process.argv[2] + '/26-se-omaha.png' });
  await browser.close(); srv.kill();
})();
