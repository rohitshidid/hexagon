import { startBackground } from './shader.js';
import { BoardView } from './render.js';

const RES = ['wood', 'brick', 'sheep', 'wheat', 'ore'];
const ICON = { wood: '🌲', brick: '🧱', sheep: '🐑', wheat: '🌾', ore: '⛰️' };
const COSTS = {
  road: { wood: 1, brick: 1 },
  settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1 },
  city: { wheat: 2, ore: 3 },
  dev: { sheep: 1, wheat: 1, ore: 1 },
};
const $ = (id) => document.getElementById(id);

let ws, room = null, you = null, board, prevDice = null, prevPhase = null, prevDevCount = null;
let buildMode = null; // 'road'|'settlement'|'city' chosen via buttons

// ---- session persistence (survive a page refresh / dropped socket) ------
const SKEY = 'hexagon.session';
function loadSession() { try { return JSON.parse(localStorage.getItem(SKEY)); } catch { return null; } }
function saveSession(s) { try { localStorage.setItem(SKEY, JSON.stringify(s)); } catch {} }
function clearSession() { session = null; try { localStorage.removeItem(SKEY); } catch {} }
let session = loadSession();
let myName = (session && session.name) || '';

// ---------------------------------------------------------------- net
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => {
    // a stored session means we were in a room before a refresh/drop — rejoin it
    if (session) {
      const err = $('lobby-error'); if (err) err.textContent = 'Reconnecting to your game…';
      sendRaw('reconnect', { code: session.code, playerId: session.playerId, name: session.name });
    }
  };
  ws.onmessage = (e) => {
    const { type, data } = JSON.parse(e.data);
    if (type === 'joined') {
      you = data.playerId;
      session = { code: data.code, playerId: data.playerId, name: myName || (session && session.name) || 'Player' };
      saveSession(session);
    }
    else if (type === 'state') { room = data; onState(); }
    else if (type === 'reconnectFailed') {
      clearSession();
      const err = $('lobby-error'); if (err) err.textContent = '';
    }
    else if (type === 'error') { showError(data.msg); }
    else if (type === 'chat') { addChat(data.from, data.msg); }
    else if (type === 'sessionEnded') { clearSession(); location.reload(); }
  };
  ws.onclose = () => setTimeout(connect, 1500);
}
function sendRaw(type, data) { ws.send(JSON.stringify({ type, data })); }
function act(action, payload = {}) { sendRaw('action', { action, payload }); }
window.__act = act; // debug/testing hook

function showError(msg) {
  const el = $('lobby-error');
  if (!$('lobby').classList.contains('hidden')) { el.textContent = msg; setTimeout(() => el.textContent = '', 3000); }
  else toast('⚠ ' + msg, 'err');
}

function toast(msg, kind = 'info') {
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = msg;
  $('game').appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2600);
}

// ---------------------------------------------------------------- lobby
function setupLobby() {
  $('name-input').value = myName;
  $('btn-create').onclick = () => {
    myName = $('name-input').value.trim() || 'Host';
    sendRaw('create', { name: myName });
  };
  $('btn-join').onclick = () => {
    myName = $('name-input').value.trim() || 'Player';
    const code = $('code-input').value.trim().toUpperCase();
    if (!code) return showError('Enter a room code');
    sendRaw('join', { name: myName, code });
  };
  $('btn-start').onclick = () => sendRaw('start', { 
    winVP: parseInt($('winvp').value, 10),
    botDifficulty: parseInt($('bot-diff').value, 10)
  });
  $('btn-leave').onclick = () => { clearSession(); location.reload(); };
  $('btn-addbot').onclick = () => sendRaw('addBot', {});
  $('btn-rmbot').onclick = () => sendRaw('removeBot', {});
  $('btn-copy').onclick = () => {
    if (navigator.clipboard) {
      navigator.clipboard.writeText($('room-code').textContent);
      toast('Code copied!', 'good');
    } else {
      const el = document.createElement('textarea');
      el.value = $('room-code').textContent;
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
      toast('Code copied!', 'good');
    }
  };
  $('code-input').addEventListener('input', (e) => e.target.value = e.target.value.toUpperCase());
}

