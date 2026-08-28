// Simple greedy bot AI. botStep(game) performs ONE pending bot action and returns
// true if it acted, so the server can broadcast + pace each move for animations.
import { COSTS } from './engine.js';

const RES = ['wood', 'brick', 'sheep', 'wheat', 'ore'];

export function botStep(g) {
  if (g.phase === 'game_over') return false;

  const cur = g.cur();

  // 1) respond to or manage an active trade offer
  if (g.trade) {
    if (botTradeResponse(g)) return true;
    
    if (g.trade.from === cur.idx && cur.isBot) {
      if (g.trade.accepted.length > 0) {
        const res = g.act(cur.id, 'finalizeTrade', { withIdx: g.trade.accepted[0] });
        if (!res.ok) g.act(cur.id, 'cancelTrade');
        cur.tradeWaitTicks = 0;
        return true;
      }
      const others = g.players.filter(p => p.idx !== cur.idx);
      const allAnswered = others.every(p => g.trade.accepted.includes(p.idx) || g.trade.rejected.includes(p.idx));
      cur.tradeWaitTicks = (cur.tradeWaitTicks || 0) + 1;
      if (allAnswered || cur.tradeWaitTicks > 12) {
        g.act(cur.id, 'cancelTrade');
        cur.tradeWaitTicks = 0;
        return true;
      }
      return false; // wait for human responses
    }
  }
  // 2) discard on a 7
  if (g.phase === 'discard') {
    for (const p of g.players) {
      if (p.isBot && g.discardQueue[p.idx] != null) { botDiscard(g, p); return true; }
    }
    return false;
  }
  // 3) move the robber (from a 7 or a played knight)
  if (g.phase === 'move_robber') {
    const mover = g.players[g.pendingRobberFrom];
    if (mover && mover.isBot) { botMoveRobber(g, mover); return true; }
    return false;
  }
  // 4) setup placements
  if (g.phase === 'setup') {
    const actor = g.players[g.setupActor()];
    if (!actor.isBot) return false;
    if (g.setupStep === 'settlement') {
      const v = bestOpenVertex(g);
      g.act(actor.id, 'placeSetupSettlement', { vertexId: v });
    } else {
      const last = g.lastSettlementVertex;
      const edges = g.vertex(last).edges.filter(e => g.roads[e] == null);
      const e = pickExpansionEdge(g, actor.idx, edges) ?? edges[0];
      g.act(actor.id, 'placeSetupRoad', { edgeId: e });
    }
    return true;
  }
  // 5/6) the bot's own turn
  if (!cur.isBot) return false;
  if (g.phase === 'roll') { g.act(cur.id, 'rollDice'); return true; }
  if (g.phase === 'main') { botMainTurn(g, cur); return true; }
  return false;
}

// ---- decision helpers ---------------------------------------------------
function has(g, p, cost) { return g.hasResources(p, cost); }

// value of a vertex = sum of dice-probability pips of adjacent producing hexes
function vertexScore(g, vid) {
  const v = g.vertex(vid);
  let s = 0;
  const types = new Set();
  for (const hid of v.hexes) {
    const h = g.board.hexes[hid];
    if (h.type === 'desert' || h.token == null) continue;
    s += 6 - Math.abs(7 - h.token);     // pips: 6&8 -> 5, etc.
    types.add(h.type);
  }
  return s + types.size; // small bonus for resource variety
}

function bestOpenVertex(g) {
  let best = null, bs = -1;
  for (const v of g.board.vertices) {
    if (!g.vertexOpen(v.id)) continue;
    const sc = vertexScore(g, v.id);
    if (sc > bs) { bs = sc; best = v.id; }
  }
  return best;
}

function legalSettlements(g, idx) {
  return g.board.vertices.filter(v => g.vertexOpen(v.id) && g.vertexConnected(v.id, idx)).map(v => v.id);
}
function legalRoads(g, idx) {
  return g.board.edges.filter(e => g.roads[e.id] == null && g.edgeConnected(e.id, idx)).map(e => e.id);
}

// prefer a road whose far end is an open, buildable settlement spot
function pickExpansionEdge(g, idx, edges) {
  let best = null, bs = -1;
  for (const eid of edges) {
    const e = g.edge(eid);
    for (const vid of [e.v1, e.v2]) {
      if (!g.vertexOpen(vid)) continue;
      const sc = vertexScore(g, vid);
      if (sc > bs) { bs = sc; best = eid; }
    }
  }
  return best;
}

function botMainTurn(g, p) {
  // play a knight if we have one and there's a worthwhile robber target
  if (!g.devPlayedThisTurn && p.dev.knight > 0 && robberTarget(g, p.idx) != null) {
    g.act(p.id, 'playDev', { type: 'knight' });
    return; // robber move handled on next botStep
  }
  // upgrade to a city (best return on investment)
  if (has(g, p, COSTS.city)) {
    const vid = Object.keys(g.settlements).find(v => g.settlements[v].player === p.idx && g.settlements[v].type === 'settlement');
    if (vid != null) { g.act(p.id, 'buildCity', { vertexId: +vid }); return; }
  }
  // new settlement on the best legal spot
  const spots = legalSettlements(g, p.idx);
  if (has(g, p, COSTS.settlement) && spots.length) {
    spots.sort((a, b) => vertexScore(g, b) - vertexScore(g, a));
    g.act(p.id, 'buildSettlement', { vertexId: spots[0] }); return;
  }
  // only spend wood/brick on a road when there's NO reachable spot yet — otherwise
  // save those cards for the settlement (or a trade toward it) instead of wasting them
  if (has(g, p, COSTS.road) && spots.length === 0) {
    const e = pickExpansionEdge(g, p.idx, legalRoads(g, p.idx));
    if (e != null) { g.act(p.id, 'buildRoad', { edgeId: e }); return; }
  }
  // try offering a trade to players (limited by botTradeLimit)
  p.tradesProposedThisTurn = p.tradesProposedThisTurn || 0;
  if (p.tradesProposedThisTurn < (g.botTradeLimit ?? 1)) {
    p.tradesProposedThisTurn++;
    if (botTryPlayerTrade(g, p)) return;
  }
  // bank/port trade toward something useful, then loop again next step
  if (botTryBankTrade(g, p)) return;
  // buy a development card with spare resources
  if (g.devDeck.length && has(g, p, COSTS.dev)) { g.act(p.id, 'buyDev'); return; }
  // nothing else worthwhile
  p.tradesProposedThisTurn = 0;
  g.act(p.id, 'endTurn');
}

