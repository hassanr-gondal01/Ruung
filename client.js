/* Rung / Ruung — client. Talks to the server over Socket.IO; the server is
   fully authoritative for game rules. This file is purely rendering + intent. */

const RANKS = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];
const RANK_VAL = Object.fromEntries(RANKS.map((r,i)=>[r,i]));
const SUITS = ['S','H','D','C'];
const SUIT_SYMBOL = { S:'♠', H:'♥', D:'♦', C:'♣' };
const SUIT_COLOR  = { S:'black', H:'red', D:'red', C:'black' };
const SUIT_NAME   = { S:'Spades', H:'Hearts', D:'Diamonds', C:'Clubs' };
const NEXT_LEVELS = { 0:[7,10,13], 7:[10,13], 10:[13], 13:[] };
const POSITIONS = ['bottom','right','top','left'];

function rankLabel(r){ return r==='T' ? '10' : r; }
function rankOf(c){ return c[0]; }
function suitOf(c){ return c[1]; }
function teamOf(seat){ return seat%2===0 ? 'A' : 'B'; }

function usThemLabel(aVal, bVal, myTeam, prefix){
  const p = prefix ? prefix+': ' : '';
  if(!myTeam) return `${p}A ${aVal} · B ${bVal}`;
  return myTeam==='A' ? `${p}Us ${aVal} · Them ${bVal}` : `${p}Us ${bVal} · Them ${aVal}`;
}

/* ---------- identity / room ---------- */
function getClientId(){
  let id = localStorage.getItem('rung_clientId');
  if(!id){
    id = (crypto.randomUUID ? crypto.randomUUID() : ('c'+Math.random().toString(36).slice(2)+Date.now()));
    localStorage.setItem('rung_clientId', id);
  }
  return id;
}
function getRoomCode(){
  const m = window.location.pathname.match(/\/r\/([A-Za-z0-9]+)/);
  return m ? m[1].toUpperCase() : null;
}

const clientId = getClientId();
const roomCode = getRoomCode();
let myName = localStorage.getItem('rung_name') || '';

const app = document.getElementById('app');
let socket = null;
let gameState = null;
let mySeat = null;
let myHand = [];
let busy = false;
let busyResetTimer = null;
let resetConfirmOpen = false;

/* ---------- toast / error banner ---------- */
function showError(msg){
  const bar = document.getElementById('errbar');
  if(bar){ bar.textContent = msg; bar.style.display='block'; }
}
let toastTimer=null;
function showToast(msg){
  const el = document.getElementById('toast');
  if(!el) return;
  el.textContent = msg;
  el.style.display = 'block';
  if(toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>{ el.style.display='none'; }, 2200);
}
function copyGameLink(){
  const url = window.location.href;
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(url).then(
      ()=>showToast('Link copied — send it to your friends!'),
      ()=>showToast('Could not copy — copy the link from your address bar.')
    );
  } else {
    showToast('Copy not supported here — copy the link from your address bar.');
  }
}

function setBusy(){
  busy = true;
  if(busyResetTimer) clearTimeout(busyResetTimer);
  busyResetTimer = setTimeout(()=>{ busy=false; render(); }, 5000);
  render();
}
function clearBusy(){
  busy = false;
  if(busyResetTimer){ clearTimeout(busyResetTimer); busyResetTimer=null; }
}

/* ---------- boot ---------- */
function boot(){
  if(!roomCode){
    app.innerHTML = '<div class="center-msg"><h2>🃏 Rung</h2><p class="muted">No room code in the URL. Go back to the home page to start a new table.</p></div>';
    return;
  }
  if(!myName){
    renderNameGate();
    return;
  }
  connect();
}
function renderNameGate(){
  app.innerHTML = `<div class="name-gate"><div class="panel">
    <h2>🃏 Rung</h2>
    <p class="muted">What should we call you at the table?</p>
    <div style="display:flex;gap:8px;margin-top:10px;">
      <input type="text" id="nameInput" placeholder="Your name" maxlength="24" style="flex:1;" />
      <button class="btn" onclick="submitName()">Join</button>
    </div>
  </div></div>`;
  document.getElementById('nameInput').addEventListener('keydown', e=>{ if(e.key==='Enter') submitName(); });
  document.getElementById('nameInput').focus();
}
function submitName(){
  const val = document.getElementById('nameInput').value.trim();
  if(!val) return;
  myName = val.slice(0,24);
  localStorage.setItem('rung_name', myName);
  connect();
}