function renderLobby() {
  $('lobby').classList.remove('hidden');
  $('game').classList.add('hidden');
  if (!room) return;
  $('lobby-home').classList.add('hidden');
  $('lobby-room').classList.remove('hidden');
  $('room-code').textContent = room.code;
  const list = $('player-list'); list.innerHTML = '';
  for (const p of room.players) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="dot" style="background:${p.color};color:${p.color}"></span>
      <span>${esc(p.name)}</span>
      ${p.id === room.hostId ? '<span class="host-tag">HOST</span>' : ''}
      ${p.bot ? '<span class="host-tag" style="color:var(--accent)">BOT</span>' : ''}
      ${p.connected || p.bot ? '' : '<span class="host-tag" style="color:#e23d3d">offline</span>'}`;
    list.appendChild(li);
  }
  const isHost = you === room.hostId;
  const bots = room.players.filter(p => p.bot).length;
  $('btn-start').classList.toggle('hidden', !isHost);
  $('host-options').classList.toggle('hidden', !isHost);
  $('btn-addbot').disabled = room.players.length >= 10;
  $('btn-rmbot').disabled = bots === 0;
  $('btn-start').disabled = room.players.length < 2;
  $('start-hint').textContent = isHost
    ? (room.players.length < 2 ? 'Add a bot or wait for players (need 2+).' : `${room.players.length} players ready (${bots} bot${bots === 1 ? '' : 's'}).`)
    : 'Waiting for the host to start…';
}

// ---------------------------------------------------------------- state dispatch
function onState() {
  if (!room.started) { renderLobby(); return; }
  $('lobby').classList.add('hidden');
  $('game').classList.remove('hidden');
  if (!board) {
    board = new BoardView($('board'));
    board.onPick = onBoardPick;
    window.__bv = board; // debug/testing hook
  }
  const gs = room.game;
  board.setState(gs, you);
  detectAnimations(gs);
  renderGame(gs);
  updateInteractionMode(gs);
}

function me() { return room.game.players.find(p => p.id === you); }
function myIdx() { return me()?.idx; }
function isMyTurn() { return room.game.turn === myIdx(); }

// ---------------------------------------------------------------- animations
function detectAnimations(gs) {
  // dice
  if (gs.dice && (!prevDice || gs.dice.d1 !== prevDice.d1 || gs.dice.d2 !== prevDice.d2 || prevDice.sum !== gs.dice.sum)) {
    showDice(gs.dice);
    if (gs.dice.sum !== 7) spawnProductionFloaters(gs, gs.dice.sum);
  }
  if (!gs.dice) { $('dice').classList.add('hidden'); }
  prevDice = gs.dice ? { ...gs.dice } : null;
  prevPhase = gs.phase;

  // feedback when you successfully buy a development card
  const mine = gs.players.find(p => p.id === you);
  if (mine) {
    if (prevDevCount != null && mine.devCount > prevDevCount) toast('📜 Dev card bought — playable next turn', 'good');
    prevDevCount = mine.devCount;
  }
}

function showDice(d) {
  $('dice').classList.remove('hidden');
  const e1 = $('die1'), e2 = $('die2');
  e1.textContent = d.d1; e2.textContent = d.d2;
  e1.classList.remove('rolling'); e2.classList.remove('rolling');
  void e1.offsetWidth;
  e1.classList.add('rolling'); e2.classList.add('rolling');
}

function spawnProductionFloaters(gs, sum) {
  for (const h of gs.board.hexes) {
    if (h.token !== sum || h.id === gs.robberHex || h.type === 'desert') continue;
    const has = gs.board.vertices.some(v => v.hexes.includes(h.id) && gs.settlements[v.id]);
    if (has) board.addFloater(ICON[h.type] || '+', h.x, h.y, '#fff');
  }
}

// ---------------------------------------------------------------- game UI
function renderGame(gs) {
  const isHost = you === room.hostId;
  const adminPanel = $('admin-panel');
  if (isHost) {
    adminPanel.classList.remove('hidden');
    const canModifyBoard = gs.setupPos === 0 && gs.setupStep === 'settlement';
    $('btn-admin-size-down').classList.toggle('hidden', !canModifyBoard);
    $('btn-admin-size-up').classList.toggle('hidden', !canModifyBoard);
    $('btn-admin-randomize').classList.toggle('hidden', !canModifyBoard);
    
    if (canModifyBoard && gs.board) {
      $('btn-admin-size-down').disabled = (gs.board.radius <= 2);
      $('btn-admin-size-up').disabled = (gs.board.radius >= 5);
    }
    
    // Update the bot trades input to reflect current state without triggering onchange
    const limitInput = $('admin-bot-trades');
    if (limitInput && document.activeElement !== limitInput) {
      limitInput.value = gs.botTradeLimit ?? 1;
    }
  } else {
    adminPanel.classList.add('hidden');
  }

  // turn banner
  const cur = gs.players[gs.turn];
  let banner;
  if (gs.phase === 'game_over') banner = `🏆 <b>${esc(gs.players[gs.winner].name)}</b> wins!`;
  else if (gs.phase === 'setup') banner = `Setup — <b>${esc(gs.players[gs.setupActor].name)}</b> places a ${gs.setupStep}`;
  else banner = `<b>${esc(cur.name)}</b>'s turn`;
  $('turn-banner').innerHTML = banner;

  renderPlayers(gs);
  renderLog(gs);
  renderHand(gs);
  renderModals(gs);
}

