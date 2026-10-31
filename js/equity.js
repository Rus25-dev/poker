// Подсказки: эквити (против случайных карт и против вероятных диапазонов), ауты, шансы банка, тренер
import { evaluate, evalHand, categoryOf, rankOf, suitOf } from './cards.js';

const HC = { holdem: 2, omaha: 4, pineapple: 2 };

// ---------- префлоп: шкала Чена ----------
export function chenScore(hole) {
  const [a, b] = hole;
  let r1 = rankOf(a), r2 = rankOf(b);
  if (r2 > r1) [r1, r2] = [r2, r1];
  const base = [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 6, 7, 8, 10];
  let s = base[r1];
  if (r1 === r2) s = Math.max(5, s * 2);
  if (suitOf(a) === suitOf(b)) s += 2;
  const gap = r1 - r2 - 1;
  if (r1 !== r2) {
    if (gap === 1) s -= 1; else if (gap === 2) s -= 2; else if (gap === 3) s -= 4; else if (gap >= 4) s -= 5;
    if (gap <= 1 && r1 < 10) s += 1;
  }
  return Math.max(0, Math.ceil(s));
}

// Омаха: грубая оценка стартовой руки (пары, одномастность, связность, высокие карты)
export function omahaScore(hole) {
  const rs = hole.map(rankOf).sort((a, b) => b - a);
  const ss = hole.map(suitOf);
  let s = rs.reduce((a, r) => a + (r >= 8 ? r - 6 : 0), 0);
  const cnt = {}; rs.forEach(r => cnt[r] = (cnt[r] || 0) + 1);
  for (const r in cnt) if (cnt[r] === 2) s += 4 + r / 2; else if (cnt[r] >= 3) s -= 4;
  const sc = {}; ss.forEach(x => sc[x] = (sc[x] || 0) + 1);
  const suited = Object.values(sc).filter(c => c === 2).length;
  s += suited * 3;
  if (Object.values(sc).some(c => c >= 3)) s -= 2;
  const uniq = [...new Set(rs)];
  for (let i = 0; i + 1 < uniq.length; i++) if (uniq[i] - uniq[i + 1] <= 2) s += 1.5;
  return Math.round(s);
}

export function preflopTier(hole, variant = 'holdem') {
  if (variant === 'omaha') {
    const c = omahaScore(hole);
    if (c >= 22) return { tier: 'premium', color: 'gold', score: c };
    if (c >= 16) return { tier: 'strong', color: 'green', score: c };
    if (c >= 11) return { tier: 'playable', color: 'teal', score: c };
    if (c >= 7) return { tier: 'speculative', color: 'yellow', score: c };
    return { tier: 'weak', color: 'grey', score: c };
  }
  let h = hole;
  if (hole.length === 3) { // ананас: оцениваем лучшую пару из трёх
    let best = -1;
    for (let i = 0; i < 3; i++) { const k = hole.filter((_, j) => j !== i); const sc = chenScore(k); if (sc > best) { best = sc; h = k; } }
  }
  const c = chenScore(h);
  if (c >= 12) return { tier: 'premium', color: 'gold', score: c };
  if (c >= 9) return { tier: 'strong', color: 'green', score: c };
  if (c >= 7) return { tier: 'playable', color: 'teal', score: c };
  if (c >= 5) return { tier: 'speculative', color: 'yellow', score: c };
  return { tier: 'weak', color: 'grey', score: c };
}

// процентиль стартовых рук холдема по Чену (порог для «топ X%»)
let CHEN_SORTED = null;
function chenThreshold(pct) {
  if (!CHEN_SORTED) {
    CHEN_SORTED = [];
    for (let a = 0; a < 52; a++) for (let b = a + 1; b < 52; b++) CHEN_SORTED.push(chenScore([a, b]));
    CHEN_SORTED.sort((x, y) => y - x);
  }
  if (pct >= 1) return -1;
  return CHEN_SORTED[Math.min(CHEN_SORTED.length - 1, Math.floor(CHEN_SORTED.length * pct))];
}

