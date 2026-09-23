# Rung / Ruung — Online Card Game

A real-time 4-player Rung (trick-taking, bidding) card game with its own
Node.js + Socket.IO server. Unlike a static site, this has an actual
backend that holds each player's hand privately and enforces every rule
server-side — so it works exactly like your friend's `ruung.onrender.com`.

## Rules implemented

- 4 players, 2 teams of 2 (opposite seats are partners). Turns move
  **anti-clockwise**.
- **Hand 1 of a series**: one card is cut to each seat; whoever has the
  highest card (ties broken by suit, Spades highest) opens the bidding.
  Every later hand, the **winning team calls next** — the opening seat
  passes to whichever of the winning team's two seats is nearest,
  anti-clockwise, from the previous opener.
- **Bidding**: each of the 4 seats gets exactly one turn, in order. On
  their turn a player either passes or calls a higher level than the
  current standing bid (7 → 10 → 13). Calling 13 ends bidding immediately.
  If all 4 pass without anyone ever bidding, the hand is redealt and
  re-cut automatically.
- 5 cards dealt first for bidding, then the rest after bidding closes.
  The opening bidder's first 5 always include at least one picture card
  (J/Q/K/A) — enforced at deal time.
- Follow suit if you can; trump always beats a non-trump lead; an
  off-suit, non-trump card can never win a trick.
- The current trick's cards stay visible for **1 second** after the 4th
  card lands before the table clears for the next trick.
- Whoever is currently "senior" (won the last trick, leading the next
  one) wears a 👑 crown next to their name.
- **Ace-downgrade rule**: leading with a 2nd Ace in a row (any suit)
  while already senior from a previous Ace converts it into a 2 of that
  suit — except on trick 13, where Aces are always full strength.
- **Streak banking**: a trick win only "banks" once you've won 5 in a
  row (first time) or 2 in a row (every time after); an Ace-won trick
  can win and keep you senior but can never complete a bank (except
  trick 13); trick 12 is always dead (nobody can bank it).
- **Scoring**, based on whether the bidding team met their contract and
  whether either side swept all 13 tricks:
  - Bid made + swept all 13 tricks → **Court**, 2 points
  - Bid made, partial → 1 point
  - Bid failed + defenders swept all 13 (bidder got 0 tricks) →
    **Goon Court**, 4 points to the defenders
  - Bid failed, partial → 1 point to the defenders
- Pick a **series target** (e.g. "first to 10 points") before starting;
  once a team reaches it, the series ends with a winner screen and a
  "Start New Series" button (which re-cuts for hand 1 again).
- **Expert bots**: any empty lobby seat can be filled with an "Add Expert
  Bot" button instead of waiting for a 4th (or 3rd, or 2nd) player. Bots
  bid and play automatically — they evaluate hand strength and suit
  length for bidding, lead their strongest suit, try to win tricks as
  cheaply as possible, and hold back trump unless it's needed. They're
  server-driven, so there's nothing to install — just click Add Bot.
- A 🐘 wanders in a slow circle around the table for fun. If a hand ends
  in a **Goon Court** (the bidding team shut out with 0 tricks), it
  leaves a little "present" 💩 at the losing team's two seats.

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