function renderPlayers(gs) {
  const wrap = $('players'); wrap.innerHTML = '';
  for (const p of gs.players) {
    const div = document.createElement('div');
    div.className = 'pcard' + (gs.turn === p.idx ? ' active' : '') + (gs.winner != null && gs.winner !== p.idx ? ' dim' : '');
    div.style.borderColor = p.color;
    div.innerHTML = `
      <div class="pname">${gs.winner === p.idx ? '<span class="crown">👑</span>' : ''}${esc(p.name)}
        ${p.id === you ? '<span style="color:var(--muted);font-weight:400">(you)</span>' : ''}
        <span class="vp-pill">${p.vp} VP</span></div>
      <div class="pstats">
        <span>🃏 <b>${p.cardCount}</b></span>
        <span>📜 <b>${p.devCount}</b></span>
        <span>⚔️ <b>${p.knightsPlayed}</b></span>
        ${p.longestRoad ? '<span class="badge">Longest Rd</span>' : ''}
        ${p.largestArmy ? '<span class="badge">Largest Army</span>' : ''}
      </div>`;
    wrap.appendChild(div);
  }
}

function renderLog(gs) {
  const log = $('log');
  log.innerHTML = gs.log.map(l => `<div class="l">${esc(l.msg)}</div>`).join('');
  log.scrollTop = log.scrollHeight;
}

function renderHand(gs) {
  const m = me();
  const r = $('resources'); r.innerHTML = '';
  for (const res of RES) {
    const n = m.resources ? m.resources[res] : 0;
    const c = document.createElement('div');
    c.className = 'rescard ' + res;
    c.innerHTML = `<span class="cnt">${n}</span><span class="ico">${ICON[res]}</span><span class="lbl">${res}</span>`;
    r.appendChild(c);
  }
  renderActions(gs);
}

function canPay(cost) {
  const m = me(); if (!m.resources) return false;
  return Object.entries(cost).every(([k, v]) => m.resources[k] >= v);
}

function renderActions(gs) {
  const a = $('actions'); a.innerHTML = '';
  const mine = isMyTurn();
  const main = gs.phase === 'main' && mine;
  const roll = gs.phase === 'roll' && mine;

  // buttons stay clickable even when unaffordable (we add a 'dim' class instead of
  // disabling) so the server's reason — e.g. "need sheep+wheat+ore" — is surfaced
  // as a toast rather than the button silently doing nothing.
  const btn = (label, cls, on, cost) => {
    const b = document.createElement('button');
    b.className = 'btn ' + cls;
    b.innerHTML = label + (cost ? `<span class="cost">${costStr(cost)}</span>` : '');
    b.onclick = on;
    a.appendChild(b);
    return b;
  };
  const dim = (afford) => afford ? '' : 'dim';

  if (roll) {
    btn('🎲 Roll Dice', 'primary', () => act('rollDice'));
    return;
  }
  if (main) {
    const roadAfford = canPay(COSTS.road) || gs.freeRoads > 0;
    btn('🛣️ Road', (buildMode === 'road' ? 'good ' : '') + dim(roadAfford), () => toggleBuild('road'), COSTS.road);
    btn('🏠 Settlement', (buildMode === 'settlement' ? 'good ' : '') + dim(canPay(COSTS.settlement)), () => toggleBuild('settlement'), COSTS.settlement);
    btn('🏛️ City', (buildMode === 'city' ? 'good ' : '') + dim(canPay(COSTS.city)), () => toggleBuild('city'), COSTS.city);
    btn('📜 Dev Card', dim(canPay(COSTS.dev)), () => act('buyDev'), COSTS.dev);
    if (myDev().length) btn('🎴 Play Card', dim(!gs.devPlayedThisTurn), () => gs.devPlayedThisTurn ? toast('One dev card per turn') : openDevModal(gs));
    btn('🔄 Trade', '', () => openTradeModal(gs));
    btn('✔️ End Turn', 'bad', () => { buildMode = null; act('endTurn'); });
    return;
  }
  // non-active or non-main: contextual hints handled by hint bar
}