function botTryPlayerTrade(g, p) {
  const goals = [COSTS.city, COSTS.settlement, COSTS.road];
  for (const goal of goals) {
    const need = RES.filter(r => (goal[r] || 0) > p.resources[r]);
    const surplus = RES.filter(r => p.resources[r] > (goal[r] || 0));
    if (need.length > 0 && surplus.length > 0) {
      const give = { [surplus[0]]: 1 };
      const get = { [need[0]]: 1 };
      const res = g.act(p.id, 'proposeTrade', { give, get });
      if (res.ok) return true;
    }
  }
  return false;
}

// try to convert a surplus (>=rate of one resource) into a resource we need to build
function botTryBankTrade(g, p) {
  const goals = [COSTS.city, COSTS.settlement];
  for (const goal of goals) {
    const need = RES.find(r => (goal[r] || 0) > p.resources[r]);
    if (!need) continue; // already affordable (shouldn't happen, handled above)
    // find a resource we have plenty of and don't need for this goal
    for (const give of RES) {
      if (give === need) continue;
      const rate = g.portRate(p, give);
      if (p.resources[give] >= rate + (goal[give] || 0)) {
        const r = g.act(p.id, 'bankTrade', { give, get: need });
        if (r.ok) return true;
      }
    }
  }
  return false;
}

function robberTarget(g, idx) {
  // a hex with an opponent building, not the desert/current robber hex; prefer the leader (unless easy difficulty)
  let best = null, bestVP = -1;
  const isRandom = g.botDifficulty === 1;
  
  for (const h of g.board.hexes) {
    if (h.id === g.board.robberHex || h.type === 'desert') continue;
    const corners = g.board.vertices.filter(v => v.hexes.includes(h.id));
    for (const v of corners) {
      const s = g.settlements[v.id];
      if (s && s.player !== idx) {
        let vp = g.visibleVP(g.players[s.player]);
        if (isRandom) vp = Math.random() * 10;
        if (vp > bestVP) { bestVP = vp; best = { hexId: h.id, victim: s.player }; }
      }
    }
  }
  return best;
}

function botMoveRobber(g, p) {
  const t = robberTarget(g, p.idx);
  if (t) {
    const victim = g.players[t.victim];
    g.act(p.id, 'moveRobber', { hexId: t.hexId, targetId: victim.id });
  } else {
    const hex = g.board.hexes.find(h => h.id !== g.board.robberHex && h.type !== 'desert') || g.board.hexes.find(h => h.id !== g.board.robberHex);
    g.act(p.id, 'moveRobber', { hexId: hex.id });
  }
}

function botDiscard(g, p) {
  let need = g.discardQueue[p.idx];
  const drop = {};
  // shed from the largest piles first
  const piles = RES.map(r => [r, p.resources[r]]).sort((a, b) => b[1] - a[1]);
  while (need > 0) {
    for (const [r] of piles) {
      if (need <= 0) break;
      if ((drop[r] || 0) < p.resources[r]) { drop[r] = (drop[r] || 0) + 1; need--; }
    }
  }
  g.act(p.id, 'discard', { resources: drop });
}

function botTradeResponse(g) {
  const t = g.trade;
  for (const p of g.players) {
    if (!p.isBot || p.idx === t.from) continue;
    if (t.accepted.includes(p.idx) || t.rejected.includes(p.idx)) continue;
    // bot would give t.get and receive t.give
    const mustGive = t.get, willGet = t.give;
    const afford = Object.entries(mustGive).every(([k, v]) => p.resources[k] >= v);
    const giveCount = sum(mustGive), getCount = sum(willGet);
    
    let accept = false;
    const diff = g.botDifficulty ?? 2;
    if (diff === 1) {
      // easy: accepts any trade it can afford if it gets something
      accept = afford && getCount > 0;
    } else if (diff === 2) {
      // normal: accept a fair-or-better deal it can afford
      accept = afford && getCount >= giveCount && getCount > 0;
    } else {
      // hard: accept only if it gets something it strictly needs, and it's a fair deal
      const needs = [];
      for (const goal of [COSTS.city, COSTS.settlement, COSTS.road, COSTS.dev]) {
        for (const r of RES) {
          if ((goal[r] || 0) > p.resources[r] && !needs.includes(r)) needs.push(r);
        }
      }
      const gettingNeeded = Object.keys(willGet).some(r => needs.includes(r));
      accept = afford && getCount >= giveCount && gettingNeeded;
    }
    g.act(p.id, 'respondTrade', { accept });
    return true;
  }
  return false;
}

function sum(o) { return Object.values(o).reduce((a, b) => a + b, 0); }
