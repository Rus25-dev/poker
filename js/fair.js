// Проверка честности раздачи на стороне игрока:
// 1) хеш раскрытого сида хоста совпадает с хешем, опубликованным ДО раздачи;
// 2) мой сид вошёл в тасовку;
// 3) колода, пересчитанная из сидов, даёт ровно мои карты, карты стола и открытые руки.
import { fairDeck, sha256Hex } from './cards.js';
import { HOLE_COUNT } from './engine.js';
import { fairMaterial } from './host.js';

export async function verifyHand({ fair, result, myId, myHole, mySeed, seenCommit, variant }) {
  if (!fair || !fair.serverSeed) return { ok: false, reason: 'no_data' };
  if (await sha256Hex(fair.serverSeed) !== fair.commit) return { ok: false, reason: 'bad_commit' };
  if (seenCommit && seenCommit !== fair.commit) return { ok: false, reason: 'commit_changed' };
  if (mySeed && fair.seeds[myId] !== undefined && fair.seeds[myId] !== mySeed) return { ok: false, reason: 'seed_mismatch' };
  const deck = await fairDeck(fairMaterial(fair.serverSeed, fair.seeds, fair.handNo));
  const hc = HOLE_COUNT[variant] || 2;
  const order = result.dealOrder || [];
  const dealt = {};
  order.forEach(id => dealt[id] = []);
  for (let r = 0; r < hc; r++) for (const id of order) dealt[id].push(deck.pop());
  const board = [];
  const L = result.board.length;
  if (L >= 3) { deck.pop(); board.push(deck.pop(), deck.pop(), deck.pop()); }
  if (L >= 4) { deck.pop(); board.push(deck.pop()); }
  if (L >= 5) { deck.pop(); board.push(deck.pop()); }
  if (board.join() !== result.board.join()) return { ok: false, reason: 'board' };
  const sub = (a, b) => a.every(c => b.includes(c));
  if (myHole && dealt[myId] && !sub(myHole, dealt[myId])) return { ok: false, reason: 'my_cards' };
  for (const id in result.shown) if (dealt[id] && !sub(result.shown[id].hole, dealt[id])) return { ok: false, reason: 'shown' };
  return { ok: true, includedMySeed: mySeed ? fair.seeds[myId] === mySeed : null };
}