function connect(){
  app.innerHTML = '<div class="center-msg">Connecting…</div>';
  socket = io();
  socket.on('connect', ()=>{
    socket.emit('joinRoom', { code: roomCode, name: myName, clientId });
  });
  socket.on('connect_error', ()=>{ showError('Connection lost — retrying…'); });
  socket.on('state', (s)=>{
    gameState = s;
    clearBusy();
    render();
  });
  socket.on('yourSeat', ({ seat })=>{
    mySeat = seat;
    render();
  });
  socket.on('yourHand', ({ seat, cards })=>{
    if(seat===mySeat) myHand = cards;
    render();
  });
}

/* ---------- actions (server validates everything; client just expresses intent) ---------- */
function claimSeat(i){ if(busy) return; setBusy(); socket.emit('claimSeat', { seatIndex:i, name:myName }); }
function leaveSeat(){ if(busy) return; setBusy(); socket.emit('leaveSeat'); }
function startGame(){ if(busy) return; setBusy(); socket.emit('startGame'); }
function placeBid(suit, level){ if(busy) return; setBusy(); socket.emit('placeBid', { suit, level }); }
function passBid(){ if(busy) return; setBusy(); socket.emit('passBid'); }
function redealWeakHand(){ if(busy) return; setBusy(); socket.emit('redealWeakHand'); }
function playCard(card){ if(busy) return; setBusy(); socket.emit('playCard', { card }); }
function nextHand(){ if(busy) return; setBusy(); socket.emit('nextHand'); }
function toggleResetConfirm(){ resetConfirmOpen = !resetConfirmOpen; render(); }
function resetTable(){ resetConfirmOpen = false; if(busy) return; setBusy(); socket.emit('resetTable'); }

/* ---------- card helpers ---------- */
function cardsLeftForSeat(idx){
  if(!gameState || gameState.phase!=='playing') return null;
  const tricksDone = gameState.play.trickNumber - 1;
  const hasPlayedThisTrick = gameState.play.trick[idx]!=null;
  return 13 - tricksDone - (hasPlayedThisTrick?1:0);
}
function legalCards(hand, ledSuit){
  if(!ledSuit) return hand.slice();
  const has = hand.some(c=>suitOf(c)===ledSuit);
  return has ? hand.filter(c=>suitOf(c)===ledSuit) : hand.slice();
}
function cardEl(card, {clickable=false, disabled=false, small=false}={}){
  const r = rankOf(card), s = suitOf(card);
  const cls = SUIT_COLOR[s];
  const cname = small ? 'card-mini' : 'card';
  return `<div class="${cname} ${cls}${disabled?' disabled':''}" ${clickable&&!disabled?`onclick="playCard('${card}')"`:''}>
    <div>${rankLabel(r)}</div><div style="font-size:${small?'1em':'1.3em'}">${SUIT_SYMBOL[s]}</div>
  </div>`;
}

/* ---------- render ---------- */
function seatNameFn(i){
  const s = gameState.seats[i];
  return s ? s.name : '(empty)';
}

function render(){
  if(!gameState){ app.innerHTML='<div class="center-msg">Loading…</div>'; return; }
  const seat = mySeat;
  let html = header(seat);
  if(gameState.phase==='lobby') html += renderLobby(seat, seatNameFn);
  else html += renderTable(seat, seatNameFn);
  html += renderLog();
  app.innerHTML = html;
}

function header(seat){
  const ms = gameState.matchScore||{A:0,B:0};
  const myTeam = seat!==null ? teamOf(seat) : null;
  const resetControl = resetConfirmOpen
    ? `<span class="muted" style="font-size:.8rem;">Reset table for everyone?</span>
       <button class="btn danger small" onclick="resetTable()">Yes, reset</button>
       <button class="btn ghost small" onclick="toggleResetConfirm()">Cancel</button>`
    : `<button class="btn ghost small" onclick="toggleResetConfirm()">Reset Table</button>`;

  const inGame = gameState.phase==='bidding' || gameState.phase==='playing' || gameState.phase==='handover';
  let infoPills = '';
  if(inGame){
    infoPills += `<span class="info-pill">Round ${gameState.handNumber+1}</span>`;
    if(gameState.trump && gameState.trump.suit){
      infoPills += `<span class="info-pill trump-pill">Trump ${SUIT_SYMBOL[gameState.trump.suit]}</span>`;
      infoPills += `<span class="info-pill">Contract ${gameState.trump.level}</span>`;
    }
  }
  infoPills += `<span class="info-pill">${usThemLabel(ms.A||0, ms.B||0, myTeam, 'Games')}</span>`;

  return `<div class="header">
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
      <h1>🃏 Rung</h1>
      <button class="link-chip" onclick="copyGameLink()">🔗 Room ${gameState.code} · copy link</button>
    </div>
    <div style="display:flex;gap:7px;flex-wrap:wrap;align-items:center;">${infoPills}</div>
    <div style="display:flex;gap:6px;align-items:center;">${resetControl}</div>
  </div>`;
}

