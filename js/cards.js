// Карты: число 0..51, ранг = c >> 2 (0 = двойка … 12 = туз), масть = c & 3
export const RANKS = '23456789TJQKA';
export const SUITS = ['s', 'h', 'd', 'c'];
export const SUIT_SYM = ['♠', '♥', '♦', '♣'];
export const RANK_RU = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'В', 'Д', 'К', 'Т'];

export const rankOf = c => c >> 2;
export const suitOf = c => c & 3;
export const cardStr = c => RANKS[c >> 2] + SUITS[c & 3];
export const cardFromStr = s => (RANKS.indexOf(s[0]) << 2) | SUITS.indexOf(s[1]);
export const cardLabel = c => (RANK_RU[c >> 2]) + SUIT_SYM[c & 3];

export function newDeck() { return Array.from({ length: 52 }, (_, i) => i); }

// Криптостойкое перемешивание (Фишер–Йетс), если доступно crypto
export function shuffle(arr, rnd = secureRandom) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
export function secureRandom() {
  const c = globalThis.crypto;
  if (c && c.getRandomValues) {
    const b = new Uint32Array(1); c.getRandomValues(b); return b[0] / 4294967296;
  }
  return Math.random();
}

export const CATEGORY_RU = [
  'Старшая карта', 'Пара', 'Две пары', 'Сет', 'Стрит',
  'Флеш', 'Фулл-хаус', 'Каре', 'Стрит-флеш', 'Роял-флеш'
];

// Старшая карта стрита в битовой маске рангов (с учётом A-2-3-4-5), -1 если нет
function straightHigh(mask) {
  const bits = (mask << 1) | ((mask >> 12) & 1); // бит 0 = туз как единица
  for (let top = 13; top >= 4; top--) {
    if (((bits >> (top - 4)) & 31) === 31) return top - 1;
  }
  return -1;
}

const pack = (cat, k) => {
  let s = cat;
  for (let i = 0; i < 5; i++) s = s * 16 + (k[i] ?? 0);
  return s;
};

// Оценка 5–7 карт: чем больше число, тем сильнее рука
export function evaluate(cards) {
  const rc = new Array(13).fill(0);
  const sc = [0, 0, 0, 0];
  const sm = [0, 0, 0, 0];
  let mask = 0;
  for (const c of cards) {
    const r = c >> 2, s = c & 3;
    rc[r]++; sc[s]++; sm[s] |= 1 << r; mask |= 1 << r;
  }
  for (let s = 0; s < 4; s++) {
    if (sc[s] >= 5) {
      const sh = straightHigh(sm[s]);
      if (sh >= 0) return pack(8, [sh]);
    }
  }
  const quads = [], trips = [], pairs = [], singles = [];
  for (let r = 12; r >= 0; r--) {
    if (rc[r] === 4) quads.push(r);
    else if (rc[r] === 3) trips.push(r);
    else if (rc[r] === 2) pairs.push(r);
    else if (rc[r] === 1) singles.push(r);
  }
  if (quads.length) {
    const kick = Math.max(...[...trips, ...pairs, ...singles], -1);
    return pack(7, [quads[0], kick]);
  }
  if (trips.length && (trips.length > 1 || pairs.length)) {
    const pr = Math.max(trips[1] ?? -1, pairs[0] ?? -1);
    return pack(6, [trips[0], pr]);
  }
  for (let s = 0; s < 4; s++) {
    if (sc[s] >= 5) {
      const k = [];
      for (let r = 12; r >= 0 && k.length < 5; r--) if (sm[s] & (1 << r)) k.push(r);
      return pack(5, k);
    }
  }
  const sh = straightHigh(mask);
  if (sh >= 0) return pack(4, [sh]);
  if (trips.length) {
    const rest = [...pairs, ...singles].sort((a, b) => b - a);
    return pack(3, [trips[0], rest[0], rest[1]]);
  }
  if (pairs.length >= 2) {
    const rest = [...pairs.slice(2), ...singles].sort((a, b) => b - a);
    return pack(2, [pairs[0], pairs[1], rest[0]]);
  }
  if (pairs.length === 1) return pack(1, [pairs[0], singles[0], singles[1], singles[2]]);
  return pack(0, singles.slice(0, 5));
}

export const categoryOf = score => Math.floor(score / 1048576); // 16^5

const RANK_NAME_GEN = ['двоек', 'троек', 'четвёрок', 'пятёрок', 'шестёрок', 'семёрок', 'восьмёрок', 'девяток', 'десяток', 'вальтов', 'дам', 'королей', 'тузов'];
const RANK_NAME = ['двойка', 'тройка', 'четвёрка', 'пятёрка', 'шестёрка', 'семёрка', 'восьмёрка', 'девятка', 'десятка', 'валет', 'дама', 'король', 'туз'];

export function handName(score) {
  const cat = categoryOf(score);
  const k = [];
  let s = score;
  for (let i = 0; i < 5; i++) { k.unshift(s % 16); s = Math.floor(s / 16); }
  switch (cat) {
    case 8: return k[0] === 12 ? 'Роял-флеш' : `Стрит-флеш до: ${RANK_NAME[k[0]]}`;
    case 7: return `Каре ${RANK_NAME_GEN[k[0]]}`;
    case 6: return `Фулл-хаус: ${RANK_NAME_GEN[k[0]]} и ${RANK_NAME_GEN[k[1]]}`;
    case 5: return `Флеш, старшая ${RANK_NAME[k[0]]}`;
    case 4: return `Стрит до: ${RANK_NAME[k[0]]}`;
    case 3: return `Сет ${RANK_NAME_GEN[k[0]]}`;
    case 2: return `Две пары: ${RANK_NAME_GEN[k[0]]} и ${RANK_NAME_GEN[k[1]]}`;
    case 1: return `Пара ${RANK_NAME_GEN[k[0]]}`;
    default: return `Старшая карта: ${RANK_NAME[k[0]]}`;
  }
}

// Какие 5 карт образуют лучшую комбинацию (для подсветки)
export function bestFive(cards) {
  if (cards.length <= 5) return cards.slice();
  const best = evaluate(cards);
  const n = cards.length;
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) for (let c = b + 1; c < n; c++)
    for (let d = c + 1; d < n; d++) for (let e = d + 1; e < n; e++) {
      const five = [cards[a], cards[b], cards[c], cards[d], cards[e]];
      if (evaluate(five) === best) return five;
    }
  return cards.slice(0, 5);
}