// ---------- сила руки на конкретной улице ----------
function hasDraw(cards) {
  const sc = [0, 0, 0, 0]; let mask = 0;
  for (const c of cards) { sc[c & 3]++; mask |= 1 << (c >> 2); }
  if (sc.some(x => x === 4)) return true;
  const bits = (mask << 1) | ((mask >> 12) & 1);
  for (let lo = 0; lo <= 9; lo++) {
    let n = 0; for (let i = 0; i < 5; i++) if (bits & (1 << (lo + i))) n++;
    if (n >= 4) return true;
  }
  return false;
}
function streetStrength(hole, board, variant) {
  const my = categoryOf(evalHand(hole, board, variant));
  const bc = board.length >= 5 ? categoryOf(evaluate(board)) : categoryOf(evaluate(board));
  if (my > bc && my >= 1) return my >= 2 ? 'strong' : 'made';
  if (board.length < 5 && hasDraw(variant === 'omaha' ? [...hole.slice(0, 2), ...board] : [...hole, ...board])) return 'draw';
  return 'air';
}
const ACCEPT = {
  agg:   { strong: 1, made: 0.8, draw: 0.5, air: 0.18 },
  call:  { strong: 0.8, made: 1, draw: 0.75, air: 0.25 },
  check: { strong: 0.45, made: 0.85, draw: 0.9, air: 1 }
};

// профиль соперника по истории действий в раздаче
export function profileFromHist(hist, bb) {
  const prof = { pre: 'any', streets: {} };
  for (const h of hist || []) {
    if (h.s === 'preflop') {
      if (h.t === 'raise' || h.t === 'bet') prof.pre = 'raise';
      else if (h.t === 'call' && prof.pre !== 'raise') prof.pre = h.a > bb ? 'callRaise' : (prof.pre === 'callRaise' ? 'callRaise' : 'limp');
    } else {
      const cur = prof.streets[h.s];
      const k = h.t === 'bet' || h.t === 'raise' ? 'agg' : h.t === 'call' ? 'call' : h.t === 'check' ? 'check' : null;
      if (k && (cur !== 'agg')) prof.streets[h.s] = k === 'check' && cur ? cur : k;
    }
  }
  return prof;
}
const PRE_PCT = { raise: 0.18, callRaise: 0.35, limp: 0.6, any: 1 };
const STREET_LEN = { flop: 3, turn: 4, river: 5 };

// ---------- эквити Монте-Карло ----------
// opts: { variant, profiles: [профиль|null на каждого соперника], bb, iterations }
export function equity(hole, board, opponents, iterations = 2000, rnd = Math.random, opts = {}) {
  const variant = opts.variant || 'holdem';
  const hc = HC[variant] || 2;
  opponents = Math.max(1, Math.min(8, opponents));
  const profiles = opts.profiles || [];
  const used = new Set([...hole, ...board]);
  const rest = [];
  for (let c = 0; c < 52; c++) if (!used.has(c)) rest.push(c);
  const need = 5 - board.length;
  let win = 0, tie = 0, eq = 0;
  const cat = new Array(9).fill(0);
  const deck = rest.slice();
  const thresholds = profiles.map(p => p && variant !== 'omaha' ? chenThreshold(PRE_PCT[p.pre] ?? 1) : -1);
  for (let it = 0; it < iterations; it++) {
    // доска
    for (let i = 0; i < deck.length; i++) { const j = i + Math.floor(rnd() * (deck.length - i)); const t = deck[i]; deck[i] = deck[j]; deck[j] = t; if (i > need + hc * opponents + 40) break; }
    const full = board.concat(deck.slice(0, need));
    const taken = new Set(full.slice(board.length));
    const opp = [];
    let pos = need;
    for (let o = 0; o < opponents; o++) {
      const prof = profiles[o];
      let hand = null;
      for (let tries = 0; tries < (prof ? (variant === 'omaha' ? 8 : 25) : 1); tries++) {
        // берём следующие свободные карты из перемешанной колоды; при отказе — случайные
        const h = [];
        if (tries === 0) { while (h.length < hc && pos < deck.length) { const c = deck[pos++]; if (!taken.has(c)) h.push(c); } }
        else { while (h.length < hc) { const c = deck[Math.floor(rnd() * deck.length)]; if (!taken.has(c) && !h.includes(c)) h.push(c); } }
        hand = h;
        if (!prof) break;
        if (variant !== 'omaha' && thresholds[o] >= 0 && chenScore(h) < thresholds[o]) continue;
        let p = 1;
        for (const st in prof.streets) {
          const L = STREET_LEN[st];
          if (!L || L > full.length || L > board.length) continue;
          p *= ACCEPT[prof.streets[st]][streetStrength(h, board.slice(0, L), variant)];
        }
        if (rnd() < p) break;
      }
      hand.forEach(c => taken.add(c));
      opp.push(hand);
    }
    const my = evalHand(hole, full, variant);
    cat[categoryOf(my)]++;
    let best = 0, cnt = 0;
    for (const h of opp) {
      const s = evalHand(h, full, variant);
      if (s > best) { best = s; cnt = 1; } else if (s === best) cnt++;
    }
    if (my > best) { win++; eq += 1; }
    else if (my === best) { tie++; eq += 1 / (cnt + 1); }
  }
  return { win: win / iterations, tie: tie / iterations, equity: eq / iterations, categories: cat.map(x => x / iterations) };
}