function myDev() {
  const m = me();
  if (!m.dev) return [];
  return Object.entries(m.dev).filter(([k, v]) => k !== 'vp' && v > 0);
}

function costStr(cost) { return Object.entries(cost).map(([k, v]) => `${v}${ICON[k]}`).join(' '); }

// ---------------------------------------------------------------- interaction modes
function toggleBuild(mode) {
  buildMode = buildMode === mode ? null : mode;
  updateInteractionMode(room.game);
  renderActions(room.game);
}

function updateInteractionMode(gs) {
  const mine = isMyTurn();
  // forced phases first
  if (gs.phase === 'setup' && gs.setupActor === myIdx()) {
    if (gs.setupStep === 'settlement') {
      board.setMode('vertex', new Set(legalSetupSettlements(gs)));
      flashHint('Place your settlement', true);
    } else {
      board.setMode('edge', new Set(legalSetupRoads(gs)));
      flashHint('Place a road touching your settlement', true);
    }
    return;
  }
  if (gs.phase === 'discard') {
    board.setMode('none', null);
    if (gs.discardQueue[myIdx()] != null) flashHint(`Discard ${gs.discardQueue[myIdx()]} cards`, true);
    else flashHint('Waiting for others to discard…');
    return;
  }
  if (gs.phase === 'move_robber') {
    if (gs.pendingRobberFrom === myIdx()) {
      const legal = gs.board.hexes.filter(h => h.id !== gs.robberHex).map(h => h.id);
      board.setMode('robber', new Set(legal));
      flashHint('Move the robber onto a hex', true);
    } else { board.setMode('none', null); flashHint('Robber is on the move…'); }
    return;
  }
  if (gs.phase === 'main' && mine && gs.freeRoads > 0) {
    board.setMode('edge', new Set(legalRoads(gs)));
    flashHint(`Road Building: place ${gs.freeRoads} free road(s)`, true);
    return;
  }
  if (gs.phase === 'roll' && mine) { board.setMode('none', null); flashHint('Roll the dice to start your turn', true); return; }

  if (gs.phase === 'main' && mine && buildMode) {
    if (buildMode === 'road') board.setMode('edge', new Set(legalRoads(gs)));
    else if (buildMode === 'settlement') board.setMode('vertex', new Set(legalSettlements(gs)));
    else if (buildMode === 'city') board.setMode('city', new Set(legalCities(gs)));
    flashHint(`Click where to build your ${buildMode}`);
    return;
  }

  board.setMode('none', null);
  if (gs.phase === 'game_over') flashHint('Game over');
  else if (!mine) flashHint(`Waiting for ${esc(gs.players[gs.turn].name)}…`);
  else hideHint();
}

function onBoardPick(kind, id) {
  const gs = room.game;
  if (gs.phase === 'setup') {
    if (kind === 'vertex') act('placeSetupSettlement', { vertexId: id });
    else if (kind === 'edge') act('placeSetupRoad', { edgeId: id });
    return;
  }
  if (gs.phase === 'move_robber') {
    if (kind === 'hex') return robberPickHex(gs, id);
  }
  if (gs.phase === 'main') {
    if (gs.freeRoads > 0 && kind === 'edge') { act('buildRoad', { edgeId: id }); return; }
    if (buildMode === 'road' && kind === 'edge') { act('buildRoad', { edgeId: id }); }
    else if (buildMode === 'settlement' && kind === 'vertex') { act('buildSettlement', { vertexId: id }); buildMode = null; }
    else if (buildMode === 'city' && kind === 'vertex') { act('buildCity', { vertexId: id }); buildMode = null; }
  }
}

function robberPickHex(gs, hexId) {
  const victims = [];
  for (const v of gs.board.vertices) {
    if (!v.hexes.includes(hexId)) continue;
    const s = gs.settlements[v.id];
    if (s && s.player !== myIdx() && gs.players[s.player].cardCount > 0 && !victims.includes(s.player)) victims.push(s.player);
  }
  if (victims.length <= 1) act('moveRobber', { hexId, targetId: victims[0] != null ? gs.players[victims[0]].id : null });
  else openVictimModal(gs, hexId, victims);
}

