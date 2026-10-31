import { evaluate, evaluateOmaha, cardFromStr as C, handName, categoryOf, fairDeck, sha256Hex } from '../js/cards.js';
import { Table } from '../js/engine.js';
import { botDecide } from '../js/bot.js';
import { equity, outs, profileFromHist } from '../js/equity.js';

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
for (const [h, cat] of cases) ok(categoryOf(evaluate(H(h))) === cat, `${h} -> ${cat}, got ${handName(evaluate(H(h)))}`);
ok(evaluate(H('As Ad Kc Qd 2s 3c 4h')) > evaluate(H('As Ad Kc Jd 2s 3c 8h')), 'kicker');
ok(evaluate(H('6d 5c 4h 3s 2d')) > evaluate(H('5d 4c 3h 2s Ad')), 'wheel');

// --- омаха: ровно две с руки ---
ok(categoryOf(evaluateOmaha(H('As Kd 7c 2h'), H('Qs Js Ts 3s 9d'))) === 4, 'omaha: one spade in hand is not a flush, straight AKQJT');
ok(categoryOf(evaluateOmaha(H('As Ks 7c 2h'), H('Qs Js 4s 3d 9d'))) === 5, 'omaha flush with two spades');
ok(categoryOf(evaluateOmaha(H('Ah Ad Ac 2h'), H('Ks Qd 4s 3d 9d'))) === 1, 'omaha: three aces in hand = only a pair');

// --- эквити ---
const e = equity(H('As Ah'), [], 1, 20000);
ok(Math.abs(e.equity - 0.85) < 0.02, 'AA vs random ~85%: ' + e.equity.toFixed(3));
const o = outs(H('Ah Kh'), H('2h 7h Qc'));
ok(o.count >= 9, 'flush draw outs >= 9: ' + o.count);
// диапазон рейзера сильнее случайных карт: эквити KTo против рейза ниже
const prof = profileFromHist([{ s: 'preflop', t: 'raise', a: 60 }], 20);
const eqRange = equity(H('Kd Tc'), [], 1, 6000, Math.random, { profiles: [prof] }).equity;
const eqRand = equity(H('Kd Tc'), [], 1, 6000).equity;
ok(eqRange < eqRand - 0.05, `range lowers equity: ${eqRange.toFixed(3)} < ${eqRand.toFixed(3)}`);

// --- честная тасовка ---
const d1 = await fairDeck('abc'), d2 = await fairDeck('abc'), d3 = await fairDeck('abd');
ok(d1.join() === d2.join() && d1.join() !== d3.join() && new Set(d1).size === 52, 'fair deck deterministic');
ok((await sha256Hex('x')).length === 64, 'sha256');

// --- сайд-поты ---
{
  const t = new Table({ startChips: 1000, sb: 10, bb: 20 });
  t.addPlayer({ id: 'a', name: 'A' }); t.addPlayer({ id: 'b', name: 'B' }); t.addPlayer({ id: 'c', name: 'C' });
  t.seats[0].chips = 100; t.seats[1].chips = 500; t.seats[2].chips = 1000;
  t.startHand();
  t.seats[0].hole = H('As Ad'); t.seats[1].hole = H('Ks Kd'); t.seats[2].hole = H('2c 7h');
  t.deck = H('3h 4s 9c 8d Jh 3d Tc 5c').reverse();
  let guard = 0;
  while (t.phase !== 'over' && guard++ < 50) {
    if (t.pending) { t.advance(); continue; }
    const id = t.seats[t.toAct].id;
    t.act(id, id === 'c' ? 'call' : 'allin');
  }
  ok(t.players().reduce((a, p) => a + p.chips, 0) === 1600, 'chips conserved side pot');
  ok(t.seats[0].chips === 300 && t.seats[1].chips === 800, 'side pot split');
}

// --- пот-лимит ---
{
  const t = new Table({ variant: 'omaha', startChips: 5000, sb: 10, bb: 20 });
  ['a', 'b', 'c'].forEach(x => t.addPlayer({ id: x, name: x }));
  t.startHand();
  const L = t.legal(t.seats[t.toAct].id);
  // банк 30, колл 20 => банк после колла 50, макс рейз до 20+50 = 70
  ok(L.maxTo === 70, 'PL max raise to 70, got ' + L.maxTo);
  ok(t.seats[0].hole.length === 4, 'omaha 4 cards');
}