// Ауты: карты, которые на следующей улице поднимают категорию руки
export function outs(hole, board, variant = 'holdem') {
  if (board.length < 3 || board.length >= 5) return { count: 0, cards: [] };
  const nowCat = categoryOf(evalHand(hole, board, variant));
  const used = new Set([...hole, ...board]);
  const res = [];
  for (let c = 0; c < 52; c++) {
    if (used.has(c)) continue;
    const nb = [...board, c];
    const cat = categoryOf(evalHand(hole, nb, variant));
    const bc = categoryOf(evaluate(nb));
    if (cat > nowCat && cat > bc) res.push(c);
  }
  return { count: res.length, cards: res };
}

export function potOdds(toCall, pot) {
  if (toCall <= 0) return 0;
  return toCall / (pot + toCall);
}

// Эквити при открытых картах (олл-ин)
export function equityKnown(hands, board, rnd = Math.random, variant = 'holdem') {
  const used = new Set([...board, ...hands.flat()]);
  const rest = [];
  for (let c = 0; c < 52; c++) if (!used.has(c)) rest.push(c);
  const need = 5 - board.length;
  const eq = new Array(hands.length).fill(0);
  let n = 0;
  const score = full => {
    let best = -1, w = [];
    hands.forEach((h, i) => {
      const s = evalHand(h, full, variant);
      if (s > best) { best = s; w = [i]; } else if (s === best) w.push(i);
    });
    for (const i of w) eq[i] += 1 / w.length;
    n++;
  };
  if (need === 0) score(board);
  else if (need === 1) for (const a of rest) score([...board, a]);
  else if (need === 2 && variant !== 'omaha') {
    for (let i = 0; i < rest.length; i++) for (let j = i + 1; j < rest.length; j++) score([...board, rest[i], rest[j]]);
  } else {
    const d = rest.slice();
    const its = variant === 'omaha' ? 1500 : 3000;
    for (let it = 0; it < its; it++) {
      for (let i = 0; i < need; i++) { const j = i + Math.floor(rnd() * (d.length - i)); [d[i], d[j]] = [d[j], d[i]]; }
      score([...board, ...d.slice(0, need)]);
    }
  }
  return eq.map(x => x / n);
}

// ---------- совет (короткий) и тренер (подробный) ----------
export function advice(eq, toCall, pot, players) {
  const need = potOdds(toCall, pot);
  const fair = 1 / Math.max(2, players);
  if (toCall === 0) {
    if (eq > fair * 1.7) return { key: 'adv_bet', kind: 'good' };
    if (eq > fair * 1.1) return { key: 'adv_betcheck', kind: 'ok' };
    return { key: 'adv_check', kind: 'meh' };
  }
  if (eq > need * 1.6 && eq > fair * 1.5) return { key: 'adv_raise', kind: 'good' };
  if (eq >= need) return { key: 'adv_call', kind: 'ok' };
  return { key: 'adv_fold', kind: 'bad' };
}

// Тренер: рекомендуемое действие, размер и причина (ключи для перевода)
export function coach({ eq, toCall, pot, players, outs: o = 0, street, canRaise, stackBB }) {
  const need = potOdds(toCall, pot);
  const fair = 1 / Math.max(2, players);
  const drawing = street !== 'river' && street !== 'preflop' && o >= 8;
  if (stackBB != null && stackBB < 12 && street === 'preflop') {
    if (eq > fair * 1.2) return { act: 'allin', why: 'short_push' };
    return { act: toCall ? 'fold' : 'check', why: 'short_fold' };
  }
  if (toCall === 0) {
    if (eq > Math.max(0.62, fair * 1.8) && canRaise) return { act: 'raise', size: 0.66, why: 'value' };
    if (drawing && canRaise && players <= 3) return { act: 'raise', size: 0.5, why: 'semibluff' };
    if (eq > fair * 1.25 && canRaise) return { act: 'raise', size: 0.4, why: 'thin_value' };
    return { act: 'check', why: 'free' };
  }
  if (eq > Math.max(0.68, fair * 2) && canRaise) return { act: 'raise', size: 0.8, why: 'value' };
  if (eq >= need) return { act: 'call', why: drawing ? 'draw_odds' : 'odds' };
  if (drawing && eq >= need * 0.75 && street === 'flop') return { act: 'call', why: 'implied' };
  return { act: 'fold', why: 'no_odds' };
}
