// Canvas board renderer + hit testing + animations.
const RES_COLORS = {
  wood: ['#3f9b46', '#256d2b'], brick: ['#d4793f', '#a64e22'],
  sheep: ['#a9e06a', '#6fb13a'], wheat: ['#f0d152', '#cba62f'],
  ore: ['#9fb0c4', '#6b7a90'], desert: ['#e3d3a3', '#c9b375'],
};
const RES_ICON = { wood: '🌲', brick: '🧱', sheep: '🐑', wheat: '🌾', ore: '⛰️', desert: '🏜️' };

export class BoardView {
  constructor(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.gs = null;
    this.you = null;
    this.mode = 'none';
    this.legal = new Set();
    this.onPick = () => {};
    this.hover = null;        // {kind,id}
    this.mouse = { x: 0, y: 0 };
    this.scale = 1; this.ox = 0; this.oy = 0;
    this.pieceTimes = new Map();   // key -> firstSeen ms
    this.robberPos = null;         // {x,y} screen-tweened (world coords)
    this.robberTarget = null;
    this.floaters = [];            // {text,x,y,born,color}
    this.pan = { x: 0, y: 0 };
    this.userZoom = 1;
    this._bind();
    this._loop();
  }

  _bind() {
    const c = this.cv;
    const pos = (e) => {
      const r = c.getBoundingClientRect();
      const t = e.touches ? e.touches[0] : e;
      return { x: t.clientX - r.left, y: t.clientY - r.top };
    };

    let dragging = false, last = null, didDrag = false;

    c.addEventListener('mousedown', (e) => {
      dragging = true;
      didDrag = false;
      last = pos(e);
    });

    addEventListener('mouseup', () => {
      dragging = false;
    });

    c.addEventListener('mousemove', (e) => {
      this.mouse = pos(e);
      this._updateHover();
      if (!dragging) return;
      const dx = this.mouse.x - last.x, dy = this.mouse.y - last.y;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) didDrag = true;
      this.pan.x += dx; this.pan.y += dy; last = this.mouse;
    });

    c.addEventListener('mouseleave', () => { this.hover = null; });

    const click = (e) => {
      if (didDrag) return;
      this.mouse = pos(e);
      this._updateHover();
      if (this.hover && this.legal.has(this.hover.id)) this.onPick(this.hover.kind, this.hover.id);
      else if (this.mode === 'robber') {
        const h = this._nearestHex(this.mouse);
        if (h != null && this.legal.has(h)) this.onPick('hex', h);
      }
    };

