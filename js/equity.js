// Подсказки: эквити Монте-Карло, вероятности комбинаций, ауты, шансы банка, префлоп-таблица
import { evaluate, categoryOf, rankOf, suitOf } from './cards.js';

// hole: 2 карты, board: 0..5 карт, opponents: число соперников в раздаче
export function equity(hole, board, opponents, iterations = 2000, rnd = Math.random) {
  opponents = Math.max(1, Math.min(8, opponents));
  const used = new Set([...hole, ...board]);
  const rest = [];
  for (let c = 0; c < 52; c++) if (!used.has(c)) rest.push(c);
  const need = 5 - board.length;
  let win = 0, tie = 0, eq = 0;
  const cat = new Array(9).fill(0);
  const deck = rest.slice();
  const b = new Array(5);
  for (let it = 0; it < iterations; it++) {
    // частичное перемешивание: нужно need + 2*opponents карт
    const take = need + 2 * opponents;
    for (let i = 0; i < take; i++) {
      const j = i + Math.floor(rnd() * (deck.length - i));
      const t = deck[i]; deck[i] = deck[j]; deck[j] = t;
    }
    for (let i = 0; i < board.length; i++) b[i] = board[i];
    for (let i = 0; i < need; i++) b[board.length + i] = deck[i];
    const my = evaluate([hole[0], hole[1], ...b]);
    cat[categoryOf(my)]++;
    let best = 0, cnt = 0;
    for (let o = 0; o < opponents; o++) {
      const p = need + o * 2;
      const s = evaluate([deck[p], deck[p + 1], ...b]);
      if (s > best) { best = s; cnt = 1; } else if (s === best) cnt++;
    }
    if (my > best) { win++; eq += 1; }
    else if (my === best) { tie++; eq += 1 / (cnt + 1); }
  }
  return {
    win: win / iterations,
    tie: tie / iterations,
    equity: eq / iterations,
    categories: cat.map(x => x / iterations) // вероятность итоговой комбинации к риверу
  };
}

// Ауты: карты, которые на следующей улице поднимают категорию руки
export function outs(hole, board) {
  if (board.length < 3 || board.length >= 5) return { count: 0, cards: [] };
  const all = [...hole, ...board];
  const nowCat = categoryOf(evaluate(all));
  const used = new Set(all);
  const res = [];
  for (let c = 0; c < 52; c++) {
    if (used.has(c)) continue;
    const cat = categoryOf(evaluate([...all, c]));
    // засчитываем, только если улучшение даёт наша рука, а не один лишь стол
    const bc = categoryOf(evaluate([...board, c]));
    if (cat > nowCat && cat > bc) res.push(c);
  }
  return { count: res.length, cards: res };
}

// Шансы банка: какую долю банка нужно выигрывать, чтобы колл был в плюс
export function potOdds(toCall, pot) {
  if (toCall <= 0) return 0;
  return toCall / (pot + toCall);
}

// Префлоп: сила стартовой руки по классической шкале Чена (нормирована 0..1)
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

export function preflopTier(hole) {
  const c = chenScore(hole);
  if (c >= 12) return { tier: 'Премиум', color: 'gold', score: c };
  if (c >= 9) return { tier: 'Сильная', color: 'green', score: c };
  if (c >= 7) return { tier: 'Играбельная', color: 'teal', score: c };
  if (c >= 5) return { tier: 'Спекулятивная', color: 'yellow', score: c };
  return { tier: 'Слабая', color: 'grey', score: c };
}

// Короткий совет на основе эквити и шансов банка
export function advice(eq, toCall, pot, players) {
  const need = potOdds(toCall, pot);
  const fair = 1 / Math.max(2, players);
  if (toCall === 0) {
    if (eq > fair * 1.7) return { text: 'Сильная рука — стоит ставить', kind: 'good' };
    if (eq > fair * 1.1) return { text: 'Неплохо — можно поставить или чекнуть', kind: 'ok' };
    return { text: 'Слабо — бесплатный чек', kind: 'meh' };
  }
  if (eq > need * 1.6 && eq > fair * 1.5) return { text: 'Выгодно — колл или рейз', kind: 'good' };
  if (eq >= need) return { text: 'Колл окупается по шансам банка', kind: 'ok' };
  return { text: 'Колл не окупается — фолд', kind: 'bad' };
}

// Эквити при открытых картах (олл-ин): точный перебор на флопе/тёрне, Монте-Карло на префлопе
export function equityKnown(hands, board, rnd = Math.random) {
  const used = new Set([...board, ...hands.flat()]);
  const rest = [];
  for (let c = 0; c < 52; c++) if (!used.has(c)) rest.push(c);
  const need = 5 - board.length;
  const eq = new Array(hands.length).fill(0);
  let n = 0;
  const score = full => {
    let best = -1, w = [];
    hands.forEach((h, i) => {
      const s = evaluate([...h, ...full]);
      if (s > best) { best = s; w = [i]; } else if (s === best) w.push(i);
    });
    for (const i of w) eq[i] += 1 / w.length;
    n++;
  };
  if (need === 0) score(board);
  else if (need === 1) for (const a of rest) score([...board, a]);
  else if (need === 2) {
    for (let i = 0; i < rest.length; i++) for (let j = i + 1; j < rest.length; j++) score([...board, rest[i], rest[j]]);
  } else {
    const d = rest.slice();
    for (let it = 0; it < 3000; it++) {
      for (let i = 0; i < need; i++) { const j = i + Math.floor(rnd() * (d.length - i)); [d[i], d[j]] = [d[j], d[i]]; }
      score([...board, ...d.slice(0, need)]);
    }
  }
  return eq.map(x => x / n);
}
