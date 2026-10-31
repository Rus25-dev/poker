// Статистика и рейтинг (хранится на каждом телефоне, обновляется по результатам раздач)
const KEY = 'rpoker_stats_v1';

function load() {
  try { return JSON.parse(localStorage.getItem(KEY)) || { players: {}, tournaments: [] }; }
  catch { return { players: {}, tournaments: [] }; }
}
function save(db) { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch { /* память переполнена */ } }

function rec(db, name, bot) {
  if (!db.players[name]) db.players[name] = {
    name, bot: !!bot, hands: 0, vpip: 0, pfr: 0, won: 0, showdowns: 0, sdWon: 0,
    net: 0, biggestPot: 0, tours: 0, tourWins: 0, top3: 0, rating: 1500, lastSeen: 0
  };
  return db.players[name];
}

export function recordHand(result) {
  const db = load();
  const winners = new Set(result.winners.map(w => w.id));
  for (const p of result.players || []) {
    const r = rec(db, p.name, p.bot);
    r.hands++; r.lastSeen = Date.now();
    if (p.vpip) r.vpip++;
    if (p.pfr) r.pfr++;
    if (p.showdown) r.showdowns++;
    if (winners.has(p.id)) {
      r.won++;
      if (p.showdown) r.sdWon++;
      r.biggestPot = Math.max(r.biggestPot, result.pot);
    }
    r.net += p.net;
  }
  save(db);
}

// Многопользовательский Эло по итоговым местам турнира
export function recordTournament(places) {
  if (!places || places.length < 2) return;
  const db = load();
  const n = places.length;
  const K = 40 / (n - 1);
  const rs = places.map(p => rec(db, p.name, p.bot));
  const delta = new Array(n).fill(0);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    if (i === j) continue;
    const exp = 1 / (1 + Math.pow(10, (rs[j].rating - rs[i].rating) / 400));
    const score = places[i].place < places[j].place ? 1 : 0;
    delta[i] += K * (score - exp);
  }
  rs.forEach((r, i) => {
    r.rating = Math.round(r.rating + delta[i]);
    r.tours++;
    if (places[i].place === 1) r.tourWins++;
    if (places[i].place <= 3) r.top3++;
  });
  db.tournaments.unshift({ at: Date.now(), places: places.map(p => ({ name: p.name, place: p.place })) });
  db.tournaments = db.tournaments.slice(0, 50);
  save(db);
}

export function getStats() {
  const db = load();
  const list = Object.values(db.players).map(r => ({
    ...r,
    vpipPct: r.hands ? Math.round(100 * r.vpip / r.hands) : 0,
    pfrPct: r.hands ? Math.round(100 * r.pfr / r.hands) : 0,
    winPct: r.hands ? Math.round(100 * r.won / r.hands) : 0,
    sdPct: r.showdowns ? Math.round(100 * r.sdWon / r.showdowns) : 0,
    style: playStyle(r)
  }));
  list.sort((a, b) => b.rating - a.rating || b.net - a.net);
  return { players: list, tournaments: db.tournaments };
}

function playStyle(r) {
  if (r.hands < 20) return 'мало данных';
  const v = r.vpip / r.hands, p = r.pfr / r.hands;
  const loose = v > 0.32, aggr = p > v * 0.55;
  if (!loose && aggr) return 'тайт-агрессивный';
  if (!loose && !aggr) return 'тайт-пассивный';
  if (loose && aggr) return 'луз-агрессивный';
  return 'луз-пассивный';
}

export function resetStats() { save({ players: {}, tournaments: [] }); }
export function exportStats() { return JSON.stringify(load(), null, 1); }
