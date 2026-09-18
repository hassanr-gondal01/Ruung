// Rung / Ruung — online 4-player card game
// Server-authoritative Node.js + Socket.IO backend.

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Card / game constants (mirrors the rules used in the original build)
// ---------------------------------------------------------------------------
const RANKS = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];
const RANK_VAL = Object.fromEntries(RANKS.map((r,i)=>[r,i]));
const SUITS = ['S','H','D','C'];
const SUIT_COLOR = { S:'black', H:'red', D:'red', C:'black' };
const NEXT_LEVELS = { 0:[7,10,13], 7:[10,13], 10:[13], 13:[] };

function rankOf(c){ return c[0]; }
function suitOf(c){ return c[1]; }
function teamOf(seat){ return seat % 2 === 0 ? 'A' : 'B'; }

function buildDeck(){
  const d = [];
  for(const s of SUITS) for(const r of RANKS) d.push(r+s);
  return d;
}
function shuffle(arr){
  const a = arr.slice();
  for(let i=a.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [a[i],a[j]] = [a[j],a[i]];
  }
  return a;
}
function hasPictureCard(cards){
  return cards.some(c => RANK_VAL[rankOf(c)] >= RANK_VAL['J']);
}
// Deal 13 cards to each of the 4 seats, guaranteeing the opening bidder's
// first 5 cards include at least one J/Q/K/A. Re-shuffles until true.
function dealHands(firstBidderSeat){
  for(let attempt=0; attempt<500; attempt++){
    const deck = shuffle(buildDeck());
    const hands = [[],[],[],[]];
    for(let k=0;k<52;k++){
      const seat = (firstBidderSeat + k) % 4;
      hands[seat].push(deck[k]);
    }
    if(hasPictureCard(hands[firstBidderSeat].slice(0,5))) return hands;
  }
  // astronomically unlikely fallback
  const deck = shuffle(buildDeck());
  const hands = [[],[],[],[]];
  for(let k=0;k<52;k++) hands[(firstBidderSeat+k)%4].push(deck[k]);
  return hands;
}
function legalCards(hand, ledSuit){
  if(!ledSuit) return hand.slice();
  const has = hand.some(c=>suitOf(c)===ledSuit);
  return has ? hand.filter(c=>suitOf(c)===ledSuit) : hand.slice();
}
function trickWinnerSeat(trick, ledSuit, trumpSuit){
  const entries = trick
    .map((card,seat)=>({seat,card}))
    .filter(e=>e.card!=null)
    .map(e=>({seat:e.seat, suit:suitOf(e.card), rank:rankOf(e.card)}));
  const trumps = entries.filter(e=>e.suit===trumpSuit);
  const pool = trumps.length ? trumps : entries.filter(e=>e.suit===ledSuit);
  pool.sort((a,b)=> RANK_VAL[b.rank]-RANK_VAL[a.rank]);
  return pool[0].seat;
}
// Trump suit's cards sort first; the remaining 3 suits alternate colors
// starting with the opposite color (e.g. trump Spades -> Spades, a Red
// suit, Clubs, the other Red suit).
function suitDisplayOrder(trumpSuit){
  if(!trumpSuit) return ['S','H','C','D'];
  const isBlack = SUIT_COLOR[trumpSuit]==='black';
  const sameColorSuit = isBlack ? (trumpSuit==='S'?'C':'S') : (trumpSuit==='H'?'D':'H');
  const oppositeSuits = isBlack ? ['H','D'] : ['S','C'];
  return [trumpSuit, oppositeSuits[0], sameColorSuit, oppositeSuits[1]];
}
function sortHand(hand, trumpSuit){
  const order = suitDisplayOrder(trumpSuit);
  return hand.slice().sort((a,b)=>{
    const sa = order.indexOf(suitOf(a)), sb = order.indexOf(suitOf(b));
    if(sa!==sb) return sa-sb;
    return RANK_VAL[rankOf(b)] - RANK_VAL[rankOf(a)];
  });
}

// ---------------------------------------------------------------------------
// Room state
// ---------------------------------------------------------------------------
const rooms = new Map(); // code -> room object