// ---------------------------------------------------------------- legality (mirror server)
function vertexOpen(gs, vid) {
  if (gs.settlements[vid]) return false;
  return !gs.board.vertices[vid].verts.some(n => gs.settlements[n]);
}
function vertexConnected(gs, vid, idx) {
  return gs.board.vertices[vid].edges.some(e => gs.roads[e] === idx);
}
function edgeConnected(gs, eid, idx) {
  const e = gs.board.edges[eid];
  for (const vid of [e.v1, e.v2]) {
    const v = gs.board.vertices[vid];
    const s = gs.settlements[vid];
    if (s && s.player === idx) return true;
    if (v.edges.some(x => x !== eid && gs.roads[x] === idx) && (!s || s.player === idx)) return true;
  }
  return false;
}
function legalSetupSettlements(gs) { return gs.board.vertices.filter(v => vertexOpen(gs, v.id)).map(v => v.id); }
function legalSetupRoads(gs) {
  const last = gs.lastSettlementVertex;
  if (last == null) return [];
  return gs.board.vertices[last].edges.filter(e => gs.roads[e] == null);
}
function legalRoads(gs) {
  const idx = myIdx();
  return gs.board.edges.filter(e => gs.roads[e.id] == null && edgeConnected(gs, e.id, idx)).map(e => e.id);
}
function legalSettlements(gs) {
  const idx = myIdx();
  return gs.board.vertices.filter(v => vertexOpen(gs, v.id) && vertexConnected(gs, v.id, idx)).map(v => v.id);
}
function legalCities(gs) {
  const idx = myIdx();
  return Object.keys(gs.settlements).filter(vid => gs.settlements[vid].player === idx && gs.settlements[vid].type === 'settlement').map(Number);
}

// ---------------------------------------------------------------- hint bar
let hintTimer;
function flashHint(msg, attn = false) {
  const h = $('hint-bar');
  h.innerHTML = msg; h.style.opacity = '1';
  h.classList.toggle('attn', attn);
}
function hideHint() { $('hint-bar').style.opacity = '0'; }

// ---------------------------------------------------------------- modals
function renderModals(gs) {
  // discard is the only auto-popping modal
  const root = $('modal-root');
  const hasDiscard = gs.phase === 'discard' && gs.discardQueue[myIdx()] != null;
  if (hasDiscard && !root.querySelector('.discard-modal')) openDiscardModal(gs);
  if (!hasDiscard) { const d = root.querySelector('.discard-modal'); if (d) d.closest('.modal-bg').remove(); }
  // pending trade response panel
  renderTradeResponse(gs);
  if (gs.phase === 'game_over' && !root.querySelector('.win-screen')) openWinModal(gs);
}

function modal(html, cls = '') {
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal glass ${cls}">${html}</div>`;
  $('modal-root').appendChild(bg);
  return bg;
}
function closeModal(el) { el.closest('.modal-bg')?.remove(); }

function stepperCard(res, attr, prefix, initial = 0) {
  return `
    <div class="res-pick">
      <span class="ico">${ICON[res]}</span>
      <div class="stepper">
        <button data-${attr}="${res}" data-d="-1">−</button>
        <span class="v" id="${prefix}-${res}">${initial}</span>
        <button data-${attr}="${res}" data-d="1">+</button>
      </div>
    </div>`;
}
function resStepper(initial = {}) {
  return RES.map(res => stepperCard(res, 'res', 'step', initial[res] || 0)).join('');
}
function wantStepper() {
  return RES.map(res => stepperCard(res, 'w', 'want', 0)).join('');
}
function wireSteppers(bg, max = null, getCap = null) {
  const vals = {}; RES.forEach(r => vals[r] = 0);
  // only the resource steppers (the want-picker buttons use data-w and wire themselves)
  bg.querySelectorAll('.stepper button[data-res]').forEach(b => {
    b.onclick = () => {
      const res = b.dataset.res, d = +b.dataset.d;
      let nv = vals[res] + d;
      if (nv < 0) nv = 0;
      const cap = getCap ? getCap(res) : Infinity;
      if (nv > cap) nv = cap;
      if (max != null && d > 0 && Object.values(vals).reduce((a, c) => a + c, 0) >= max) return;
      vals[res] = nv; bg.querySelector('#step-' + res).textContent = nv;
    };
  });
  return vals;
}

