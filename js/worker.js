// Фоновые расчёты подсказок, чтобы интерфейс не подтормаживал
import { equity, outs, equityKnown, profileFromHist } from './equity.js';

self.onmessage = ({ data: m }) => {
  try {
    if (m.type === 'hints') {
      const { hole, board, variant, opps, bb } = m;
      const n = Math.max(1, opps.length);
      const its = variant === 'omaha' ? 600 : 2500;
      const profiles = opps.map(h => profileFromHist(h, bb));
      const res = { id: m.id, type: 'hints' };
      if (variant === 'pineapple' && hole.length === 3) {
        // какую карту сбросить: считаем эквити каждого из трёх вариантов
        res.keeps = [0, 1, 2].map(i => {
          const keep = hole.filter((_, j) => j !== i);
          return { drop: hole[i], eq: equity(keep, board, n, 1200, Math.random, { variant: 'holdem', profiles }).equity };
        }).sort((a, b) => b.eq - a.eq);
        const bestKeep = hole.filter(c => c !== res.keeps[0].drop);
        res.range = equity(bestKeep, board, n, its, Math.random, { variant: 'holdem', profiles });
        res.random = equity(bestKeep, board, n, 1200, Math.random, { variant: 'holdem' });
        res.outs = { count: 0 };
      } else {
        const v = variant === 'pineapple' ? 'holdem' : variant;
        res.range = equity(hole, board, n, its, Math.random, { variant: v, profiles });
        res.random = equity(hole, board, n, Math.round(its / 2), Math.random, { variant: v });
        res.outs = outs(hole, board, v);
      }
      self.postMessage(res);
    } else if (m.type === 'allin') {
      const v = m.variant === 'pineapple' ? 'holdem' : m.variant;
      self.postMessage({ id: m.id, type: 'allin', eq: equityKnown(m.hands, m.board, Math.random, v) });
    } else if (m.type === 'review') {
      // эквити на момент каждого решения (для разбора раздачи)
      const out = m.decisions.map(d => {
        const v = d.variant === 'pineapple' ? 'holdem' : d.variant;
        const profiles = (d.opps || []).map(h => profileFromHist(h, d.bb));
        return equity(d.hole.length === 3 ? d.hole.slice(0, 2) : d.hole, d.board, Math.max(1, (d.opps || []).length), 1500, Math.random, { variant: v, profiles }).equity;
      });
      self.postMessage({ id: m.id, type: 'review', eqs: out });
    }
  } catch (e) {
    self.postMessage({ id: m.id, type: 'error', msg: String(e && e.message || e) });
  }
};
