const { chromium, devices } = require('playwright');
const fs = require('fs');
const OUT = process.argv[2] || '.';
(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ ...devices['iPhone 13'], hasTouch: true });
  await ctx.addInitScript({ path: __dirname + '/fakepeer.js' });
  await ctx.route(/jsdelivr/, r => r.abort());
  const errors = [];
  const mk = async (name) => { const p = await ctx.newPage(); p.on('pageerror', e => errors.push(name + ': ' + e.message)); p.on('console', m => { if (m.type() === 'error') errors.push(name + ' console: ' + m.text()); }); p.on('dialog', d => d.accept()); await p.goto('http://localhost:8765/'); return p; };
  const host = await mk('host');
  await host.screenshot({ path: OUT + '/01-lobby.png' });
  await host.fill('#inName', 'Рус');
  await host.click('#btnCreate');
  await host.screenshot({ path: OUT + '/02-create.png' });
  await host.click('#fGo');
  await host.waitForTimeout(400);
  const code = (await host.textContent('#roomCode')).trim();
  console.log('code', code);
  const cli = await mk('client');
  await cli.fill('#inName', 'Друг');
  await cli.fill('#inCode', code);
  await cli.click('#btnJoin');
  await cli.waitForTimeout(800);
  await host.click('#aAddBot');
  await host.waitForTimeout(200);
  await host.screenshot({ path: OUT + '/03-waiting.png' });
  await host.click('#aStart');
  await host.waitForTimeout(600);
  let shots = 0, actions = 0, raised = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    for (const [pg, nm] of [[host, 'host'], [cli, 'cli']]) {
      const call = await pg.$('#aCall');
      if (call) {
        if (!raised && nm === 'cli') {
          await pg.click('#aRaise'); await pg.waitForTimeout(200);
          await pg.screenshot({ path: OUT + '/05-raise.png' });
          await pg.click('.presets .btn:nth-child(3)'); await pg.click('#rGo'); raised = true;
        } else await call.click();
        actions++;
        if (shots < 1 && nm === 'host') { await pg.waitForTimeout(300); await pg.screenshot({ path: OUT + '/04-table-host.png' }); shots++; }
      }
    }
    await host.waitForTimeout(250);
    const log = await host.evaluate(() => window.__poker.log.join('\n'));
    if ((log.match(/Раздача №/g) || []).length >= 4) break;
  }
  await host.waitForTimeout(300);
  await host.screenshot({ path: OUT + '/06-host.png' });
  await cli.screenshot({ path: OUT + '/07-client.png' });
  // чат и эмодзи
  await cli.click('#btnChat'); await cli.fill('#chatIn', 'Привет!'); await cli.click('#chatForm button'); await cli.click('#drawerClose');
  await cli.click('#quickEmoji button');
  await host.waitForTimeout(300);
  await host.screenshot({ path: OUT + '/08-host-chat.png' });
  const hlog = await host.evaluate(() => window.__poker.log.join('\n'));
  const hostChips = await host.evaluate(() => window.__poker.view.seats.filter(Boolean).map(s => s.name + ':' + s.chips + (s.inHand ? '' : '') ).join(' '));
  const cliView = await cli.evaluate(() => window.__poker.view.seats.filter(Boolean).map(s => s.name + ':' + s.chips + ' hole=' + JSON.stringify(s.hole)).join(' | '));
  console.log('actions', actions, '\nLOG:\n' + hlog.split('\n').slice(-25).join('\n'));
  console.log('host sees', hostChips); console.log('client sees', cliView);
  // реконнект клиента: перезагрузка страницы
  await cli.reload(); await cli.fill('#inName', 'Друг'); await cli.fill('#inCode', code); await cli.click('#btnJoin'); await cli.waitForTimeout(1500);
  const after = await host.evaluate(() => window.__poker.view.seats.filter(Boolean).map(s => s.name).join(','));
  console.log('after reconnect seats:', after);
  // статистика
  await host.click('#btnMenu'); await host.click('#mStats'); await host.waitForTimeout(200);
  await host.screenshot({ path: OUT + '/09-stats.png' });
  console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