function openDiscardModal(gs) {
  const need = gs.discardQueue[myIdx()];
  const m = me();
  const bg = modal(`
    <div class="discard-modal">
      <h2>Discard ${need} cards</h2>
      <p class="sub">You have too many cards. Choose ${need} to discard.</p>
      <div class="res-picker">${resStepper()}</div>
      <div class="modal-actions"><button class="btn primary" id="confirm-discard">Discard</button></div>
    </div>`);
  const vals = wireSteppers(bg, need, (res) => m.resources[res]);
  bg.querySelector('#confirm-discard').onclick = () => {
    const total = Object.values(vals).reduce((a, c) => a + c, 0);
    if (total !== need) return flashHint(`Select exactly ${need}`, true);
    act('discard', { resources: vals });
    closeModal(bg);
  };
}

function openDevModal(gs) {
  const cards = myDev();
  const labels = { knight: '⚔️ Knight — move robber & steal', road_building: '🛣️ Road Building — 2 free roads', year_of_plenty: '🎁 Year of Plenty — take any 2', monopoly: '💰 Monopoly — name a resource' };
  const bg = modal(`
    <h2>Play a development card</h2>
    <p class="sub">One per turn. Cards bought this turn are locked until next turn.</p>
    <div style="display:flex;flex-direction:column;gap:8px">
      ${cards.map(([k, v]) => `<button class="btn" data-card="${k}">${labels[k]} <b>×${v}</b></button>`).join('')}
    </div>
    <div class="modal-actions"><button class="btn ghost" id="dev-cancel">Cancel</button></div>`);
  bg.querySelector('#dev-cancel').onclick = () => closeModal(bg);
  bg.querySelectorAll('[data-card]').forEach(b => {
    b.onclick = () => {
      const card = b.dataset.card;
      closeModal(bg);
      if (card === 'knight') act('playDev', { type: 'knight' });
      else if (card === 'road_building') act('playDev', { type: 'road_building' });
      else if (card === 'year_of_plenty') openPlentyModal();
      else if (card === 'monopoly') openMonopolyModal();
    };
  });
}

function openPlentyModal() {
  const bg = modal(`
    <h2>Year of Plenty</h2><p class="sub">Take any 2 resources from the bank.</p>
    <div class="res-picker">${resStepper()}</div>
    <div class="modal-actions"><button class="btn primary" id="ok">Take</button>
      <button class="btn ghost" id="cancel">Cancel</button></div>`);
  const vals = wireSteppers(bg, 2);
  bg.querySelector('#cancel').onclick = () => closeModal(bg);
  bg.querySelector('#ok').onclick = () => {
    const picks = []; for (const r of RES) for (let i = 0; i < vals[r]; i++) picks.push(r);
    if (picks.length !== 2) return flashHint('Pick exactly 2', true);
    act('playDev', { type: 'year_of_plenty', resources: picks });
    closeModal(bg);
  };
}

function openMonopolyModal() {
  const bg = modal(`
    <h2>Monopoly</h2><p class="sub">Pick a resource — every other player gives you all of theirs.</p>
    <div class="res-picker">
      ${RES.map(r => `<button class="res-pick" data-res="${r}"><span class="ico">${ICON[r]}</span>${r}</button>`).join('')}
    </div>
    <div class="modal-actions"><button class="btn ghost" id="cancel">Cancel</button></div>`);
  bg.querySelector('#cancel').onclick = () => closeModal(bg);
  bg.querySelectorAll('[data-res]').forEach(b => b.onclick = () => {
    act('playDev', { type: 'monopoly', resource: b.dataset.res });
    closeModal(bg);
  });
}

function openVictimModal(gs, hexId, victims) {
  const bg = modal(`
    <h2>Steal from…</h2><p class="sub">Choose a player to rob.</p>
    <div style="display:flex;flex-direction:column;gap:8px">
      ${victims.map(idx => {
        const p = gs.players[idx];
        return `<button class="btn" data-idx="${idx}" style="border-left:4px solid ${p.color}">${esc(p.name)} — 🃏 ${p.cardCount}</button>`;
      }).join('')}
    </div>`);
  bg.querySelectorAll('[data-idx]').forEach(b => b.onclick = () => {
    act('moveRobber', { hexId, targetId: gs.players[+b.dataset.idx].id });
    closeModal(bg);
  });
}

