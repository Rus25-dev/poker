import { evaluate, cardFromStr as C, handName, categoryOf } from '../js/cards.js';
import { Table } from '../js/engine.js';
import { botDecide } from '../js/bot.js';
import { equity, outs } from '../js/equity.js';

let fail = 0;
const ok = (cond, msg) => { if (!cond) { fail++; console.log('FAIL:', msg); } };
const H = s => s.split(' ').map(C);

// --- оценка рук ---
const cases = [
  ['As Ks Qs Js Ts 2d 3c', 8], ['5h 4h 3h 2h Ah Kd Kc', 8], ['9c 9d 9h 9s 2c 3d 4h', 7],
  ['Kc Kd Kh 2s 2c 3d 4h', 6], ['Kc Kd Kh 2s 2c 2d 4h', 6], ['Ac 9c 7c 4c 2c Kd Kh', 5],
  ['5d 4c 3h 2s Ad Kc Kh', 4], ['Td 9c 8h 7s 6d 2c 3h', 4], ['7d 7c 7h As Kd 2c 3h', 3],
  ['7d 7c 5h 5s Kd 2c 3h', 2], ['7d 7c 5h 5s 3d 3c Ah', 2], ['7d 7c 5h 9s Kd 2c 3h', 1], ['Ad Jc 9h 7s 5d 3c 2h', 0]
];
for (const [h, cat] of cases) ok(categoryOf(evaluate(H(h))) === cat, `${h} -> ${cat}, got ${categoryOf(evaluate(H(h)))} ${handName(evaluate(H(h)))}`);
ok(evaluate(H('As Ad Kc Qd 2s 3c 4h')) > evaluate(H('As Ad Kc Jd 2s 3c 8h')), 'kicker');
ok(evaluate(H('6d 5c 4h 3s 2d')) > evaluate(H('5d 4c 3h 2s Ad')), 'wheel lower than 6-high straight');
ok(evaluate(H('7d 7c 5h 5s 3d 3c Ah')) > evaluate(H('7d 7c 5h 5s 3d 3c Kh')), 'two pair kicker from third pair');
ok(evaluate(H('Ks Kd Qc Qd 4c 4d 2h')) === evaluate(H('Ks Kd Qc Qd 4c 4d 3h')), 'two pair, kicker is 4');

// --- эквити ---
const e = equity(H('As Ah'), [], 1, 20000);
ok(Math.abs(e.equity - 0.85) < 0.02, 'AA vs random ~85%: ' + e.equity.toFixed(3));
const o = outs(H('Ah Kh'), H('2h 7h Qc'));
ok(o.count >= 9, 'flush draw outs >= 9: ' + o.count);

// --- сайд-поты ---
{
  const t = new Table({ startChips: 1000, sb: 10, bb: 20 });
  t.addPlayer({ id: 'a', name: 'A' }); t.addPlayer({ id: 'b', name: 'B' }); t.addPlayer({ id: 'c', name: 'C' });
  t.seats[0].chips = 100; t.seats[1].chips = 500; t.seats[2].chips = 1000;
  t.startHand();
  // подменяем карты: A лучшая, B вторая, C худшая
  t.seats[0].hole = H('As Ad'); t.seats[1].hole = H('Ks Kd'); t.seats[2].hole = H('2c 7h');
  t.deck = H('3h 4s 9c 8d Jh 3d Tc 5c').reverse();
  const order = () => t.seats[t.toAct].id;
  let guard = 0;
  while (t.phase !== 'over' && guard++ < 50) {
    if (t.pending) { t.advance(); continue; }
    const id = order();
    t.act(id, id === 'c' ? 'call' : 'allin');
  }
  const total = t.players().reduce((a, p) => a + p.chips, 0);
  ok(total === 1600, 'chips conserved side pot: ' + total);
  ok(t.seats[0].chips === 300, 'A wins main pot 300: ' + t.seats[0].chips);
  ok(t.seats[1].chips === 800, 'B wins side pot 800: ' + t.seats[1].chips);
}

// --- симуляция ботами ---
for (const mode of ['cash', 'tournament']) {
  const n = 6;
  const t = new Table({ mode, startChips: 1500, sb: 10, bb: 20, levelMinutes: 1 });
  const styles = ['tight', 'normal', 'lag'];
  for (let i = 0; i < n; i++) t.addPlayer({ id: 'p' + i, name: 'P' + i, bot: styles[i % 3] });
  let hands = 0, now = 0, steps = 0;
  while (hands < (mode === 'cash' ? 1500 : 3000) && !t.tourOver) {
    now += 1000;
    if (!t.startHand(now)) {
      if (mode === 'cash') { for (const p of t.players()) if (p.chips <= 0) t.rebuy(p.id); continue; }
      break;
    }
    hands++;
    while (t.phase !== 'over') {
      if (++steps > 1e6) { ok(false, 'infinite loop'); break; }
      if (t.pending) { t.advance(); continue; }
      const p = t.seats[t.toAct];
      if (!p) { ok(false, `no toAct, phase ${t.phase} street ${t.street}`); break; }
      const d = botDecide(t.viewFor(p.id), p.id, p.bot, Math.random) || { type: 'fold' };
      let r = t.act(p.id, d.type, d.amount);
      if (!r.ok) { ok(false, 'bot illegal: ' + d.type + ' ' + d.amount + ' ' + r.err); r = t.act(p.id, 'fold'); if (!r.ok) t.act(p.id, 'check'); }
    }
    const sum = t.players().reduce((a, p) => a + p.chips, 0);
    const exp = t.players().reduce((a, p) => a + p.buyins * 1500, 0);
    if (sum !== exp) { ok(false, `${mode} chips not conserved hand ${hands}: ${sum} vs ${exp}`); break; }
    t.drainEvents();
  }
  console.log(mode, 'hands:', hands, mode === 'tournament' ? 'over=' + t.tourOver + ' places=' + t.places.map(p => p.name + ':' + p.place).join(',') + ' level=' + t.levelIdx : '');
}
console.log(fail ? `${fail} FAILED` : 'ALL OK');
process.exit(fail ? 1 : 0);
