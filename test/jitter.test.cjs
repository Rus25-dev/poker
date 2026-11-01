// Замер «подёргиваний»: как часто между обновлениями меняется высота стола и пересоздаются места игроков
const { chromium, devices } = require('playwright');
const { spawn } = require('child_process');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const srv = spawn('python3', ['-m', 'http.server', '8772'], { cwd: __dirname + '/..', stdio: 'ignore' });
  await sleep(700);
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const res = {};
  for (const dev of (process.env.DEVS || 'iPhone 13,iPhone SE').split(',')) {
    const ctx = await browser.newContext({ ...devices[dev] });
    await ctx.addInitScript({ path: __dirname + '/fakepeer.js' });
    await ctx.addInitScript(() => localStorage.setItem('rp_prefs', JSON.stringify({ lang: 'ru', sound: false, coach: true })));
    await ctx.route(/jsdelivr/, r => r.abort());
    const p = await ctx.newPage();
    await p.goto('http://localhost:8772/');
    await p.fill('#inName', 'Рус'); await p.click('#btnTrain'); await p.selectOption('#fBots', '4'); await p.click('#fGo');
    await sleep(1500);
    // следим: высота стола, класс compact, сколько раз пересоздавалось моё место и места соперников
    await p.evaluate(() => {
      window.__j = { h: new Set(), compactFlips: 0, seatNodesReplaced: 0, heroCardsReplaced: 0, samples: 0 };
      let lastC = document.querySelector('#tableWrap').classList.contains('compact');
      new ResizeObserver(() => window.__j.h.add(Math.round(document.querySelector('#tableWrap').getBoundingClientRect().height))).observe(document.querySelector('#tableWrap'));
      new MutationObserver(ms => {
        for (const m of ms) for (const n of m.removedNodes) if (n.classList && n.classList.contains('seat')) window.__j.seatNodesReplaced++;
        const c = document.querySelector('#tableWrap').classList.contains('compact');
        if (c !== lastC) { window.__j.compactFlips++; lastC = c; }
      }).observe(document.querySelector('#seats'), { childList: true });
      new MutationObserver(() => window.__j.heroCardsReplaced++).observe(document.querySelector('#seats'), { childList: true, subtree: true });
    });
    const t0 = Date.now();
    while (Date.now() - t0 < 25000) {
      await sleep(200);
      const b = await p.$('#aCall'); if (b) await b.click().catch(() => {});
    }
    res[dev] = await p.evaluate(() => ({ tableHeights: [...window.__j.h], compactFlips: window.__j.compactFlips, seatNodesReplaced: window.__j.seatNodesReplaced, seatsMutations: window.__j.heroCardsReplaced, hands: window.__poker.view.handNo }));
    await ctx.close();
  }
  console.log(JSON.stringify(res, null, 1));
  await browser.close(); srv.kill();
})();