function openTradeModal(gs) {
  const m = me();
  const bg = modal(`
    <h2>Trade</h2>
    <p class="sub">Swap with the bank/port, or offer a deal to another player.</p>

    <div class="trade-section">
      <div class="trade-head">🏦 Bank / Port</div>
      <div class="bank-row">
        <span class="bl">Give</span>
        <select id="t-give">${RES.map(r => `<option value="${r}">${r} · ${rate(m, r)}:1</option>`).join('')}</select>
        <span class="arrow">➜</span>
        <span class="bl">Get</span>
        <select id="t-get">${RES.map(r => `<option value="${r}">${r}</option>`).join('')}</select>
        <button class="btn good" id="bank-go">Trade</button>
      </div>
    </div>

    <hr class="trade-divider">

    <div class="trade-section">
      <div class="trade-head">🤝 Offer to players</div>
      <div class="gw-label">You give</div>
      <div class="res-picker">${resStepper()}</div>
      <div class="gw-arrow">⇅</div>
      <div class="gw-label">You want in return</div>
      <div class="res-picker">${wantStepper()}</div>
    </div>

    <div class="modal-actions">
      <button class="btn ghost" id="trade-close">Close</button>
      <button class="btn primary" id="offer-go">Send Offer</button>
    </div>`, 'wide');

  bg.querySelector('#bank-go').onclick = () => {
    act('bankTrade', { give: bg.querySelector('#t-give').value, get: bg.querySelector('#t-get').value });
  };
  const give = wireSteppers(bg, null, (res) => m.resources[res]);
  const want = {}; RES.forEach(r => want[r] = 0);
  bg.querySelectorAll('[data-w]').forEach(b => b.onclick = () => {
    const r = b.dataset.w; want[r] = Math.max(0, want[r] + (+b.dataset.d));
    bg.querySelector('#want-' + r).textContent = want[r];
  });
  bg.querySelector('#offer-go').onclick = () => {
    if (Object.values(give).every(v => !v) && Object.values(want).every(v => !v)) return toast('Set what to give or want first');
    act('proposeTrade', { give, get: want });
    closeModal(bg);
  };
  bg.querySelector('#trade-close').onclick = () => closeModal(bg);
}
function rate(m, res) { if (m.ports?.includes(res)) return 2; if (m.ports?.includes('3:1')) return 3; return 4; }

function renderTradeResponse(gs) {
  const root = $('modal-root');
  const existing = root.querySelector('.trade-panel');
  if (!gs.trade) { if (existing) existing.closest('.modal-bg').remove(); return; }
  const t = gs.trade;
  const proposer = gs.players[t.from];
  const isProposer = t.from === myIdx();
  // signature decides when to rebuild — so the proposer's panel refreshes as
  // accepts come in, and the responder's panel closes once they've answered.
  const sig = isProposer
    ? 'P|' + t.accepted.join(',')
    : 'R|' + (t.accepted.includes(myIdx()) || t.rejected.includes(myIdx()) ? 'done' : 'pending');
  if (existing && existing.dataset.sig === sig) return;
  if (existing) existing.closest('.modal-bg').remove();

  if (isProposer) {
    const accepters = t.accepted.map(i => gs.players[i]);
    const bg = modal(`<div class="trade-panel" data-sig="${sig}">
      <h2>Your trade offer</h2>
      <p class="sub">You give ${tradeStr(t.give)} ➜ You want ${tradeStr(t.get)}</p>
      <div style="display:flex;flex-direction:column;gap:8px">
        ${accepters.length
          ? `<p class="sub">Tap a player to complete the trade:</p>` + accepters.map(p => `<button class="btn good" data-acc="${p.idx}" style="border-left:4px solid ${p.color}">Trade with ${esc(p.name)}</button>`).join('')
          : '<p class="sub">Waiting for someone to accept…</p>'}
      </div>
      <div class="modal-actions"><button class="btn bad" id="trade-cancel">Cancel offer</button></div></div>`);
    bg.querySelector('#trade-cancel').onclick = () => act('cancelTrade');
    bg.querySelectorAll('[data-acc]').forEach(b => b.onclick = () => act('finalizeTrade', { withIdx: +b.dataset.acc }));
    return;
  }

  // responder: only show while they still owe an answer
  const done = t.accepted.includes(myIdx()) || t.rejected.includes(myIdx());
  if (done) return;
  const bg = modal(`<div class="trade-panel" data-sig="${sig}">
    <h2>${esc(proposer.name)} offers a trade</h2>
    <p class="sub">They give you ${tradeStr(t.give)} — they want ${tradeStr(t.get)} from you</p>
    <div class="modal-actions">
      <button class="btn good" id="t-acc">Accept</button>
      <button class="btn ghost" id="t-rej">Decline</button></div></div>`);
  bg.querySelector('#t-acc').onclick = () => act('respondTrade', { accept: true });
  bg.querySelector('#t-rej').onclick = () => act('respondTrade', { accept: false });
}
function tradeStr(o) { const s = Object.entries(o).filter(([, v]) => v > 0).map(([k, v]) => `${v}${ICON[k]}`).join(' '); return s || 'nothing'; }

