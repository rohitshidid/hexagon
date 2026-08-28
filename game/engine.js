// Authoritative game engine. All rule validation lives here.
import { generateBoard } from './board.js';

export const COLORS = [
  '#e23d3d', '#3d7fe2', '#2fbf6b', '#f0a830',
  '#9b59d0', '#16c0c0', '#e85aa8', '#7f8c3a',
  '#d96a2b', '#5d6d7e',
];

export const COSTS = {
  road: { wood: 1, brick: 1 },
  settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1 },
  city: { wheat: 2, ore: 3 },
  dev: { sheep: 1, wheat: 1, ore: 1 },
};

const PIECE_LIMITS = { roads: 15, settlements: 5, cities: 4 };

function emptyRes() {
  return { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 };
}

function buildDevDeck(size) {
  // Catan ratio per 25: 14 knight, 5 vp, 2 road, 2 plenty, 2 monopoly.
  const base = [];
  const add = (t, n) => { for (let i = 0; i < n; i++) base.push(t); };
  const scale = Math.max(1, Math.round(size / 19));
  add('knight', 14 * scale);
  add('vp', 5 * scale);
  add('road_building', 2 * scale);
  add('year_of_plenty', 2 * scale);
  add('monopoly', 2 * scale);
  return shuffle(base);
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export class Game {
  constructor(players, opts = {}) {
    // players: [{id, name}]
    this.radiusOverride = opts.radiusOverride;
    this.board = generateBoard(players.length, this.radiusOverride);
    this.devDeck = buildDevDeck(this.board.hexes.length);
    this.winVP = opts.winVP ?? (players.length <= 6 ? 10 : 12);
    this.botDifficulty = opts.botDifficulty ?? 2;
    this.botTradeLimit = opts.botTradeLimit ?? 1;

    this.players = players.map((p, i) => ({
      id: p.id,
      name: p.name,
      color: COLORS[i % COLORS.length],
      idx: i,
      isBot: !!p.bot,
      resources: emptyRes(),
      dev: { knight: 0, vp: 0, road_building: 0, year_of_plenty: 0, monopoly: 0 },
      newDev: { knight: 0, road_building: 0, year_of_plenty: 0, monopoly: 0 }, // bought this turn, locked
      knightsPlayed: 0,
      ports: [],          // port types this player can use
      vp: 0,              // public vp (settlements/cities/bonuses)
    }));

    // topology occupancy
    this.settlements = {}; // vertexId -> {player, type:'settlement'|'city'}
    this.roads = {};       // edgeId -> player index

    this.turn = 0;                 // index into players
    this.phase = 'setup';          // setup | roll | discard | move_robber | main | game_over
    this.setupStep = 'settlement'; // settlement | road
    this.setupRound = 1;           // 1 then 2 (snake)
    this.setupOrder = this.players.map((_, i) => i)
      .concat(this.players.map((_, i) => i).reverse());
    this.setupPos = 0;
    this.lastSettlementVertex = null;

    this.dice = null;
    this.discardQueue = {};        // playerIdx -> count needed
    this.pendingRobberFrom = null; // who must move robber
    this.devPlayedThisTurn = false;
    this.freeRoads = 0;            // from road_building card
    this.largestArmy = null;       // player idx
    this.longestRoad = null;       // player idx
    this.longestRoadLen = 0;
    this.winner = null;
    this.log = [];
    this.trade = null;             // active player-trade offer

    this.pushLog(`Game started. First to ${this.winVP} points wins. Place your starting pieces.`);
  }

  pushLog(msg) {
    this.log.push({ t: Date.now(), msg });
    if (this.log.length > 60) this.log.shift();
  }

  cur() { return this.players[this.turn]; }

  // ---- helpers ----------------------------------------------------------
  vertex(id) { return this.board.vertices[id]; }
  edge(id) { return this.board.edges[id]; }

  hasResources(p, cost) {
    return Object.entries(cost).every(([k, v]) => p.resources[k] >= v);
  }
  pay(p, cost) {
    for (const [k, v] of Object.entries(cost)) p.resources[k] -= v;
  }
  countCards(p) {
    return Object.values(p.resources).reduce((a, b) => a + b, 0);
  }
  pieceCount(idx, type) {
    if (type === 'roads') return Object.values(this.roads).filter(p => p === idx).length;
    return Object.values(this.settlements)
      .filter(s => s.player === idx && (type === 'settlements' ? s.type === 'settlement' : s.type === 'city')).length;
  }

  // vertex is buildable for settlement (distance rule + empty)
  vertexOpen(vid) {
    if (this.settlements[vid]) return false;
    const v = this.vertex(vid);
    for (const nb of v.verts) if (this.settlements[nb]) return false;
    return true;
  }

  // does player connect to vertex via own road?
  vertexConnected(vid, idx) {
    const v = this.vertex(vid);
    return v.edges.some(eid => this.roads[eid] === idx);
  }

  edgeConnected(eid, idx) {
    const e = this.edge(eid);
    for (const vid of [e.v1, e.v2]) {
      // own road into this vertex
      const v = this.vertex(vid);
      if (v.edges.some(x => x !== eid && this.roads[x] === idx)) {
        // but a road chain is broken by an opponent settlement on the vertex
        const s = this.settlements[vid];
        if (!s || s.player === idx) return true;
      }
      // own settlement/city on the vertex
      const s = this.settlements[vid];
      if (s && s.player === idx) return true;
    }
    return false;
  }

  // ---- public state for clients ----------------------------------------
  publicState(forPlayerId) {
    return {
      board: this.board,
      winVP: this.winVP,
      botTradeLimit: this.botTradeLimit,
      botDifficulty: this.botDifficulty,
      radiusOverride: this.radiusOverride,
      players: this.players.map(p => ({
        id: p.id, name: p.name, color: p.color, idx: p.idx, isBot: p.isBot,
        vp: this.phase === 'game_over' || p.id === forPlayerId ? this.totalVP(p) : this.visibleVP(p),
        cardCount: this.countCards(p),
        devCount: Object.values(p.dev).reduce((a, b) => a + b, 0)
          + Object.values(p.newDev).reduce((a, b) => a + b, 0),
        knightsPlayed: p.knightsPlayed,
        ports: p.ports,
        // private hand only to the owner
        resources: p.id === forPlayerId ? p.resources : undefined,
        dev: p.id === forPlayerId ? p.dev : undefined,
        newDev: p.id === forPlayerId ? p.newDev : undefined,
        longestRoad: this.longestRoad === p.idx,
        largestArmy: this.largestArmy === p.idx,
      })),
      settlements: this.settlements,
      roads: this.roads,
      robberHex: this.board.robberHex,
      turn: this.turn,
      phase: this.phase,
      setupStep: this.setupStep,
      setupRound: this.setupRound,
      setupPos: this.setupPos,
      setupActor: this.phase === 'setup' ? this.setupActor() : null,
      lastSettlementVertex: this.lastSettlementVertex,
      dice: this.dice,
      discardQueue: this.discardQueue,
      pendingRobberFrom: this.pendingRobberFrom,
      freeRoads: this.freeRoads,
      devPlayedThisTurn: this.devPlayedThisTurn,
      longestRoadLen: this.longestRoadLen,
      winner: this.winner,
      log: this.log,
      trade: this.trade,
    };
  }

  // public VP excludes hidden vp cards except for game-end check
  visibleVP(p) {
    let vp = 0;
    vp += this.pieceCount(p.idx, 'settlements') * 1;
    vp += this.pieceCount(p.idx, 'cities') * 2;
    if (this.longestRoad === p.idx) vp += 2;
    if (this.largestArmy === p.idx) vp += 2;
    return vp;
  }
  totalVP(p) {
    return this.visibleVP(p) + (p.dev.vp || 0);
  }

  // ---- actions ----------------------------------------------------------
  // returns {ok:bool, error?:string}
  act(playerId, action, data = {}) {
    const p = this.players.find(x => x.id === playerId);
    if (!p) return { ok: false, error: 'unknown player' };

    try {
      switch (action) {
        case 'placeSetupSettlement': return this.placeSetupSettlement(p, data.vertexId);
        case 'placeSetupRoad':       return this.placeSetupRoad(p, data.edgeId);
        case 'rollDice':             return this.rollDice(p);
        case 'discard':              return this.doDiscard(p, data.resources);
        case 'moveRobber':           return this.moveRobber(p, data.hexId, data.targetId);
        case 'buildRoad':            return this.buildRoad(p, data.edgeId);
        case 'buildSettlement':      return this.buildSettlement(p, data.vertexId);
        case 'buildCity':            return this.buildCity(p, data.vertexId);
        case 'buyDev':               return this.buyDev(p);
        case 'playDev':              return this.playDev(p, data);
        case 'bankTrade':            return this.bankTrade(p, data.give, data.get);
        case 'proposeTrade':         return this.proposeTrade(p, data);
        case 'respondTrade':         return this.respondTrade(p, data);
        case 'finalizeTrade':        return this.finalizeTrade(p, data.withIdx);
        case 'cancelTrade':          return this.cancelTrade(p);
        case 'endTurn':              return this.endTurn(p);
        default: return { ok: false, error: 'unknown action' };
      }
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  isTurn(p) { return this.turn === p.idx; }

  // ---- SETUP ------------------------------------------------------------
  setupActor() { return this.setupOrder[this.setupPos]; }

  placeSetupSettlement(p, vid) {
    if (this.phase !== 'setup') return { ok: false, error: 'not setup phase' };
    if (this.setupStep !== 'settlement') return { ok: false, error: 'place a road' };
    if (this.setupActor() !== p.idx) return { ok: false, error: 'not your turn' };
    if (vid == null || !this.vertex(vid)) return { ok: false, error: 'bad vertex' };
    if (!this.vertexOpen(vid)) return { ok: false, error: 'too close to another building' };

    this.settlements[vid] = { player: p.idx, type: 'settlement' };
    this.lastSettlementVertex = vid;
    this.grantPort(p, vid);

    // second-round settlement grants adjacent resources
    if (this.setupPos >= this.players.length) {
      for (const hid of this.vertex(vid).hexes) {
        const h = this.board.hexes[hid];
        if (h.type !== 'desert') p.resources[h.type] += 1;
      }
    }
    this.setupStep = 'road';
    this.pushLog(`${p.name} placed a settlement.`);
    return { ok: true };
  }

  placeSetupRoad(p, eid) {
    if (this.phase !== 'setup') return { ok: false, error: 'not setup phase' };
    if (this.setupStep !== 'road') return { ok: false, error: 'place a settlement' };
    if (this.setupActor() !== p.idx) return { ok: false, error: 'not your turn' };
    const e = this.edge(eid);
    if (!e) return { ok: false, error: 'bad edge' };
    if (this.roads[eid] != null) return { ok: false, error: 'edge taken' };
    // must touch the settlement just placed
    if (e.v1 !== this.lastSettlementVertex && e.v2 !== this.lastSettlementVertex)
      return { ok: false, error: 'road must touch your new settlement' };

    this.roads[eid] = p.idx;
    this.pushLog(`${p.name} placed a road.`);
    this.updateLongestRoad();

    // advance snake
    this.setupPos++;
    this.setupStep = 'settlement';
    if (this.setupPos >= this.setupOrder.length) {
      // setup done -> first player's roll
      this.phase = 'roll';
      this.turn = 0;
      this.pushLog(`Setup complete. ${this.players[0].name} rolls first.`);
    } else if (this.setupPos === this.players.length) {
      this.pushLog('Second placement round (reverse order).');
    }
    return { ok: true };
  }

  grantPort(p, vid) {
    for (const port of this.board.ports) {
      if (port.vertices.includes(vid) && !p.ports.includes(port.type)) p.ports.push(port.type);
    }
  }

  // ---- ROLL / PRODUCTION ------------------------------------------------
  rollDice(p) {
    if (this.phase !== 'roll') return { ok: false, error: 'cannot roll now' };
    if (!this.isTurn(p)) return { ok: false, error: 'not your turn' };
    const d1 = 1 + Math.floor(Math.random() * 6);
    const d2 = 1 + Math.floor(Math.random() * 6);
    const sum = d1 + d2;
    this.dice = { d1, d2, sum };
    this.pushLog(`${p.name} rolled ${sum} (${d1}+${d2}).`);

    if (sum === 7) {
      // discard for everyone over 7
      this.discardQueue = {};
      for (const pl of this.players) {
        const c = this.countCards(pl);
        if (c > 7) this.discardQueue[pl.idx] = Math.floor(c / 2);
      }
      if (Object.keys(this.discardQueue).length) {
        this.phase = 'discard';
        this.pushLog('Robber! Players with 8+ cards discard half.');
      } else {
        this.phase = 'move_robber';
        this.pendingRobberFrom = p.idx;
      }
      return { ok: true, dice: this.dice };
    }

    // production
    const gains = {};
    for (const h of this.board.hexes) {
      if (h.token !== sum || h.id === this.board.robberHex || h.type === 'desert') continue;
      const corners = this.board.vertices.filter(v => v.hexes.includes(h.id));
      for (const v of corners) {
        const s = this.settlements[v.id];
        if (!s) continue;
        const amt = s.type === 'city' ? 2 : 1;
        this.players[s.player].resources[h.type] += amt;
        gains[s.player] = gains[s.player] || {};
        gains[s.player][h.type] = (gains[s.player][h.type] || 0) + amt;
      }
    }
    this.phase = 'main';
    return { ok: true, dice: this.dice, gains };
  }

  doDiscard(p, resources) {
    if (this.phase !== 'discard') return { ok: false, error: 'not discard phase' };
    const need = this.discardQueue[p.idx];
    if (need == null) return { ok: false, error: 'you do not need to discard' };
    const total = Object.values(resources || {}).reduce((a, b) => a + (b | 0), 0);
    if (total !== need) return { ok: false, error: `discard exactly ${need} cards` };
    for (const [k, v] of Object.entries(resources)) {
      if ((v | 0) > p.resources[k]) return { ok: false, error: 'not enough cards' };
    }
    for (const [k, v] of Object.entries(resources)) p.resources[k] -= (v | 0);
    delete this.discardQueue[p.idx];
    this.pushLog(`${p.name} discarded ${need} cards.`);
    if (Object.keys(this.discardQueue).length === 0) {
      this.phase = 'move_robber';
      this.pendingRobberFrom = this.turn;
    }
    return { ok: true };
  }

  moveRobber(p, hexId, targetId) {
    if (this.phase !== 'move_robber') return { ok: false, error: 'cannot move robber now' };
    if (this.pendingRobberFrom !== p.idx) return { ok: false, error: 'not your robber move' };
    if (hexId == null || !this.board.hexes[hexId]) return { ok: false, error: 'bad hex' };
    if (hexId === this.board.robberHex) return { ok: false, error: 'move robber to a new hex' };

    this.board.robberHex = hexId;
    // candidate victims: players with a building on this hex (not self)
    const corners = this.board.vertices.filter(v => v.hexes.includes(hexId));
    const victims = new Set();
    for (const v of corners) {
      const s = this.settlements[v.id];
      if (s && s.player !== p.idx && this.countCards(this.players[s.player]) > 0) victims.add(s.player);
    }
    if (victims.size > 0) {
      let target = targetId != null ? this.players.find(x => x.id === targetId)?.idx : null;
      if (target == null || !victims.has(target)) target = [...victims][0];
      const stolen = this.stealRandom(this.players[target], p);
      this.pushLog(`${p.name} moved the robber and stole from ${this.players[target].name}.`);
    } else {
      this.pushLog(`${p.name} moved the robber.`);
    }
    this.pendingRobberFrom = null;
    // if robber came from a knight during main phase, return to main; if from roll, go main
    this.phase = 'main';
    return { ok: true };
  }

  stealRandom(victim, thief) {
    const pool = [];
    for (const [k, v] of Object.entries(victim.resources)) for (let i = 0; i < v; i++) pool.push(k);
    if (!pool.length) return null;
    const card = pool[Math.floor(Math.random() * pool.length)];
    victim.resources[card] -= 1;
    thief.resources[card] += 1;
    return card;
  }

  // ---- BUILDING ---------------------------------------------------------
  buildRoad(p, eid) {
    if (this.phase !== 'main') return { ok: false, error: 'not build phase' };
    if (!this.isTurn(p)) return { ok: false, error: 'not your turn' };
    const e = this.edge(eid);
    if (!e) return { ok: false, error: 'bad edge' };
    if (this.roads[eid] != null) return { ok: false, error: 'edge taken' };
    if (this.pieceCount(p.idx, 'roads') >= PIECE_LIMITS.roads) return { ok: false, error: 'no roads left' };
    if (!this.edgeConnected(eid, p.idx)) return { ok: false, error: 'must connect to your network' };

    const free = this.freeRoads > 0;
    if (!free) {
      if (!this.hasResources(p, COSTS.road)) return { ok: false, error: 'need 1 wood + 1 brick' };
      this.pay(p, COSTS.road);
    } else {
      this.freeRoads--;
    }
    this.roads[eid] = p.idx;
    this.updateLongestRoad();
    this.pushLog(`${p.name} built a road.`);
    this.checkWin(p);
    return { ok: true };
  }

  buildSettlement(p, vid) {
    if (this.phase !== 'main') return { ok: false, error: 'not build phase' };
    if (!this.isTurn(p)) return { ok: false, error: 'not your turn' };
    if (!this.vertex(vid)) return { ok: false, error: 'bad vertex' };
    if (!this.vertexOpen(vid)) return { ok: false, error: 'too close to another building' };
    if (!this.vertexConnected(vid, p.idx)) return { ok: false, error: 'must connect to your road' };
    if (this.pieceCount(p.idx, 'settlements') >= PIECE_LIMITS.settlements) return { ok: false, error: 'no settlements left' };
    if (!this.hasResources(p, COSTS.settlement)) return { ok: false, error: 'need wood+brick+sheep+wheat' };

    this.pay(p, COSTS.settlement);
    this.settlements[vid] = { player: p.idx, type: 'settlement' };
    this.grantPort(p, vid);
    this.updateLongestRoad(); // a new settlement can cut an opponent's road
    this.pushLog(`${p.name} built a settlement.`);
    this.checkWin(p);
    return { ok: true };
  }

  buildCity(p, vid) {
    if (this.phase !== 'main') return { ok: false, error: 'not build phase' };
    if (!this.isTurn(p)) return { ok: false, error: 'not your turn' };
    const s = this.settlements[vid];
    if (!s || s.player !== p.idx || s.type !== 'settlement') return { ok: false, error: 'upgrade your own settlement' };
    if (this.pieceCount(p.idx, 'cities') >= PIECE_LIMITS.cities) return { ok: false, error: 'no cities left' };
    if (!this.hasResources(p, COSTS.city)) return { ok: false, error: 'need 2 wheat + 3 ore' };

    this.pay(p, COSTS.city);
    s.type = 'city';
    this.pushLog(`${p.name} upgraded to a city.`);
    this.checkWin(p);
    return { ok: true };
  }

  // ---- DEV CARDS --------------------------------------------------------
  buyDev(p) {
    if (this.phase !== 'main') return { ok: false, error: 'not build phase' };
    if (!this.isTurn(p)) return { ok: false, error: 'not your turn' };
    if (!this.devDeck.length) return { ok: false, error: 'dev deck empty' };
    if (!this.hasResources(p, COSTS.dev)) return { ok: false, error: 'need sheep+wheat+ore' };

    this.pay(p, COSTS.dev);
    const card = this.devDeck.pop();
    if (card === 'vp') { p.dev.vp = (p.dev.vp || 0) + 1; this.checkWin(p); }
    else p.newDev[card] = (p.newDev[card] || 0) + 1; // locked until next turn
    this.pushLog(`${p.name} bought a development card.`);
    return { ok: true, card };
  }

  playDev(p, data) {
    if (this.phase !== 'main') return { ok: false, error: 'play dev cards on your build phase' };
    if (!this.isTurn(p)) return { ok: false, error: 'not your turn' };
    if (this.devPlayedThisTurn) return { ok: false, error: 'one dev card per turn' };
    const type = data.type;
    if (!['knight', 'road_building', 'year_of_plenty', 'monopoly'].includes(type))
      return { ok: false, error: 'cannot play that card' };
    if ((p.dev[type] || 0) < 1) return { ok: false, error: 'no such card available' };

    p.dev[type] -= 1;
    this.devPlayedThisTurn = true;

    if (type === 'knight') {
      p.knightsPlayed += 1;
      this.updateLargestArmy();
      this.phase = 'move_robber';
      this.pendingRobberFrom = p.idx;
      this.pushLog(`${p.name} played a Knight.`);
      this.checkWin(p);
      return { ok: true };
    }
    if (type === 'road_building') {
      this.freeRoads += 2;
      this.pushLog(`${p.name} played Road Building (2 free roads).`);
      return { ok: true };
    }
    if (type === 'year_of_plenty') {
      const picks = data.resources || [];
      if (picks.length !== 2) return { ok: false, error: 'pick exactly 2 resources' };
      for (const r of picks) {
        if (!(r in p.resources)) return { ok: false, error: 'bad resource' };
        p.resources[r] += 1;
      }
      this.pushLog(`${p.name} played Year of Plenty.`);
      return { ok: true };
    }
    if (type === 'monopoly') {
      const res = data.resource;
      if (!(res in p.resources)) return { ok: false, error: 'bad resource' };
      let total = 0;
      for (const other of this.players) {
        if (other.idx === p.idx) continue;
        total += other.resources[res];
        other.resources[res] = 0;
      }
      p.resources[res] += total;
      this.pushLog(`${p.name} played Monopoly on ${res} (+${total}).`);
      return { ok: true };
    }
    return { ok: false, error: 'unhandled' };
  }

  // ---- TRADING ----------------------------------------------------------
  portRate(p, res) {
    if (p.ports.includes(res)) return 2;
    if (p.ports.includes('3:1')) return 3;
    return 4;
  }

  bankTrade(p, give, get) {
    if (this.phase !== 'main') return { ok: false, error: 'trade on your turn' };
    if (!this.isTurn(p)) return { ok: false, error: 'not your turn' };
    if (!give || !get || !(give in p.resources) || !(get in p.resources))
      return { ok: false, error: 'bad trade' };
    const rate = this.portRate(p, give);
    if (p.resources[give] < rate) return { ok: false, error: `need ${rate} ${give}` };
    p.resources[give] -= rate;
    p.resources[get] += 1;
    this.pushLog(`${p.name} traded ${rate} ${give} for 1 ${get}.`);
    return { ok: true };
  }

  proposeTrade(p, data) {
    if (this.phase !== 'main') return { ok: false, error: 'trade on your turn' };
    if (!this.isTurn(p)) return { ok: false, error: 'only the active player offers trades' };
    const give = sanitizeRes(data.give), get = sanitizeRes(data.get);
    if (sum(give) === 0 && sum(get) === 0) return { ok: false, error: 'empty offer' };
    if (!canAfford(p.resources, give)) return { ok: false, error: 'you do not have those cards' };
    this.trade = { from: p.idx, give, get, accepted: [], rejected: [] };
    this.pushLog(`${p.name} proposed a trade.`);
    return { ok: true };
  }

  respondTrade(p, data) {
    if (!this.trade) return { ok: false, error: 'no active trade' };
    if (p.idx === this.trade.from) return { ok: false, error: 'you proposed this trade' };
    if (data.accept) {
      if (!canAfford(p.resources, this.trade.get)) return { ok: false, error: 'you do not have the requested resources' };
      // the active player confirms which acceptor to trade with via data.confirmWith
      if (data.confirmWith != null) return { ok: false, error: 'use confirm path' };
      if (!this.trade.accepted.includes(p.idx)) this.trade.accepted.push(p.idx);
      this.pushLog(`${p.name} is willing to trade.`);
      return { ok: true };
    } else {
      if (!this.trade.rejected.includes(p.idx)) this.trade.rejected.push(p.idx);
      return { ok: true };
    }
  }

  // active player finalizes with an acceptor
  cancelTrade(p) {
    if (!this.trade) return { ok: false, error: 'no trade' };
    if (this.trade.from !== p.idx && p.idx != null) {
      // allow finalize: data passed via cancelTrade? keep simple: only proposer cancels
    }
    if (this.trade.from !== p.idx) return { ok: false, error: 'only proposer can close' };
    this.trade = null;
    return { ok: true };
  }

  finalizeTrade(proposer, withIdx) {
    if (!this.trade || this.trade.from !== proposer.idx) return { ok: false, error: 'no trade' };
    if (!this.trade.accepted.includes(withIdx)) return { ok: false, error: 'that player has not accepted' };
    const other = this.players[withIdx];
    const { give, get } = this.trade;
    if (!canAfford(proposer.resources, give)) return { ok: false, error: 'proposer lacks cards' };
    if (!canAfford(other.resources, get)) return { ok: false, error: 'partner lacks cards' };
    for (const k in give) { proposer.resources[k] -= give[k]; other.resources[k] += give[k]; }
    for (const k in get) { other.resources[k] -= get[k]; proposer.resources[k] += get[k]; }
    this.pushLog(`${proposer.name} traded with ${other.name}.`);
    this.trade = null;
    return { ok: true };
  }

  // ---- TURN END ---------------------------------------------------------
  endTurn(p) {
    if (this.phase !== 'main') return { ok: false, error: 'cannot end turn now' };
    if (!this.isTurn(p)) return { ok: false, error: 'not your turn' };
    // unlock dev cards bought this turn
    for (const k of Object.keys(p.newDev)) {
      p.dev[k] = (p.dev[k] || 0) + p.newDev[k];
      p.newDev[k] = 0;
    }
    this.devPlayedThisTurn = false;
    this.freeRoads = 0;
    this.trade = null;
    this.dice = null;
    this.turn = (this.turn + 1) % this.players.length;
    this.phase = 'roll';
    this.pushLog(`${this.players[this.turn].name}'s turn.`);
    return { ok: true };
  }

  // ---- BONUSES ----------------------------------------------------------
  updateLargestArmy() {
    let best = this.largestArmy != null ? this.players[this.largestArmy].knightsPlayed : 2;
    let holder = this.largestArmy;
    for (const p of this.players) {
      if (p.knightsPlayed >= 3 && p.knightsPlayed > best) { best = p.knightsPlayed; holder = p.idx; }
    }
    if (holder !== this.largestArmy) {
      this.largestArmy = holder;
      this.pushLog(`${this.players[holder].name} now holds Largest Army.`);
    }
  }

  updateLongestRoad() {
    let bestLen = 0, bestPlayer = null;
    for (const p of this.players) {
      const len = this.longestRoadFor(p.idx);
      if (len > bestLen) { bestLen = len; bestPlayer = p.idx; }
    }
    if (bestLen < 5) {
      if (this.longestRoad != null) { this.longestRoad = null; this.longestRoadLen = 0; }
      return;
    }
    // keep current holder if tie and still >=5
    const curLen = this.longestRoad != null ? this.longestRoadFor(this.longestRoad) : 0;
    if (this.longestRoad != null && curLen >= bestLen && curLen >= 5) {
      this.longestRoadLen = curLen;
      return;
    }
    if (bestPlayer !== this.longestRoad) {
      this.longestRoad = bestPlayer;
      this.longestRoadLen = bestLen;
      this.pushLog(`${this.players[bestPlayer].name} now holds Longest Road (${bestLen}).`);
    } else {
      this.longestRoadLen = bestLen;
    }
  }

  // longest trail of a player's roads (no edge reused; broken by opponent buildings)
  longestRoadFor(idx) {
    const myEdges = Object.keys(this.roads).filter(e => this.roads[e] === idx).map(Number);
    if (!myEdges.length) return 0;
    // adjacency: vertex -> list of {edge, other}
    const adj = new Map();
    for (const eid of myEdges) {
      const e = this.edge(eid);
      for (const [a, b] of [[e.v1, e.v2], [e.v2, e.v1]]) {
        if (!adj.has(a)) adj.set(a, []);
        adj.get(a).push({ edge: eid, to: b });
      }
    }
    const blocked = (vid) => {
      const s = this.settlements[vid];
      return s && s.player !== idx; // opponent building breaks the chain through this vertex
    };
    let best = 0;
    const dfs = (vid, usedEdges) => {
      let local = usedEdges.size;
      best = Math.max(best, local);
      if (blocked(vid)) return; // cannot pass through opponent vertex
      for (const { edge, to } of (adj.get(vid) || [])) {
        if (usedEdges.has(edge)) continue;
        usedEdges.add(edge);
        dfs(to, usedEdges);
        usedEdges.delete(edge);
      }
    };
    for (const v of adj.keys()) dfs(v, new Set());
    return best;
  }

  checkWin(p) {
    if (this.winner != null) return;
    if (this.totalVP(p) >= this.winVP) {
      this.winner = p.idx;
      this.phase = 'game_over';
      this.pushLog(`🏆 ${p.name} wins with ${this.totalVP(p)} points!`);
    }
  }
}

// ---- small helpers ------------------------------------------------------
function sanitizeRes(obj) {
  const out = {};
  for (const k of ['wood', 'brick', 'sheep', 'wheat', 'ore']) {
    const v = obj && obj[k] ? Math.max(0, obj[k] | 0) : 0;
    if (v) out[k] = v;
  }
  return out;
}
function sum(o) { return Object.values(o).reduce((a, b) => a + b, 0); }
function canAfford(res, need) {
  return Object.entries(need).every(([k, v]) => (res[k] || 0) >= v);
}
