# 🎲 Hexagon — a Catan-like LAN board game

Web game for **2–10 players** over your local network. Build settlements, trade
resources, grab Longest Road & Largest Army, race to the target points. Animated
WebGL ocean background, canvas board with pop/slide animations, authoritative
server (no cheating — every move is validated server-side, hands stay private).

## Run it

```bash
npm install
npm start
```

The server prints URLs:

```
Local:   http://localhost:3000
Network: http://192.168.1.146:3000   <- share this with friends on your LAN
```

- **Host:** open the page → enter a name → **Create Game** → share the 4-letter room code.
- **Friends (same Wi-Fi/LAN):** open the **Network URL** → enter a name → type the code → **Join**.
- Host clicks **Start Game** when everyone's in (2–10 players).
- **Short on players?** Host can hit **+ Bot** in the lobby to fill seats with AI
  opponents. Bots place their own setup, roll, build, move the robber, and respond
  to trade offers — all server-side, paced so you can watch each move.

> Everyone must be on the same network. If a friend can't reach the Network URL,
> the host's firewall is likely blocking port 3000 — allow it for Node.

**Refresh / dropped connection:** if a player reloads the page or briefly loses
connection, they're put **straight back into the same game** — their seat, pieces,
and hand are preserved. The session is remembered in the browser, the socket
reconnects automatically, and the room is held for 10 minutes after the last player
drops. Use **Leave** to exit for good.

## Playing with friends NOT on your Wi-Fi (over the internet)

The Network URL is a **private LAN address** — it only works for people on the same
router. For remote friends, expose the local server with a tunnel (no deploy needed).
The client auto-uses secure `wss://` behind an https tunnel.

**Option A — Cloudflare Tunnel (free, no signup):**
```bash
npm start                              # in one terminal
brew install cloudflared               # once
cloudflared tunnel --url http://localhost:3000
```
It prints a public `https://something.trycloudflare.com` URL — share that. Friends
open it, Create/Join as normal. Stop the tunnel to close access.

**Option B — ngrok:**
```bash
npm start
ngrok http 3000                        # share the https URL it prints
```

**Option C — deploy** to Render / Railway / Fly.io (the server already reads
`process.env.PORT`). Then it's a permanent URL, no host machine required.

> A tunnel exposes your game to anyone with the link while it's running. The room
> code is the only gate — share it privately and stop the tunnel when done.

## How to play

1. **Setup:** each player places 2 settlements + 2 roads (snake order). Your second
   settlement pays out its adjacent resources immediately.
2. **Your turn:** roll the dice → everyone with a building on a hex showing that number
   collects its resource (city = 2). Then build / trade / play a dev card / end turn.
3. **Roll a 7:** anyone holding 8+ cards discards half, then the roller moves the
   robber onto a hex (it stops that hex producing) and steals a card.

### Build costs
| Build | Cost | Worth |
|-------|------|-------|
| Road | 🌲 🧱 | enables Longest Road |
| Settlement | 🌲 🧱 🐑 🌾 | 1 pt |
| City (upgrade) | 🌾🌾 ⛰️⛰️⛰️ | 2 pts |
| Dev card | 🐑 🌾 ⛰️ | knight / road / plenty / monopoly / +1 pt |

### Points (first to 10, or 12 for 7–10 players)
Settlement 1 · City 2 · **Longest Road** +2 (5+ segments) · **Largest Army** +2
(3 knights) · hidden VP dev cards +1 each.

### Trading
- **Bank/port:** 4:1, or 3:1 / 2:1 if you've settled on a matching harbor.
- **Players:** propose an offer; anyone can accept; you pick who to deal with.

### Controls
- **Click** a highlighted spot to build there.
- **Scroll** to zoom · **right-drag** to pan the board.

## Tech

- **Server:** Node + Express (static) + `ws` WebSocket. Authoritative `Game`
  engine in [`game/engine.js`](game/engine.js); board generation +
  vertex/edge/port topology in [`game/board.js`](game/board.js).
- **Client:** vanilla JS, no build step. Canvas 2D board renderer with hit-testing
  and tween animations ([`public/js/render.js`](public/js/render.js)); animated
  WebGL caustic-water background ([`public/js/shader.js`](public/js/shader.js));
  UI + networking in [`public/js/main.js`](public/js/main.js).
- Board scales with player count: 19 hexes (≤4p), 37 (≤7p), 61 (≤10p).

## Notes / not implemented
- Player-trade is a simple offer/accept (no multi-round counter-offers).
- Bots play a greedy strategy (build cities > settlements > expand > dev cards, 4:1
  bank-trade toward needs, knight when there's a good robber target). They fill seats
  well; they're not a tournament AI — a pure all-bot game occasionally plateaus.
- Reconnect uses a browser-stored session (localStorage) keyed to the player id;
  clearing site data or switching browsers needs a fresh join.
- This is an original implementation inspired by Catan; not affiliated with or
  endorsed by Catan GmbH.