function renderLobby(seat, seatName){
  let seatsHtml = '';
  for(let i=0;i<4;i++){
    const s = gameState.seats[i];
    const team = teamOf(i);
    seatsHtml += `<div class="seat-card ${s?'filled':''} team${team}">
      <div class="team-tag ${team.toLowerCase()}">Team ${team} · Seat ${i}</div>
      <div>${s ? seatName(i) + (i===seat?' <span class="you-tag">YOU</span>':'') : '<span class="muted">Empty</span>'}</div>
      ${(!s && seat===null) ? `<button class="btn small" onclick="claimSeat(${i})">Sit here</button>` : ''}
      ${(s && i===seat) ? `<button class="btn ghost small" onclick="leaveSeat()">Leave</button>` : ''}
    </div>`;
  }
  const allFilled = [0,1,2,3].every(i=>gameState.seats[i]);
  return `<div class="panel">
    <h3>Lobby</h3>
    <p class="muted">4 players, 2 teams of 2. Partners sit opposite each other — pick any empty seat. Share this room's link with your 3 friends.</p>
    <div class="seats-grid">${seatsHtml}</div>
    ${allFilled ? `<button class="btn" onclick="startGame()">Start Game</button>` : `<p class="muted">Waiting for ${4-[0,1,2,3].filter(i=>gameState.seats[i]).length} more player(s)…</p>`}
  </div>`;
}

function renderTable(seat, seatName){
  const mySeatIdx = seat===null?0:seat;
  let seatsHtml='';
  for(let off=0; off<4; off++){
    const idx = (mySeatIdx+off)%4;
    const pos = POSITIONS[off];
    const biddingTurn = gameState.phase==='bidding' && gameState.bidding.turnSeat===idx;
    const isTurn = biddingTurn || (gameState.phase==='playing' && gameState.play.turnSeat===idx);
    const streakTag = (gameState.phase==='playing' && gameState.play.streakSeat===idx && gameState.play.streakCount>0)
      ? ` <span class="streak">🔥${gameState.play.streakCount}</span>` : '';
    const left = cardsLeftForSeat(idx);
    const cardsLeftTag = left!=null ? `<div class="cards-left">${left} card${left===1?'':'s'} left</div>` : '';
    seatsHtml += `<div class="seat-pos ${pos}">
      <div class="player-chip ${isTurn?'turn':''} ${idx===seat?'me':''}">
        ${seatName(idx)} · T${teamOf(idx)}${streakTag}
      </div>
      ${cardsLeftTag}
    </div>`;
  }
  let trickHtml='';
  if(gameState.phase==='playing'){
    for(let off=0; off<4; off++){
      const idx=(mySeatIdx+off)%4; const pos=POSITIONS[off];
      const card = gameState.play.trick[idx];
      let slotInner = '';
      if(card){
        slotInner = cardEl(card,{small:true});
      } else if(gameState.play.turnSeat===idx){
        slotInner = `<div class="card-mini pending-card">⏳</div>`;
      }
      trickHtml += `<div class="trick-slot ${pos}">${slotInner}</div>`;
    }
  }

  const bankBadges = gameState.phase==='playing'
    ? `<span class="badge teamA">A banked: ${gameState.play.bankedA}</span> <span class="badge teamB">B banked: ${gameState.play.bankedB}</span>`
    : '';
  const trickBadge = gameState.phase==='playing'
    ? `<span class="info-pill">Trick ${gameState.play.trickNumber}/13</span>`
    : '';
  const wastedBadge = (gameState.phase==='playing' && gameState.play.trickNumber===12)
    ? `<span class="info-pill wasted-pill">Wasted round</span>`
    : '';
  const waitingOnLine = gameState.phase==='playing'
    ? (()=>{
        const pending = [0,1,2,3].filter(i=>gameState.play.trick[i]==null);
        if(pending.length===0 || pending.length===4) return '';
        return `<p class="muted" style="text-align:center;margin:6px 0 0;">Waiting on: ${pending.map(seatName).join(', ')} to complete this trick (${4-pending.length}/4 in)</p>`;
      })()
    : '';

  let bottomPanel = '';
  if(gameState.phase==='bidding') bottomPanel = renderBidding(seat, seatName);
  else if(gameState.phase==='playing') bottomPanel = renderPlaying(seat);
  else if(gameState.phase==='handover') bottomPanel = renderHandover();

  return `
  <div class="panel" style="text-align:center;">${trickBadge} ${wastedBadge} ${bankBadges}${waitingOnLine}</div>
  <div class="table-wrap">
    ${seatsHtml}
    <div class="trick-center">${trickHtml}</div>
  </div>
  ${bottomPanel}`;
}

