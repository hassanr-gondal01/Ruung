# Rung / Ruung — Online Card Game

A real-time 4-player Rung (trick-taking, bidding) card game with its own
Node.js + Socket.IO server. Unlike a static site, this has an actual
backend that holds each player's hand privately and enforces every rule
server-side (bidding, follow-suit, trump, the Ace-downgrade rule, the
5-then-2 streak-banking rule, etc.) — so it works exactly like your
friend's `ruung.onrender.com`.

## Run it locally first (optional but recommended)

You'll need [Node.js](https://nodejs.org) 18+ installed.

```bash
npm install
npm start
```

Then open `http://localhost:3000` in a few browser tabs (or on your phone,
if it's on the same network — use your computer's local IP instead of
`localhost`) to test with multiple "players" before deploying.

## Deploying on Render

1. **Put this folder in a GitHub repo.** Create a new repository on
   GitHub, then from inside this folder:
   ```bash
   git init
   git add .
   git commit -m "Rung online card game"
   git branch -M main
   git remote add origin <your-new-repo-url>
   git push -u origin main
   ```
   (No `node_modules` folder is included or needed — Render installs
   dependencies itself from `package.json`.)

2. **On Render's dashboard**, click **New → Web Service** (the same
   "Web Services" tile you saw on the "Create a new Workflow" screen —
   *not* "Static Site", since this needs a real running server).

3. **Connect your GitHub repo** (Render will ask to authorize GitHub
   access the first time, then let you pick the repo you just pushed).

4. **Configure the service:**
   - **Name:** anything, e.g. `rung-online`
   - **Region:** whichever is closest to you and your friends
   - **Branch:** `main`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** the Free tier works fine for a casual game with
     4 players

5. Click **Create Web Service**. Render will build and deploy — this
   takes a minute or two. You'll get a URL like
   `https://rung-online.onrender.com`.

6. Open that URL. It auto-generates a room code and redirects you to
   something like `https://rung-online.onrender.com/r/JFBB` — **that
   exact link** is what you share with your 3 friends so you all land in
   the same room.

### One thing to know about Render's free tier

Free Web Services on Render "spin down" after a period of no traffic and
take ~30-60 seconds to wake back up on the next request. If the table
feels stuck loading right after a break, just wait a bit and refresh —
it's waking the server up, not a bug. Render's paid tiers avoid this if
it becomes annoying.

## How it's different from a static page

- Each player's hand is dealt and held **on the server**, sent only to
  that player's own browser — nothing relies on client-side tricks to
  hide cards.
- All game rules (legal plays, bidding, trump, banking) are enforced by
  the server, so a modified or buggy client can't cheat or desync the
  table.
- Seats are tied to a `clientId` stored in your browser's local storage,
  not a login — so refreshing the page keeps your seat, but clearing
  your browser storage (or opening in a new browser/incognito) will look
  like a brand-new player to the table.
- If everyone leaves and the server later restarts (e.g. Render
  redeploying, or the service spinning down and up on the free tier), all
  in-memory game state is lost. That's expected for this simple version;
  reset the table and start a new game.
