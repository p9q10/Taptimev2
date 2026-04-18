# Time2Tap — Party Game

Multiplayer party game + solo Time Rush mode.

## Setup

```bash
npm install
npm start
```

Server runs on port `3000` (or `PORT` env variable).

## Deployment (Railway / Render / Heroku)

1. Push to GitHub
2. Connect to Railway/Render
3. Set start command: `npm start`
4. Deploy

## Game Modes

### Party Mode (Multiplayer)
- **🎯 Bullseye** — Count to the target time in your head
- **🧠 Zeitgefühl** — How long was the green phase?
- **💾 Memory** — Remember the flashing number
- **⚡ Reaktion** — Hit the green buzzer fastest
- **⏱ Countdown** — Stop the timer at the right moment
- **🔥 Tap Frenzy** — Tap as fast as possible

### Time Rush (Solo)
Collect green portals (+seconds), dodge red portals, survive level gates, beat your highscore.

## Tech Stack
- Node.js + Express + Socket.io
- Single-page HTML/CSS/JS (no framework)
- Web Audio API for sounds
- Vibration API for haptics