function freshBidding(firstBidderSeat){
  return { turnSeat:firstBidderSeat, level:0, suit:null, holderSeat:null, holderName:null,
    passed:[false,false,false,false] };
}
function freshTrump(){ return { suit:null, level:0, seat:null, team:null }; }
function freshPlay(){
  return { trickNumber:1, leadSeat:null, turnSeat:null, ledSuit:null, trick:[null,null,null,null],
    streakSeat:null, streakCount:0, streakBanked:0, firstBankDone:false, bankedA:0, bankedB:0,
    lastTrickWinWasAce:false };
}
function blankRoom(code){
  return {
    code,
    phase:'lobby', // lobby | bidding | playing | handover
    seats:[null,null,null,null], // {clientId, name}
    hands:[[],[],[],[]],
    handNumber:0, firstBidderSeat:0,
    bidding: freshBidding(0),
    trump: freshTrump(),
    play: freshPlay(),
    matchScore:{A:0,B:0},
    log:[],
    lastResult:null,
    clients: new Map(), // clientId -> { socketId, name }
  };
}
function getRoom(code){
  if(!rooms.has(code)) rooms.set(code, blankRoom(code));
  return rooms.get(code);
}
function pushLog(room, msg){
  room.log.push(msg);
  if(room.log.length>24) room.log = room.log.slice(-24);
}
function seatOfClient(room, clientId){
  for(let i=0;i<4;i++){
    const s = room.seats[i];
    if(s && s.clientId===clientId) return i;
  }
  return null;
}
function visibleHandFor(room, seat){
  const all = room.hands[seat] || [];
  if(room.phase==='bidding') return all.slice(0,5);
  return all;
}

// Broadcast the public state to everyone in the room, then privately push
// each seated player's own (possibly partial, during bidding) hand.
function broadcast(room){
  const publicState = {
    code: room.code,
    phase: room.phase,
    seats: room.seats.map(s => s ? { name: s.name } : null),
    handNumber: room.handNumber,
    firstBidderSeat: room.firstBidderSeat,
    bidding: room.bidding,
    trump: room.trump,
    play: room.play,
    matchScore: room.matchScore,
    log: room.log,
    lastResult: room.lastResult,
  };
  io.to(room.code).emit('state', publicState);
  for(const [clientId, client] of room.clients.entries()){
    const seat = seatOfClient(room, clientId);
    io.to(client.socketId).emit('yourSeat', { seat });
    if(seat!==null){
      const hand = sortHand(visibleHandFor(room, seat), room.trump.suit);
      io.to(client.socketId).emit('yourHand', { seat, cards: hand });
    }
  }
}

function randomRoomCode(){
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code = '';
  for(let i=0;i<4;i++) code += letters[Math.floor(Math.random()*letters.length)];
  return code;
}