    c.addEventListener('click', click);

    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const f = e.deltaY < 0 ? 1.1 : 0.9;
      this.userZoom = Math.min(2.5, Math.max(0.6, this.userZoom * f));
    }, { passive: false });

    c.addEventListener('contextmenu', (e) => e.preventDefault());

    addEventListener('resize', () => this._resize());
    this._resize();
  }

  _resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.cv.width = Math.floor(this.cv.clientWidth * dpr);
    this.cv.height = Math.floor(this.cv.clientHeight * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._fit();
  }

  setState(gs, you) {
    const first = !this.gs;
    this.gs = gs; this.you = you;
    if (gs && gs.board) {
      // track piece appearance times for pop animation
      const now = performance.now();
      for (const vid in gs.settlements) {
        const k = 's' + vid + gs.settlements[vid].type;
        if (!this.pieceTimes.has(k)) this.pieceTimes.set(k, now);
      }
      for (const eid in gs.roads) {
        const k = 'r' + eid;
        if (!this.pieceTimes.has(k)) this.pieceTimes.set(k, now);
      }
      // robber tween
      const rh = gs.board.hexes[gs.robberHex];
      if (rh) {
        this.robberTarget = { x: rh.x, y: rh.y };
        if (!this.robberPos) this.robberPos = { ...this.robberTarget };
      }
      if (first) this._fit();
    }
  }

  setMode(mode, legal) { this.mode = mode; this.legal = legal || new Set(); }

  addFloater(text, worldX, worldY, color = '#fff') {
    this.floaters.push({ text, x: worldX, y: worldY, born: performance.now(), color });
  }

  _fit() {
    if (!this.gs || !this.gs.board) return;
    const b = this.gs.board.bounds;
    const w = this.cv.clientWidth, h = this.cv.clientHeight;
    const pad = 1.2; // world units of margin
    const bw = (b.maxX - b.minX) + pad * 2, bh = (b.maxY - b.minY) + pad * 2;
    const s = Math.min(w / bw, h / bh) * 0.92;
    this.baseScale = s;
    this.cx = (b.minX + b.maxX) / 2;
    this.cy = (b.minY + b.maxY) / 2;
  }

  _w2s(x, y) {
    const s = this.baseScale * this.userZoom;
    return {
      x: (x - this.cx) * s + this.cv.clientWidth / 2 + this.pan.x,
      y: (y - this.cy) * s + this.cv.clientHeight / 2 + this.pan.y,
    };
  }

  _nearestVertex(m) {
    let best = null, bd = 1e9;
    const thr = this.baseScale * this.userZoom * 0.45;
    for (const v of this.gs.board.vertices) {
      const p = this._w2s(v.x, v.y);
      const d = Math.hypot(p.x - m.x, p.y - m.y);
      if (d < bd) { bd = d; best = v.id; }
    }
    return bd < thr ? best : null;
  }
  _nearestEdge(m) {
    let best = null, bd = 1e9;
    const thr = this.baseScale * this.userZoom * 0.3;
    for (const e of this.gs.board.edges) {
      const v1 = this.gs.board.vertices[e.v1], v2 = this.gs.board.vertices[e.v2];
      const a = this._w2s(v1.x, v1.y), b = this._w2s(v2.x, v2.y);
      const d = ptSeg(m.x, m.y, a.x, a.y, b.x, b.y);
      if (d < bd) { bd = d; best = e.id; }
    }
    return bd < thr ? best : null;
  }
  _nearestHex(m) {
    let best = null, bd = 1e9;
    for (const h of this.gs.board.hexes) {
      const p = this._w2s(h.x, h.y);
      const d = Math.hypot(p.x - m.x, p.y - m.y);
      if (d < bd) { bd = d; best = h.id; }
    }
    return bd < this.baseScale * this.userZoom * 0.9 ? best : null;
  }

  _updateHover() {
    if (!this.gs) { this.hover = null; return; }
    if (this.mode === 'vertex' || this.mode === 'city') {
      const v = this._nearestVertex(this.mouse);
      this.hover = v != null ? { kind: 'vertex', id: v } : null;
    } else if (this.mode === 'edge') {
      const e = this._nearestEdge(this.mouse);
      this.hover = e != null ? { kind: 'edge', id: e } : null;
    } else if (this.mode === 'robber') {
      const h = this._nearestHex(this.mouse);
      this.hover = h != null ? { kind: 'hex', id: h } : null;
    } else this.hover = null;
  }

  _loop() {
    requestAnimationFrame(() => this._loop());
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.cv.clientWidth, this.cv.clientHeight);
    if (!this.gs || !this.gs.board) return;
    const now = performance.now();

    // robber tween
    if (this.robberPos && this.robberTarget) {
      this.robberPos.x += (this.robberTarget.x - this.robberPos.x) * 0.18;
      this.robberPos.y += (this.robberTarget.y - this.robberPos.y) * 0.18;
    }

    this._drawHexes(ctx, now);
    this._drawPorts(ctx);
    this._drawRoads(ctx, now);
    this._drawBuildings(ctx, now);
    this._drawRobber(ctx);
    this._drawLegal(ctx, now);
    this._drawFloaters(ctx, now);
  }

  _hexPath(ctx, cx, cy, R) {
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 180) * (60 * i - 30);
      const x = cx + R * Math.cos(a), y = cy + R * Math.sin(a);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.closePath();
  }

  _drawHexes(ctx, now) {
    const s = this.baseScale * this.userZoom;
    const R = s * 0.97; // tiny gap between hexes
    for (const h of this.gs.board.hexes) {
      const p = this._w2s(h.x, h.y);
      const [c1, c2] = RES_COLORS[h.type] || RES_COLORS.desert;
      const g = ctx.createLinearGradient(p.x, p.y - R, p.x, p.y + R);
      g.addColorStop(0, c1); g.addColorStop(1, c2);
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,.5)'; ctx.shadowBlur = s * 0.18; ctx.shadowOffsetY = s * 0.08;
      this._hexPath(ctx, p.x, p.y, R);
      ctx.fillStyle = g; ctx.fill();
      ctx.restore();
      // inner rim
      this._hexPath(ctx, p.x, p.y, R);
      ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.lineWidth = 2; ctx.stroke();

      // resource icon faint
      ctx.globalAlpha = 0.22; ctx.font = `${R * 0.7}px serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(RES_ICON[h.type] || '', p.x, p.y - R * 0.1);
      ctx.globalAlpha = 1;

      if (h.token != null) this._drawToken(ctx, p.x, p.y, R, h.token);
    }
  }

  _drawToken(ctx, x, y, R, n) {
    const rad = R * 0.32;
    ctx.beginPath(); ctx.arc(x, y, rad, 0, 7);
    ctx.fillStyle = '#f3ecd6'; ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,.25)'; ctx.lineWidth = 1.5; ctx.stroke();
    const hot = (n === 6 || n === 8);
    ctx.fillStyle = hot ? '#c0392b' : '#2a2a2a';
    ctx.font = `bold ${rad * 1.0}px Georgia`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(n, x, y - rad * 0.16);
    // probability pips
    const pips = 6 - Math.abs(7 - n);
    const pw = rad * 0.12;
    const total = pips * (pw * 2.4);
    for (let i = 0; i < pips; i++) {
      ctx.beginPath();
      ctx.arc(x - total / 2 + pw + i * pw * 2.4, y + rad * 0.55, pw, 0, 7);
      ctx.fillStyle = hot ? '#c0392b' : '#2a2a2a'; ctx.fill();
    }
  }

  _drawPorts(ctx) {
    const s = this.baseScale * this.userZoom;
    for (const port of this.gs.board.ports) {
      const p = this._w2s(port.x, port.y);
      ctx.beginPath(); ctx.arc(p.x, p.y, s * 0.22, 0, 7);
      ctx.fillStyle = 'rgba(10,24,40,.85)'; ctx.fill();
      ctx.strokeStyle = '#cfe6ff'; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.fillStyle = '#cfe6ff'; ctx.font = `bold ${s * 0.16}px sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const label = port.type === '3:1' ? '3:1' : (RES_ICON[port.type] || '?') + '2';
      ctx.fillText(label, p.x, p.y);
    }
  }

  _drawRoads(ctx, now) {
    const s = this.baseScale * this.userZoom;
    for (const eid in this.gs.roads) {
      const e = this.gs.board.edges[eid];
      const v1 = this.gs.board.vertices[e.v1], v2 = this.gs.board.vertices[e.v2];
      const a = this._w2s(v1.x, v1.y), b = this._w2s(v2.x, v2.y);
      const color = this.gs.players[this.gs.roads[eid]].color;
      const t = this._pop('r' + eid, now);
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      ctx.save();
      ctx.translate(mx, my); ctx.scale(t, t); ctx.translate(-mx, -my);
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(0,0,0,.45)'; ctx.lineWidth = s * 0.20;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.strokeStyle = color; ctx.lineWidth = s * 0.14;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.restore();
    }
  }

  _drawBuildings(ctx, now) {
    const s = this.baseScale * this.userZoom;
    for (const vid in this.gs.settlements) {
      const st = this.gs.settlements[vid];
      const v = this.gs.board.vertices[vid];
      const p = this._w2s(v.x, v.y);
      const color = this.gs.players[st.player].color;
      const t = this._pop('s' + vid + st.type, now);
      const size = s * (st.type === 'city' ? 0.34 : 0.26) * t;
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,.5)'; ctx.shadowBlur = 6; ctx.shadowOffsetY = 2;
      if (st.type === 'city') this._drawCity(ctx, p.x, p.y, size, color);
      else this._drawHouse(ctx, p.x, p.y, size, color);
      ctx.restore();
    }
  }

  _drawHouse(ctx, x, y, r, color) {
    ctx.fillStyle = color; ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x - r, y + r); ctx.lineTo(x - r, y - r * 0.2);
    ctx.lineTo(x, y - r); ctx.lineTo(x + r, y - r * 0.2);
    ctx.lineTo(x + r, y + r); ctx.closePath();
    ctx.fill(); ctx.stroke();
  }
  _drawCity(ctx, x, y, r, color) {
    ctx.fillStyle = color; ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x - r, y + r); ctx.lineTo(x - r, y - r * 0.1);
    ctx.lineTo(x - r * 0.3, y - r * 0.1); ctx.lineTo(x - r * 0.3, y - r * 0.7);
    ctx.lineTo(x + r * 0.4, y - r * 1.0); ctx.lineTo(x + r, y - r * 0.7);
    ctx.lineTo(x + r, y + r); ctx.closePath();
    ctx.fill(); ctx.stroke();
  }

  _drawRobber(ctx) {
    if (!this.robberPos) return;
    const p = this._w2s(this.robberPos.x, this.robberPos.y);
    const s = this.baseScale * this.userZoom;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = 8;
    ctx.fillStyle = '#1a1a1a';
    ctx.beginPath();
    ctx.ellipse(p.x, p.y + s * 0.05, s * 0.16, s * 0.26, 0, 0, 7);
    ctx.fill();
    ctx.beginPath(); ctx.arc(p.x, p.y - s * 0.22, s * 0.12, 0, 7); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.3)'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.restore();
  }

  _drawLegal(ctx, now) {
    if (this.mode === 'none' || !this.legal.size) return;
    const s = this.baseScale * this.userZoom;
    const pulse = 0.5 + 0.5 * Math.sin(now / 250);
    if (this.mode === 'vertex' || this.mode === 'city') {
      for (const id of this.legal) {
        const v = this.gs.board.vertices[id];
        const p = this._w2s(v.x, v.y);
        const hov = this.hover && this.hover.kind === 'vertex' && this.hover.id === id;
        ctx.beginPath(); ctx.arc(p.x, p.y, s * (hov ? 0.26 : 0.18), 0, 7);
        ctx.fillStyle = `rgba(240,200,64,${hov ? 0.9 : 0.35 + pulse * 0.3})`; ctx.fill();
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
      }
    } else if (this.mode === 'edge') {
      for (const id of this.legal) {
        const e = this.gs.board.edges[id];
        const v1 = this.gs.board.vertices[e.v1], v2 = this.gs.board.vertices[e.v2];
        const a = this._w2s(v1.x, v1.y), b = this._w2s(v2.x, v2.y);
        const hov = this.hover && this.hover.kind === 'edge' && this.hover.id === id;
        ctx.lineCap = 'round';
        ctx.strokeStyle = `rgba(240,200,64,${hov ? 0.95 : 0.4 + pulse * 0.3})`;
        ctx.lineWidth = s * (hov ? 0.16 : 0.10);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
    } else if (this.mode === 'robber') {
      for (const id of this.legal) {
        const h = this.gs.board.hexes[id];
        const p = this._w2s(h.x, h.y);
        const hov = this.hover && this.hover.kind === 'hex' && this.hover.id === id;
        this._hexPath(ctx, p.x, p.y, s * 0.95);
        ctx.strokeStyle = `rgba(240,80,80,${hov ? 1 : 0.5 + pulse * 0.4})`;
        ctx.lineWidth = hov ? 5 : 3; ctx.stroke();
      }
    }
  }

  _drawFloaters(ctx, now) {
    this.floaters = this.floaters.filter(f => now - f.born < 1400);
    for (const f of this.floaters) {
      const age = (now - f.born) / 1400;
      const p = this._w2s(f.x, f.y);
      ctx.globalAlpha = 1 - age;
      ctx.fillStyle = f.color;
      ctx.font = `bold ${this.baseScale * this.userZoom * 0.3}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(f.text, p.x, p.y - age * 50);
      ctx.globalAlpha = 1;
    }
  }

  _pop(key, now) {
    const t0 = this.pieceTimes.get(key);
    if (!t0) return 1;
    const d = (now - t0) / 320;
    if (d >= 1) return 1;
    // ease-out-back
    const c1 = 1.70158, c3 = c1 + 1;
    return 1 + c3 * Math.pow(d - 1, 3) + c1 * Math.pow(d - 1, 2);
  }
}

function ptSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy || 1;
  let t = ((px - ax) * dx + (py - ay) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