// --- снимок для смены хоста ---
{
  const t = new Table({ startChips: 1000 });
  ['a', 'b', 'c'].forEach(x => t.addPlayer({ id: x, name: x }));
  t.startHand();
  const before = t.players().map(p => p.startStack);
  t.act(t.seats[t.toAct].id, 'raise', 100);
  const t2 = Table.fromSnapshot(JSON.parse(JSON.stringify(t.publicSnapshot())));
  ok(t2.players().map(p => p.chips).join() === before.join(), 'snapshot voids hand');
  t2.players().forEach(p => p.connected = true);
  ok(t2.startHand(), 'snapshot table can deal');
}

// --- симуляция ботами во всех режимах ---
const scenarios = [
  { mode: 'cash', variant: 'holdem', hands: 800 },
  { mode: 'cash', variant: 'omaha', hands: 300 },
  { mode: 'cash', variant: 'pineapple', hands: 500 },
  { mode: 'tournament', variant: 'holdem', hands: 3000 },
  { mode: 'tournament', variant: 'pineapple', hands: 3000 }
];
for (const sc of scenarios) {
  const t = new Table({ mode: sc.mode, variant: sc.variant, startChips: 1500, sb: 10, bb: 20, levelMinutes: 1, rebuyLevels: 1, ante: true });
  const styles = ['tight', 'normal', 'lag'];
  for (let i = 0; i < 6; i++) t.addPlayer({ id: 'p' + i, name: 'P' + i, bot: styles[i % 3] });
  let hands = 0, now = 0, steps = 0, rebuys = 0, antes = 0;
  while (hands < sc.hands && !t.tourOver) {
    now += 1000;
    if (!t.startHand(now)) {
      let any = false;
      for (const p of t.players()) if (p.chips <= 0 && t.rebuy(p.id)) { any = true; rebuys++; }
      if (!any && sc.mode === 'tournament') { now += 60000; if (++steps > 1e6) break; continue; }
      continue;
    }
    if (t.ante) antes++;
    hands++;
    // в турнире ребаи первым уровнем
    while (t.phase !== 'over') {
      if (++steps > 2e6) { ok(false, 'infinite loop'); break; }
      if (t.pending) { t.advance(); continue; }
      if (t.phase === 'discard') {
        for (const p of t.players()) if (p.needDiscard) ok(t.discard(p.id, t.autoDiscardCard(p.id)).ok, 'discard');
        continue;
      }
      const p = t.seats[t.toAct];
      if (!p) { ok(false, `no toAct, phase ${t.phase} street ${t.street}`); break; }
      const d = botDecide(t.viewFor(p.id), p.id, p.bot, Math.random) || { type: 'fold' };
      let r = t.act(p.id, d.type, d.amount);
      if (!r.ok) { if (r.err !== 'min_raise') ok(false, 'bot illegal: ' + d.type + ' ' + d.amount + ' ' + r.err); r = t.act(p.id, 'call'); if (!r.ok) t.act(p.id, 'fold'); }
    }
    if (sc.variant === 'pineapple' && t.lastResult.showdown) for (const id in t.lastResult.shown) ok(t.lastResult.shown[id].hole.length === 2, 'pineapple shows 2 cards');
    if (Math.random() < 0.05 && sc.mode === 'tournament') for (const p of t.players()) if (p.chips <= 0) { if (t.rebuy(p.id)) rebuys++; }
    const sum = t.players().reduce((a, p) => a + p.chips, 0);
    const exp = t.players().reduce((a, p) => a + p.buyins * 1500, 0);
    if (sum !== exp) { ok(false, `${sc.mode}/${sc.variant} chips not conserved hand ${hands}: ${sum} vs ${exp}`); break; }
    t.drainEvents();
  }
  if (sc.mode === 'tournament') {
    ok(t.tourOver, `${sc.variant} tournament finished`);
    const pl = t.places.map(p => p.place).sort((a, b) => a - b);
    ok(pl.join() === [1, 2, 3, 4, 5, 6].join(), 'places 1..6: ' + pl.join());
  }
  console.log(sc.mode, sc.variant, 'hands:', hands, 'rebuys:', rebuys, 'ante hands:', antes, t.tourOver ? 'prizes=' + JSON.stringify(t.prizes) : '');
}
console.log(fail ? `${fail} FAILED` : 'ALL OK');
process.exit(fail ? 1 : 0);