// ---------------------------------------------------------------------------
// Game actions (all server-authoritative; mirror the original rules exactly)
// ---------------------------------------------------------------------------
function doClaimSeat(room, clientId, name, seatIndex){
  if(room.phase!=='lobby') return;
  if(seatIndex<0 || seatIndex>3) return;
  if(room.seats[seatIndex]) return;
  if(seatOfClient(room, clientId)!==null) return;
  room.seats[seatIndex] = { clientId, name: name || 'Player' };
}
function doLeaveSeat(room, clientId){
  if(room.phase!=='lobby') return;
  const seat = seatOfClient(room, clientId);
  if(seat===null) return;
  room.seats[seat] = null;
}
function doStartGame(room){
  if(room.phase!=='lobby') return;
  if(!room.seats.every(s=>s)) return;
  const firstBidderSeat = 0;
  room.handNumber = 0;
  room.firstBidderSeat = firstBidderSeat;
  room.hands = dealHands(firstBidderSeat);
  room.bidding = freshBidding(firstBidderSeat);
  room.trump = freshTrump();
  room.play = freshPlay();
  room.matchScore = {A:0,B:0};
  room.lastResult = null;
  room.log = [];
  pushLog(room, `Game started. Seat ${firstBidderSeat} opens the bidding.`);
  room.phase = 'bidding';
}
function seatName(room, seat){
  const s = room.seats[seat];
  return s ? s.name : `Seat ${seat}`;
}
function doPlaceBid(room, clientId, suit, level){
  const seat = seatOfClient(room, clientId);
  if(seat===null || room.phase!=='bidding') return;
  const b = room.bidding;
  if(b.turnSeat!==seat) return;
  const allowed = b.level===0 ? NEXT_LEVELS[0] : NEXT_LEVELS[b.level];
  if(!allowed.includes(level)) return;
  if(!SUITS.includes(suit)) return;
  const name = seatName(room, seat);
  b.level = level; b.suit = suit; b.holderSeat = seat; b.holderName = name;
  pushLog(room, `${name} called ${level} of ${suitFullName(suit)}.`);
  if(level>=13){ finishBidding(room); return; }
  let next = seat;
  for(let step=1; step<=4; step++){
    const cand = (seat+step)%4;
    if(!b.passed[cand]){ next=cand; break; }
  }
  b.turnSeat = next;
}
function suitFullName(s){
  return { S:'Spades', H:'Hearts', D:'Diamonds', C:'Clubs' }[s];
}
function doPassBid(room, clientId){
  const seat = seatOfClient(room, clientId);
  if(seat===null || room.phase!=='bidding') return;
  const b = room.bidding;
  if(b.turnSeat!==seat) return;
  if(b.level===0) return; // opening call cannot be passed
  const name = seatName(room, seat);
  b.passed[seat] = true;
  pushLog(room, `${name} passed.`);
  const passedCount = b.passed.filter(Boolean).length;
  if(passedCount>=3){ finishBidding(room); return; }
  let next = seat;
  for(let step=1; step<=4; step++){
    const cand=(seat+step)%4;
    if(!b.passed[cand]){ next=cand; break; }
  }
  b.turnSeat = next;
}
function doRedealWeakHand(room, clientId){
  const seat = seatOfClient(room, clientId);
  if(seat===null || room.phase!=='bidding') return;
  const b = room.bidding;
  if(b.level!==0 || b.turnSeat!==seat) return;
  const hand = visibleHandFor(room, seat);
  const isWeak = hand.length>0 && hand.every(c=>RANK_VAL[rankOf(c)] < RANK_VAL['J']);
  if(!isWeak) return;
  room.hands = dealHands(room.firstBidderSeat);
  room.bidding = freshBidding(room.firstBidderSeat);
  pushLog(room, `${seatName(room, seat)} had no card above 10 and redealt everyone's hand.`);
}
function finishBidding(room){
  const b = room.bidding;
  const seat = b.holderSeat;
  const team = teamOf(seat);
  room.trump = { suit: b.suit, level: b.level, seat, team };
  room.play = freshPlay();
  room.play.leadSeat = seat;
  room.play.turnSeat = seat;
  pushLog(room, `${b.holderName} wins the bid: ${b.level} of ${suitFullName(b.suit)} for Team ${team}.`);
  room.phase = 'playing';
}
function doPlayCard(room, clientId, card){
  const seat = seatOfClient(room, clientId);
  if(seat===null || room.phase!=='playing') return;
  const p = room.play;
  if(p.turnSeat!==seat) return;
  const hand = room.hands[seat];
  if(!hand.includes(card)) return;
  const legal = legalCards(hand, p.ledSuit);
  if(!legal.includes(card)) return;

  const name = seatName(room, seat);
  const isLeading = p.trick.every(v=>v==null);
  let effectiveCard = card;
  let downgraded = false;
  if(isLeading && rankOf(card)==='A' && p.trickNumber!==13 && p.lastTrickWinWasAce){
    effectiveCard = '2'+suitOf(card);
    downgraded = true;
  }

  // remove the REAL card from their hand
  room.hands[seat] = hand.filter(c=>c!==card);
  p.trick[seat] = effectiveCard;
  const playedCount = p.trick.filter(v=>v!=null).length;

  pushLog(room, downgraded
    ? `${name} leads the Ace of ${suitFullName(suitOf(card))} again — downgraded to 2${suitOf(card)}.`
    : `${name} played ${rankOf(effectiveCard)}${suitOf(effectiveCard)}.`);

  if(playedCount===1) p.ledSuit = suitOf(effectiveCard);

  if(playedCount<4){
    p.turnSeat = (seat+1)%4;
    return;
  }

  // 4th card played -> resolve the trick
  const winnerSeat = trickWinnerSeat(p.trick, p.ledSuit, room.trump.suit);
  const winnerTeam = teamOf(winnerSeat);
  const winnerName = seatName(room, winnerSeat);
  const trickNum = p.trickNumber;
  const winningCard = p.trick[winnerSeat];
  const winningCardIsAce = rankOf(winningCard)==='A';
  pushLog(room, `${winnerName} takes trick ${trickNum}.`);

  let { streakSeat, streakCount, streakBanked, firstBankDone, bankedA, bankedB } = p;

  if(trickNum!==12){
    if(streakSeat===winnerSeat){ streakCount+=1; }
    else { streakSeat=winnerSeat; streakCount=1; streakBanked=0; }
    const threshold = firstBankDone ? 2 : 5;
    const unbanked = streakCount - streakBanked;
    const canBankThisTrick = (trickNum===13) || !winningCardIsAce;
    if(unbanked>=threshold && canBankThisTrick){
      if(winnerTeam==='A') bankedA += unbanked; else bankedB += unbanked;
      streakBanked = streakCount;
      firstBankDone = true;
      pushLog(room, `Team ${winnerTeam} banks ${unbanked} trick${unbanked>1?'s':''}! (Sarr picked up)`);
    } else if(unbanked>=threshold && !canBankThisTrick){
      pushLog(room, `${winnerName} won with an Ace — senior, but this trick can't be picked up yet.`);
    }
  } else {
    pushLog(room, `Trick 12 is dead — no one can pick it up.`);
  }

  const isLastTrick = trickNum>=13;
  room.play = { trickNumber: trickNum+1, leadSeat: winnerSeat, turnSeat: winnerSeat,
    ledSuit:null, trick:[null,null,null,null], streakSeat, streakCount, streakBanked,
    firstBankDone, bankedA, bankedB, lastTrickWinWasAce: winningCardIsAce };

  if(!isLastTrick) return;

  const biddingTeam = room.trump.team;
  const bidLevel = room.trump.level;
  const biddingBanked = biddingTeam==='A' ? bankedA : bankedB;
  const success = biddingBanked >= bidLevel;
  const handWinnerTeam = success ? biddingTeam : (biddingTeam==='A'?'B':'A');
  room.matchScore[handWinnerTeam] = (room.matchScore[handWinnerTeam]||0) + 1;
  room.lastResult = { biddingTeam, bidLevel, suit: room.trump.suit, bankedA, bankedB, success, handWinnerTeam };
  pushLog(room, success
    ? `Team ${biddingTeam} made their bid of ${bidLevel} (${biddingBanked} banked) — Team ${biddingTeam} wins the hand!`
    : `Team ${biddingTeam} fell short of ${bidLevel} (only ${biddingBanked} banked) — Team ${handWinnerTeam} wins the hand!`);
  room.phase = 'handover';
}
function doNextHand(room){
  if(room.phase!=='handover') return;
  const handNumber = room.handNumber+1;
  const firstBidderSeat = (room.firstBidderSeat+1)%4;
  room.handNumber = handNumber;
  room.firstBidderSeat = firstBidderSeat;
  room.hands = dealHands(firstBidderSeat);
  room.bidding = freshBidding(firstBidderSeat);
  room.trump = freshTrump();
  room.play = freshPlay();
  pushLog(room, `Dealing hand ${handNumber+1}… Seat ${firstBidderSeat} opens the bidding.`);
  room.phase = 'bidding';
}
function doResetTable(room){
  const code = room.code;
  const fresh = blankRoom(code);
  fresh.clients = room.clients; // keep client/socket registrations so people stay connected
  rooms.set(code, fresh);
  return fresh;
}