function renderBidding(seat, seatName){
  const b = gameState.bidding;
  const isMyTurn = seat!==null && !busy && seat===b.turnSeat;

  let handPanel = '';
  if(seat!==null){
    const cardsHtml = myHand.map(c=>cardEl(c, {clickable:false})).join('');
    handPanel = `<div class="panel">
      <h3>Your Cards</h3>
      <div class="hand-row">${cardsHtml || '<span class="muted">Waiting for cards…</span>'}</div>
    </div>`;
  }

  let body = `<h3>Bidding</h3>`;
  if(b.holderSeat!==null){
    body += `<p>Current call: <b>${b.level} of ${SUIT_NAME[b.suit]} ${SUIT_SYMBOL[b.suit]}</b> by ${seatName(b.holderSeat)} (Team ${teamOf(b.holderSeat)})</p>`;
  } else {
    body += `<p class="muted">${seatName(b.turnSeat)} opens the bidding.</p>`;
  }
  if(!isMyTurn){
    body += `<p class="muted">Waiting for ${seatName(b.turnSeat)} to act…</p>`;
  } else {
    if(b.level===0 && seat!==null){
      const isWeak = myHand.length>0 && myHand.every(c=>RANK_VAL[rankOf(c)] < RANK_VAL['J']);
      if(isWeak){
        body += `<div class="panel" style="margin:0 0 10px;background:var(--panel-border);">
          <p class="muted" style="margin:0 0 8px;">None of your 5 cards is a Jack or higher.</p>
          <button class="btn ghost" onclick="redealWeakHand()">Redeal (weak hand)</button>
        </div>`;
      }
    }
    const levels = b.level===0 ? NEXT_LEVELS[0] : NEXT_LEVELS[b.level];
    if(levels.length===0){
      body += `<p class="muted">No higher bid possible.</p>`;
    } else {
      levels.forEach(lvl=>{
        body += `<div class="bid-level-group"><h4>Call ${lvl}</h4><div class="suit-btn-row">`;
        SUITS.forEach(s=>{
          body += `<div class="suit-btn ${SUIT_COLOR[s]}" onclick="placeBid('${s}',${lvl})">${SUIT_SYMBOL[s]}</div>`;
        });
        body += `</div></div>`;
      });
    }
    if(b.level>0){
      body += `<div style="margin-top:10px;"><button class="btn ghost" onclick="passBid()">Pass</button></div>`;
    }
  }
  return `${handPanel}<div class="panel">${body}</div>`;
}

function renderPlaying(seat){
  if(seat===null) return `<div class="panel muted">You're spectating this hand.</div>`;
  const isMyTurn = gameState.play.turnSeat===seat && !busy;
  const legal = isMyTurn ? legalCards(myHand, gameState.play.ledSuit) : [];
  let cardsHtml = myHand.map(c=>cardEl(c, {clickable:true, disabled: !legal.includes(c)})).join('');
  return `<div class="panel">
    <h3>Your Hand ${gameState.play.turnSeat===seat ? (busy?'— playing…':'— your turn!') : ''}</h3>
    <div class="hand-row">${cardsHtml || '<span class="muted">No cards yet.</span>'}</div>
  </div>`;
}

function renderHandover(){
  const r = gameState.lastResult;
  if(!r) return '';
  return `<div class="panel">
    <h3>Hand ${gameState.handNumber+1} Result</h3>
    <div class="result-row"><span>Bid</span><span>${r.bidLevel} of ${SUIT_NAME[r.suit]} ${SUIT_SYMBOL[r.suit]} (Team ${r.biddingTeam})</span></div>
    <div class="result-row"><span>Team A banked</span><span>${r.bankedA}</span></div>
    <div class="result-row"><span>Team B banked</span><span>${r.bankedB}</span></div>
    <div class="result-row"><span>Outcome</span><span><b>Team ${r.handWinnerTeam} wins the hand</b> (${r.success?'bid made':'bid failed'})</span></div>
    <button class="btn" style="margin-top:10px;" onclick="nextHand()">Deal Next Hand</button>
  </div>`;
}

function renderLog(){
  const log = gameState.log||[];
  return `<div class="panel"><h3>Table Log</h3><div class="log-panel">${log.slice().reverse().map(l=>`<div>${l}</div>`).join('')||'<div class="muted">Nothing yet.</div>'}</div></div>`;
}

boot();