function openWinModal(gs) {
  const w = gs.players[gs.winner];
  const bg = modal(`<div class="win-screen">
    <div class="trophy">🏆</div>
    <h2>${esc(w.name)} wins!</h2>
    <p class="sub">${w.vp} victory points on the island of Hexagon.</p>
    <div class="modal-actions" style="justify-content:center">
      <button class="btn primary" onclick="localStorage.removeItem('hexagon.session');location.reload()">New Game</button>
    </div></div>`, 'win-screen');
}

// ---------------------------------------------------------------- chat
function addChat(from, msg) {
  const log = $('log');
  const d = document.createElement('div');
  d.className = 'l'; d.innerHTML = `<b>${esc(from)}:</b> ${esc(msg)}`;
  log.appendChild(d); log.scrollTop = log.scrollHeight;
}
function setupChat() {
  $('chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.value.trim()) { sendRaw('chat', { msg: e.target.value.trim() }); e.target.value = ''; }
  });
  $('btn-help').onclick = () => openHelp();
}
function setupAdminPanel() {
  $('btn-admin-size-down').onclick = () => sendRaw('adminAction', { action: 'resizeBoard', delta: -1 });
  $('btn-admin-size-up').onclick = () => sendRaw('adminAction', { action: 'resizeBoard', delta: 1 });
  $('btn-admin-randomize').onclick = () => sendRaw('adminAction', { action: 'randomizeBoard' });
  $('btn-admin-restart').onclick = () => confirmRestart();
  $('btn-admin-end').onclick = () => confirmEndSession();
  
  $('admin-bot-trades').onchange = (e) => {
    sendRaw('adminAction', { action: 'setBotTradeLimit', limit: parseInt(e.target.value, 10) });
  };
}
function confirmRestart() {
  const bg = modal(`<h2>Restart Game?</h2><p class="sub">This will restart the session with a new map.</p><div class="modal-actions"><button class="btn bad" id="btn-conf-res">Restart</button><button class="btn ghost" id="btn-cancel-res">Cancel</button></div>`);
  bg.querySelector('#btn-conf-res').onclick = () => { sendRaw('adminAction', { action: 'restartGame' }); closeModal(bg); };
  bg.querySelector('#btn-cancel-res').onclick = () => closeModal(bg);
}
function confirmEndSession() {
  const bg = modal(`<h2>End Game?</h2><p class="sub">This will close the room for everyone.</p><div class="modal-actions"><button class="btn bad" id="btn-conf-end">End Game</button><button class="btn ghost" id="btn-cancel-end">Cancel</button></div>`);
  bg.querySelector('#btn-conf-end').onclick = () => { sendRaw('adminAction', { action: 'endSession' }); closeModal(bg); };
  bg.querySelector('#btn-cancel-end').onclick = () => closeModal(bg);
}
function openHelp() {
  modal(`<h2>How to play Hexagon</h2>
    <p class="sub">A Catan-like game. First to the target VP wins.</p>
    <ul style="font-size:13px;line-height:1.7;padding-left:18px">
      <li><b>Setup:</b> each player places 2 settlements + 2 roads (snake order).</li>
      <li><b>Your turn:</b> roll dice → everyone with a building on a matching hex collects that resource (city = 2).</li>
      <li><b>Build:</b> Road = 🌲🧱 · Settlement = 🌲🧱🐑🌾 · City = 2🌾3⛰️ · Dev card = 🐑🌾⛰️.</li>
      <li><b>Roll 7:</b> anyone with 8+ cards discards half, then the roller moves the robber and steals.</li>
      <li><b>Points:</b> settlement 1, city 2, Longest Road +2 (5+), Largest Army +2 (3 knights), VP cards +1.</li>
      <li><b>Controls:</b> scroll = zoom · drag = pan · click highlighted spots to build.</li>
    </ul>
    <div class="modal-actions"><button class="btn primary" onclick="this.closest('.modal-bg').remove()">Got it</button></div>`);
}

function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// ---------------------------------------------------------------- boot
startBackground($('bg-canvas'));
setupLobby();
setupChat();
setupAdminPanel();
connect();