// ---------------------------------------------------------------------------
// HTTP + Socket.IO wiring
// ---------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public'), { index:false }));

app.get('/', (req, res) => {
  res.redirect('/r/' + randomRoomCode());
});
app.get('/r/:code', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

io.on('connection', (socket) => {
  let joinedCode = null;
  let joinedClientId = null;

  socket.on('joinRoom', ({ code, name, clientId }) => {
    if(!code || !clientId) return;
    code = String(code).toUpperCase().slice(0,8);
    joinedCode = code;
    joinedClientId = clientId;
    socket.join(code);
    const room = getRoom(code);
    room.clients.set(clientId, { socketId: socket.id, name: name || 'Player' });
    // keep the seated name in sync if they reconnect with a new name
    const seat = seatOfClient(room, clientId);
    if(seat!==null && name) room.seats[seat].name = name;
    broadcast(room);
  });

  socket.on('claimSeat', ({ seatIndex, name }) => {
    if(!joinedCode) return;
    const room = getRoom(joinedCode);
    doClaimSeat(room, joinedClientId, name, seatIndex);
    broadcast(room);
  });
  socket.on('leaveSeat', () => {
    if(!joinedCode) return;
    const room = getRoom(joinedCode);
    doLeaveSeat(room, joinedClientId);
    broadcast(room);
  });
  socket.on('startGame', () => {
    if(!joinedCode) return;
    const room = getRoom(joinedCode);
    doStartGame(room);
    broadcast(room);
  });
  socket.on('placeBid', ({ suit, level }) => {
    if(!joinedCode) return;
    const room = getRoom(joinedCode);
    doPlaceBid(room, joinedClientId, suit, level);
    broadcast(room);
  });
  socket.on('passBid', () => {
    if(!joinedCode) return;
    const room = getRoom(joinedCode);
    doPassBid(room, joinedClientId);
    broadcast(room);
  });
  socket.on('redealWeakHand', () => {
    if(!joinedCode) return;
    const room = getRoom(joinedCode);
    doRedealWeakHand(room, joinedClientId);
    broadcast(room);
  });
  socket.on('playCard', ({ card }) => {
    if(!joinedCode) return;
    const room = getRoom(joinedCode);
    doPlayCard(room, joinedClientId, card);
    broadcast(room);
  });
  socket.on('nextHand', () => {
    if(!joinedCode) return;
    const room = getRoom(joinedCode);
    doNextHand(room);
    broadcast(room);
  });
  socket.on('resetTable', () => {
    if(!joinedCode) return;
    const room = doResetTable(getRoom(joinedCode));
    broadcast(room);
  });

  socket.on('disconnect', () => {
    // Seats are keyed by clientId, not socket.id, so a refresh/drop doesn't
    // free the seat — they can rejoin with the same clientId and resume.
  });
});

server.listen(PORT, () => {
  console.log(`Rung server listening on port ${PORT}`);
});
