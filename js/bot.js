// Боты: решение по эквити (Монте-Карло), шансам банка и характеру
import { equity, chenScore as chen2, omahaScore } from './equity.js';

// оценка стартовой руки с учётом разновидности (ананас — лучшая пара из трёх, омаха — своя шкала)
let VARIANT = 'holdem';
function chenScore(hole) {
  if (VARIANT === 'omaha') return omahaScore(hole) / 2;
  if (hole.length === 3) return Math.max(...[0, 1, 2].map(i => chen2(hole.filter((_, j) => j !== i))));
  return chen2(hole);
}

export const BOT_STYLES = {
  tight:  { name: 'Осторожный',     aggr: 0.25, loose: -0.06, bluff: 0.03 },
  normal: { name: 'Сбалансированный', aggr: 0.45, loose: 0.0,  bluff: 0.07 },
  lag:    { name: 'Агрессивный',    aggr: 0.75, loose: 0.07, bluff: 0.15 }
};

export const BOT_NAMES = ['Бот Алмаз', 'Бот Бекжан', 'Бот Вера', 'Бот Гоша', 'Бот Дана', 'Бот Ерлан', 'Бот Жанна', 'Бот Зейн'];

export function botDecide(view, meId, styleKey = 'normal', rnd = Math.random) {
  const st = BOT_STYLES[styleKey] || BOT_STYLES.normal;
  const me = view.seats.find(s => s && s.id === meId);
  const L = view.legal;
  if (!me || !L) return null;
  const opp = view.seats.filter(s => s && s.inHand && !s.folded && s.id !== meId).length;
  const bb = view.blinds[1];
  const pot = view.pot;
  const toCall = L.toCall;

  VARIANT = view.settings.variant || 'holdem';
  if (view.board.length === 0) return preflop(view, me, L, st, styleKey, opp, rnd);
  const v = VARIANT === 'pineapple' ? 'holdem' : VARIANT;
  let eq = equity(me.hole, view.board, opp, v === 'omaha' ? 300 : 600, rnd, { variant: v }).equity;
  eq += st.loose + (rnd() - 0.5) * 0.06;

  const fair = 1 / (opp + 1);
  const need = toCall > 0 ? toCall / (pot + toCall) : 0;
  const stackBB = me.chips / bb;

  const raiseTo = mult => {
    const target = Math.round(L.currentBet + Math.max(L.minTo - L.currentBet, (pot + toCall) * mult));
    return Math.max(L.minTo, Math.min(L.maxTo, target));
  };

  const strong = eq > fair * 1.9 || eq > 0.72;
  const good = eq > fair * 1.35;

  // короткий стек — пуш или фолд
  if (stackBB < 10 && L.canRaise) {
    if (eq > fair * 1.15) return { type: 'allin' };
    if (toCall === 0) return { type: 'check' };
    return eq > need * 1.1 ? { type: 'call' } : { type: 'fold' };
  }

  if (toCall === 0) {
    if (L.canRaise && (strong && rnd() < 0.55 + st.aggr * 0.4 || good && rnd() < st.aggr * 0.6 || rnd() < st.bluff)) {
      return { type: 'raise', amount: raiseTo(strong ? 0.75 : 0.5) };
    }
    return { type: 'check' };
  }
  if (strong && L.canRaise && rnd() < 0.35 + st.aggr * 0.5) {
    if (eq > 0.85 && rnd() < 0.3) return { type: 'allin' };
    return { type: 'raise', amount: raiseTo(0.8) };
  }
  if (eq >= need * 1.05 || (toCall <= bb && eq > fair * 0.8)) return { type: 'call' };
  if (L.canRaise && rnd() < st.bluff * 0.5 && view.board.length >= 3) return { type: 'raise', amount: raiseTo(0.6) };
  return { type: 'fold' };
}

// Префлоп по шкале Чена с поправкой на характер
function preflop(view, me, L, st, styleKey, opp, rnd) {
  const bb = view.blinds[1];
  const shift = styleKey === 'tight' ? 1 : styleKey === 'lag' ? -1.5 : 0;
  const chen = chenScore(me.hole) - shift + (rnd() - 0.5);
  const toCall = L.toCall;
  const stackBB = me.chips / bb;
  const facing = L.currentBet / bb;          // сколько ББ сейчас ставка
  const raise = x => ({ type: 'raise', amount: Math.max(L.minTo, Math.min(L.maxTo, Math.round(x))) });

  if (stackBB < 12) {                         // пуш/фолд
    if (chen >= 8 || (chen >= 6 && facing <= 1)) return L.canRaise ? { type: 'allin' } : { type: 'call' };
    return toCall === 0 ? { type: 'check' } : { type: 'fold' };
  }
  if (chen >= 11) {
    if (facing >= stackBB * 0.3) return L.canRaise ? { type: 'allin' } : { type: 'call' };
    if (L.canRaise) return raise(facing <= 1 ? bb * 3 : L.currentBet * 3);
    return { type: 'call' };
  }
  if (chen >= 8) {
    if (facing <= 1 && L.canRaise && rnd() < 0.5 + st.aggr * 0.5) return raise(bb * (2.5 + rnd()));
    if (facing <= 4 || toCall <= me.chips * 0.08) return toCall === 0 ? { type: 'check' } : { type: 'call' };
    if (facing <= 10 && rnd() < 0.4) return { type: 'call' };
    return toCall === 0 ? { type: 'check' } : { type: 'fold' };
  }
  if (chen >= 5.5) {
    if (facing <= 1 && L.canRaise && rnd() < st.aggr * 0.35) return raise(bb * 2.5);
    if (toCall === 0) return { type: 'check' };
    if (facing <= 2.5 && opp <= 4) return { type: 'call' };
    if (facing <= 3.5 && rnd() < st.loose + 0.15) return { type: 'call' };
    return { type: 'fold' };
  }
  if (toCall === 0) return { type: 'check' };
  if (facing <= 1 && rnd() < st.bluff) return L.canRaise ? raise(bb * 2.5) : { type: 'call' };
  if (toCall <= bb / 2 && rnd() < 0.5) return { type: 'call' };   // доплата с малого блайнда
  return { type: 'fold' };
}
