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
const TRICK_PAUSE_MS = 1000; // pause after the 4th card so everyone can see all 4 cards
const BOT_THINK_MS = 900; // base "thinking" delay before a bot acts, feels less instant

// ---------------------------------------------------------------------------
// Card / game constants
// ---------------------------------------------------------------------------
const RANKS = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];
const RANK_VAL = Object.fromEntries(RANKS.map((r,i)=>[r,i]));
const SUITS = ['S','H','D','C']; // also this array's order is the suit tiebreak priority (S highest)
const SUIT_COLOR = { S:'black', H:'red', D:'red', C:'black' };
const NEXT_LEVELS = { 0:[7,10,13], 7:[10,13], 10:[13], 13:[] };

function rankOf(c){ return c[0]; }
function suitOf(c){ return c[1]; }
function teamOf(seat){ return seat % 2 === 0 ? 'A' : 'B'; }
// Turns move ANTI-CLOCKWISE: seat-1 (wrapping), not seat+1.
function nextSeatAnti(seat){ return (seat + 3) % 4; }

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
  const deck = shuffle(buildDeck());
  const hands = [[],[],[],[]];
  for(let k=0;k<52;k++) hands[(firstBidderSeat+k)%4].push(deck[k]);
  return hands;
}
// The "cut": one random card per seat, purely to decide who opens hand 1 of
// a series. Highest rank wins; ties break by suit priority (S>H>D>C).
function cutForFirstBidder(){
  const deck = shuffle(buildDeck());
  const cut = [deck[0], deck[1], deck[2], deck[3]];
  let best = 0;
  for(let i=1;i<4;i++){
    const a = cut[i], b = cut[best];
    if(RANK_VAL[rankOf(a)] > RANK_VAL[rankOf(b)]) best = i;
    else if(RANK_VAL[rankOf(a)] === RANK_VAL[rankOf(b)] && SUITS.indexOf(suitOf(a)) < SUITS.indexOf(suitOf(b))) best = i;
  }
  return { firstBidderSeat: best, cutCards: cut };
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
function suitFullName(s){
  return { S:'Spades', H:'Hearts', D:'Diamonds', C:'Clubs' }[s];
}

// ---------------------------------------------------------------------------
// Room state
// ---------------------------------------------------------------------------
const rooms = new Map(); // code -> room object

// order: the 4 seats in bidding-turn order (anti-clockwise from the opener).
// acted: whether each seat (by its position in `order`) has already taken
// its one bidding turn this hand.
function freshBidding(firstBidderSeat){
  const order = [];
  let s = firstBidderSeat;
  for(let i=0;i<4;i++){ order.push(s); s = nextSeatAnti(s); }
  return { order, turnIndex:0, turnSeat: order[0], level:0, suit:null,
    holderSeat:null, holderName:null, acted:[false,false,false,false] };
}
function freshTrump(){ return { suit:null, level:0, seat:null, team:null }; }
function freshPlay(){
  return { trickNumber:1, leadSeat:null, turnSeat:null, ledSuit:null, trick:[null,null,null,null],
    streakSeat:null, streakCount:0, streakBanked:0, firstBankDone:false, bankedA:0, bankedB:0,
    tricksWonA:0, tricksWonB:0, lastTrickWinWasAce:false,
    pausing:false, pauseWinnerSeat:null };
}
function blankRoom(code){
  return {
    code,
    phase:'lobby', // lobby | bidding | playing | handover | series_end
    seats:[null,null,null,null], // {clientId, name}
    hands:[[],[],[],[]],
    handNumber:0, firstBidderSeat:0,
    seriesTarget: 10,
    seriesWinner: null,
    bidding: freshBidding(0),
    trump: freshTrump(),
    play: freshPlay(),
    matchScore:{A:0,B:0},
    log:[],
    lastResult:null,
    lastCut:null, // {cutCards, firstBidderSeat} — shown once, for hand 1 of a series
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
function seatName(room, seat){
  const s = room.seats[seat];
  return s ? s.name : `Seat ${seat}`;
}

function broadcast(room){
  const publicState = {
    code: room.code,
    phase: room.phase,
    seats: room.seats.map(s => s ? { name: s.name, isBot: !!s.isBot } : null),
    handNumber: room.handNumber,
    firstBidderSeat: room.firstBidderSeat,
    seriesTarget: room.seriesTarget,
    seriesWinner: room.seriesWinner,
    bidding: room.bidding,
    trump: room.trump,
    play: room.play,
    matchScore: room.matchScore,
    log: room.log,
    lastResult: room.lastResult,
    lastCut: room.lastCut,
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
  scheduleBotIfNeeded(room);
}

function randomRoomCode(){
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code = '';
  for(let i=0;i<4;i++) code += letters[Math.floor(Math.random()*letters.length)];
  return code;
}

// ---------------------------------------------------------------------------
// Expert bots — fill in for missing players. Server-driven: a bot has no
// socket, it just acts through the same doPlaceBid/doPassBid/doPlayCard
// functions a real client would trigger, using its own recorded clientId.
// ---------------------------------------------------------------------------
const BOT_NAMES = ['Bot Ace','Bot Raja','Bot Wizard','Bot Sultan','Bot Ninja','Bot Maverick','Bot Shaheen','Bot Falcon'];
function isBotSeat(room, seat){
  const s = room.seats[seat];
  return !!(s && s.isBot);
}
// Hand-strength heuristic used both to decide whether/how much to bid and
// which suit to nominate as trump: rewards long suits and high cards.
function evaluateSuits(hand){
  const bySuit = { S:[], H:[], D:[], C:[] };
  hand.forEach(c=>bySuit[suitOf(c)].push(c));
  let bestSuit=null, bestScore=-1;
  for(const s of SUITS){
    const cards = bySuit[s];
    if(!cards.length) continue;
    let score = cards.length*2;
    cards.forEach(c=>{ score += Math.max(0, RANK_VAL[rankOf(c)]-RANK_VAL['9']); });
    if(score>bestScore){ bestScore=score; bestSuit=s; }
  }
  return { bestSuit, bestScore };
}
function botDecideBid(room, seat){
  const hand = visibleHandFor(room, seat);
  const b = room.bidding;
  const allowed = b.level===0 ? NEXT_LEVELS[0] : NEXT_LEVELS[b.level];
  if(allowed.length===0) return { pass:true };
  const { bestSuit, bestScore } = evaluateSuits(hand);
  let desiredLevel = null;
  if(bestScore>=14) desiredLevel = 13;
  else if(bestScore>=10) desiredLevel = 10;
  else if(bestScore>=6) desiredLevel = 7;
  if(desiredLevel===null) return { pass:true };
  const candidates = allowed.filter(l=>l<=desiredLevel);
  if(candidates.length===0) return { pass:true };
  return { pass:false, level: Math.min(...candidates), suit: bestSuit };
}
// Card-play heuristic: lead your strongest suit; when following, win as
// cheaply as possible unless your partner is already winning the trick;
// when void, trump in cheaply to win unless partner already has it, else
// discard your lowest non-trump card.
function botChooseCard(room, seat){
  const p = room.play;
  const hand = room.hands[seat];
  const legal = legalCards(hand, p.ledSuit);
  if(legal.length===1) return legal[0];
  const trump = room.trump.suit;
  const isLeading = p.trick.every(v=>v==null);

  if(isLeading){
    const bySuit = {};
    legal.forEach(c=>{ (bySuit[suitOf(c)]=bySuit[suitOf(c)]||[]).push(c); });
    let bestCard=null, bestScore=-1;
    for(const s in bySuit){
      const cards = bySuit[s].slice().sort((a,b)=>RANK_VAL[rankOf(b)]-RANK_VAL[rankOf(a)]);
      const top = cards[0];
      let score = RANK_VAL[rankOf(top)] + cards.length*0.5;
      if(s===trump) score -= 3; // hold trump back unless it's genuinely the best option
      if(score>bestScore){ bestScore=score; bestCard=top; }
    }
    return bestCard || legal[0];
  }

  const currentWinner = trickWinnerSeat(p.trick, p.ledSuit, trump);
  const partnerWinning = currentWinner===((seat+2)%4);
  const canFollowSuit = hand.some(c=>suitOf(c)===p.ledSuit);
  const wouldWinWith = (card)=>{
    const hyp = p.trick.slice(); hyp[seat]=card;
    return trickWinnerSeat(hyp, p.ledSuit, trump)===seat;
  };

  if(canFollowSuit){
    const winners = legal.filter(wouldWinWith);
    if(!partnerWinning && winners.length){
      winners.sort((a,b)=>RANK_VAL[rankOf(a)]-RANK_VAL[rankOf(b)]);
      return winners[0];
    }
    const sorted = legal.slice().sort((a,b)=>RANK_VAL[rankOf(a)]-RANK_VAL[rankOf(b)]);
    return sorted[0];
  }

  if(partnerWinning){
    const nonTrump = legal.filter(c=>suitOf(c)!==trump);
    const pool = nonTrump.length?nonTrump:legal;
    pool.sort((a,b)=>RANK_VAL[rankOf(a)]-RANK_VAL[rankOf(b)]);
    return pool[0];
  }
  const trumps = legal.filter(c=>suitOf(c)===trump);
  if(trumps.length){
    const winningTrumps = trumps.filter(wouldWinWith);
    if(winningTrumps.length){
      winningTrumps.sort((a,b)=>RANK_VAL[rankOf(a)]-RANK_VAL[rankOf(b)]);
      return winningTrumps[0];
    }
  }
  const nonTrump = legal.filter(c=>suitOf(c)!==trump);
  const pool = nonTrump.length?nonTrump:legal;
  pool.sort((a,b)=>RANK_VAL[rankOf(a)]-RANK_VAL[rankOf(b)]);
  return pool[0];
}
function performBotTurn(room, seat){
  if(room.phase==='bidding'){
    if(room.bidding.turnSeat!==seat) return;
    const botClientId = room.seats[seat].clientId;
    const b = room.bidding;
    const hand = visibleHandFor(room, seat);
    if(b.level===0 && b.turnIndex===0 && hand.length>0 && hand.every(c=>RANK_VAL[rankOf(c)]<RANK_VAL['J'])){
      doRedealWeakHand(room, botClientId);
      return;
    }
    const decision = botDecideBid(room, seat);
    if(decision.pass) doPassBid(room, botClientId);
    else doPlaceBid(room, botClientId, decision.suit, decision.level);
  } else if(room.phase==='playing'){
    if(room.play.pausing || room.play.turnSeat!==seat) return;
    const botClientId = room.seats[seat].clientId;
    const card = botChooseCard(room, seat);
    doPlayCard(room, botClientId, card);
  }
}
// Called at the end of every broadcast(): if it's now a bot's turn, schedule
// its move after a small human-like delay. That move ends in its own
// broadcast(), which in turn checks again — so a chain of bot turns (or a
// bot turn following a human's) resolves itself naturally.
function scheduleBotIfNeeded(room){
  let seat = null;
  if(room.phase==='bidding' && isBotSeat(room, room.bidding.turnSeat)) seat = room.bidding.turnSeat;
  else if(room.phase==='playing' && !room.play.pausing && isBotSeat(room, room.play.turnSeat)) seat = room.play.turnSeat;
  if(seat===null) return;
  const code = room.code;
  const expectedPhase = room.phase;
  const expectedHandNumber = room.handNumber;
  setTimeout(()=>{
    if(rooms.get(code)!==room) return;
    if(room.phase!==expectedPhase || room.handNumber!==expectedHandNumber) return;
    performBotTurn(room, seat);
    broadcast(room);
  }, BOT_THINK_MS + Math.floor(Math.random()*600));
}

// ---------------------------------------------------------------------------
// Game actions
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
function doAddBot(room, seatIndex){
  if(room.phase!=='lobby') return;
  if(seatIndex<0 || seatIndex>3) return;
  if(room.seats[seatIndex]) return;
  const botId = 'bot-'+seatIndex+'-'+Math.random().toString(36).slice(2,8);
  const name = BOT_NAMES[Math.floor(Math.random()*BOT_NAMES.length)];
  room.seats[seatIndex] = { clientId: botId, name, isBot:true };
}
function doRemoveBot(room, seatIndex){
  if(room.phase!=='lobby') return;
  if(seatIndex<0 || seatIndex>3) return;
  const s = room.seats[seatIndex];
  if(!s || !s.isBot) return;
  room.seats[seatIndex] = null;
}
function doSetSeriesTarget(room, value){
  if(room.phase!=='lobby') return;
  const n = Math.round(Number(value));
  if(!Number.isFinite(n) || n<1 || n>100) return;
  room.seriesTarget = n;
}
function dealHandOne(room){
  const { firstBidderSeat, cutCards } = cutForFirstBidder();
  room.lastCut = { cutCards, firstBidderSeat };
  room.handNumber = 0;
  room.firstBidderSeat = firstBidderSeat;
  room.hands = dealHands(firstBidderSeat);
  room.bidding = freshBidding(firstBidderSeat);
  room.trump = freshTrump();
  room.play = freshPlay();
  pushLog(room, `Cut for deal: ${seatName(room, firstBidderSeat)} has the highest card and opens the bidding.`);
}
function doStartGame(room){
  if(room.phase!=='lobby') return;
  if(!room.seats.every(s=>s)) return;
  room.matchScore = {A:0,B:0};
  room.seriesWinner = null;
  room.lastResult = null;
  room.log = [];
  dealHandOne(room);
  room.phase = 'bidding';
}
function doStartNewSeries(room){
  if(room.phase!=='series_end') return;
  room.matchScore = {A:0,B:0};
  room.seriesWinner = null;
  room.lastResult = null;
  pushLog(room, `New series started (first to ${room.seriesTarget} points).`);
  dealHandOne(room);
  room.phase = 'bidding';
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
  b.acted[b.turnIndex] = true;
  pushLog(room, `${name} called ${level} of ${suitFullName(suit)}.`);
  if(level>=13){ finishBidding(room); return; }
  advanceBiddingOrFinish(room);
}
function doPassBid(room, clientId){
  const seat = seatOfClient(room, clientId);
  if(seat===null || room.phase!=='bidding') return;
  const b = room.bidding;
  if(b.turnSeat!==seat) return;
  const name = seatName(room, seat);
  b.acted[b.turnIndex] = true;
  pushLog(room, `${name} passed.`);
  advanceBiddingOrFinish(room);
}
// Each of the 4 seats gets exactly ONE bidding turn (unless someone calls 13,
// which ends bidding immediately). Once everyone in `order` has acted, the
// standing bid (if any) wins; if nobody ever bid anything, redeal and recut.
function advanceBiddingOrFinish(room){
  const b = room.bidding;
  if(b.turnIndex >= 3){
    // everyone has acted
    if(b.holderSeat!==null){ finishBidding(room); }
    else {
      pushLog(room, `Everyone passed — redealing and cutting again.`);
      dealHandOne(room);
    }
    return;
  }
  b.turnIndex += 1;
  b.turnSeat = b.order[b.turnIndex];
}
function doRedealWeakHand(room, clientId){
  const seat = seatOfClient(room, clientId);
  if(seat===null || room.phase!=='bidding') return;
  const b = room.bidding;
  if(b.level!==0 || b.turnSeat!==seat || b.turnIndex!==0) return;
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
  if(p.pausing) return; // between tricks — nobody acts during the pause
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

  room.hands[seat] = hand.filter(c=>c!==card);
  p.trick[seat] = effectiveCard;
  const playedCount = p.trick.filter(v=>v!=null).length;

  pushLog(room, downgraded
    ? `${name} leads the Ace of ${suitFullName(suitOf(card))} again — downgraded to 2${suitOf(card)}.`
    : `${name} played ${rankOf(effectiveCard)}${suitOf(effectiveCard)}.`);

  if(playedCount===1) p.ledSuit = suitOf(effectiveCard);

  if(playedCount<4){
    p.turnSeat = nextSeatAnti(seat);
    return;
  }

  // 4th card played -> resolve the trick, but PAUSE for a moment with all 4
  // cards visible before actually clearing the table for the next trick.
  const winnerSeat = trickWinnerSeat(p.trick, p.ledSuit, room.trump.suit);
  const winnerTeam = teamOf(winnerSeat);
  const winnerName = seatName(room, winnerSeat);
  const trickNum = p.trickNumber;
  const winningCard = p.trick[winnerSeat];
  const winningCardIsAce = rankOf(winningCard)==='A';
  pushLog(room, `${winnerName} takes trick ${trickNum}.`);

  let { streakSeat, streakCount, streakBanked, firstBankDone, bankedA, bankedB, tricksWonA, tricksWonB } = p;
  if(winnerTeam==='A') tricksWonA += 1; else tricksWonB += 1;

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

  // Mark "pausing" so the 4 played cards stay on screen for a moment, and no
  // one can act, before we clear the trick and hand the lead to the winner.
  room.play = { ...p, streakSeat, streakCount, streakBanked, firstBankDone,
    bankedA, bankedB, tricksWonA, tricksWonB, pausing:true, pauseWinnerSeat: winnerSeat };

  const roomRef = room;
  const targetHandNumber = room.handNumber;
  const targetTrickNumber = trickNum;
  setTimeout(()=>{
    // Bail out quietly if the room was reset/replaced while we were waiting.
    if(rooms.get(roomRef.code) !== roomRef) return;
    if(roomRef.phase!=='playing' || roomRef.handNumber!==targetHandNumber || roomRef.play.trickNumber!==targetTrickNumber) return;
    resolveTrickAfterPause(roomRef, winnerSeat, winningCardIsAce, trickNum);
    broadcast(roomRef);
  }, TRICK_PAUSE_MS);
}
function resolveTrickAfterPause(room, winnerSeat, winningCardIsAce, trickNum){
  const p = room.play;
  const isLastTrick = trickNum>=13;
  room.play = { trickNumber: trickNum+1, leadSeat: winnerSeat, turnSeat: winnerSeat,
    ledSuit:null, trick:[null,null,null,null],
    streakSeat:p.streakSeat, streakCount:p.streakCount, streakBanked:p.streakBanked,
    firstBankDone:p.firstBankDone, bankedA:p.bankedA, bankedB:p.bankedB,
    tricksWonA:p.tricksWonA, tricksWonB:p.tricksWonB,
    lastTrickWinWasAce: winningCardIsAce, pausing:false, pauseWinnerSeat:null };

  if(!isLastTrick) return;
  finishHand(room);
}
// New scoring:
//  - bidding team makes their contract AND sweeps all 13 tricks -> Court, 2 pts
//  - bidding team makes their contract, partial sweep            -> 1 pt
//  - bidding team fails, defenders sweep all 13 (bidder got 0)   -> Goon Court, 4 pts
//  - bidding team fails, defenders don't sweep                   -> 1 pt
function finishHand(room){
  const { bankedA, bankedB, tricksWonA, tricksWonB } = room.play;
  const biddingTeam = room.trump.team;
  const bidLevel = room.trump.level;
  const biddingBanked = biddingTeam==='A' ? bankedA : bankedB;
  const biddingTricksWon = biddingTeam==='A' ? tricksWonA : tricksWonB;
  const defendingTricksWon = 13 - biddingTricksWon;
  const success = biddingBanked >= bidLevel;

  let handWinnerTeam, pointsAwarded, label;
  if(success){
    handWinnerTeam = biddingTeam;
    if(biddingTricksWon===13){ pointsAwarded = 2; label = 'Court'; }
    else { pointsAwarded = 1; label = 'Made'; }
  } else {
    handWinnerTeam = biddingTeam==='A' ? 'B' : 'A';
    if(defendingTricksWon===13){ pointsAwarded = 4; label = 'Goon Court'; }
    else { pointsAwarded = 1; label = 'Set'; }
  }
  room.matchScore[handWinnerTeam] = (room.matchScore[handWinnerTeam]||0) + pointsAwarded;
  room.lastResult = { biddingTeam, bidLevel, suit: room.trump.suit, bankedA, bankedB,
    tricksWonA, tricksWonB, success, handWinnerTeam, pointsAwarded, label };

  const labelText = {
    Court: `Team ${biddingTeam} swept all 13 tricks — that's a COURT! +2 points.`,
    Made: `Team ${biddingTeam} made their bid of ${bidLevel} — +1 point.`,
    'Goon Court': `Team ${biddingTeam} was shut out (0 tricks) — GOON COURT for Team ${handWinnerTeam}! +4 points.`,
    Set: `Team ${biddingTeam} fell short of ${bidLevel} — +1 point for Team ${handWinnerTeam}.`,
  }[label];
  pushLog(room, labelText);

  if(room.matchScore[handWinnerTeam] >= room.seriesTarget){
    room.seriesWinner = handWinnerTeam;
    room.phase = 'series_end';
    pushLog(room, `Team ${handWinnerTeam} reached ${room.seriesTarget} points and wins the series!`);
  } else {
    room.phase = 'handover';
  }
}
// After a hand, the WINNING team calls the next Ruung. We hand the opening
// seat to whichever of their two seats is nearest, going anti-clockwise,
// from the current opener — so it naturally alternates between teammates.
function nextFirstBidderAfterHand(room, winningTeam){
  let seat = room.firstBidderSeat;
  for(let i=0;i<4;i++){
    seat = nextSeatAnti(seat);
    if(teamOf(seat)===winningTeam) return seat;
  }
  return room.firstBidderSeat;
}
function doNextHand(room){
  if(room.phase!=='handover') return;
  const winningTeam = room.lastResult ? room.lastResult.handWinnerTeam : teamOf(room.firstBidderSeat);
  const handNumber = room.handNumber+1;
  const firstBidderSeat = nextFirstBidderAfterHand(room, winningTeam);
  room.handNumber = handNumber;
  room.firstBidderSeat = firstBidderSeat;
  room.lastCut = null;
  room.hands = dealHands(firstBidderSeat);
  room.bidding = freshBidding(firstBidderSeat);
  room.trump = freshTrump();
  room.play = freshPlay();
  pushLog(room, `Dealing hand ${handNumber+1}… Team ${winningTeam} won last hand, so ${seatName(room, firstBidderSeat)} opens the bidding.`);
  room.phase = 'bidding';
}
function doResetTable(room){
  const code = room.code;
  const fresh = blankRoom(code);
  fresh.clients = room.clients;
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
  socket.on('addBot', ({ seatIndex }) => {
    if(!joinedCode) return;
    const room = getRoom(joinedCode);
    doAddBot(room, seatIndex);
    broadcast(room);
  });
  socket.on('removeBot', ({ seatIndex }) => {
    if(!joinedCode) return;
    const room = getRoom(joinedCode);
    doRemoveBot(room, seatIndex);
    broadcast(room);
  });
  socket.on('setSeriesTarget', ({ value }) => {
    if(!joinedCode) return;
    const room = getRoom(joinedCode);
    doSetSeriesTarget(room, value);
    broadcast(room);
  });
  socket.on('startGame', () => {
    if(!joinedCode) return;
    const room = getRoom(joinedCode);
    doStartGame(room);
    broadcast(room);
  });
  socket.on('startNewSeries', () => {
    if(!joinedCode) return;
    const room = getRoom(joinedCode);
    doStartNewSeries(room);
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
