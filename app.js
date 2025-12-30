// Multiplayer Game of Chests using Firebase Realtime Database + Anonymous Auth
// Defaults: coinCount = 5, compensation = 2.
// Updated: Refresh automatically force-takes the selected role if occupied by another player.
// When clicking Refresh you already signal intent to apply the change, so no confirmation is asked.
//
// Put this file alongside index.html and styles.css and serve as described earlier.

import { initializeApp } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js";
import {
  getDatabase, ref, set, push, onValue, runTransaction, get, child, serverTimestamp
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js";
import {
  getAuth, signInAnonymously, onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js";

/* Firebase setup reminders omitted for brevity */

const firebaseConfig = {
  apiKey: "AIzaSyBgYWbZN1iwDQEJQMWUf6MmzLtvF5U5EbI",
  authDomain: "game-of-chests.firebaseapp.com",
  databaseURL: "https://game-of-chests-default-rtdb.firebaseio.com",
  projectId: "game-of-chests",
  storageBucket: "game-of-chests.firebasestorage.app",
  messagingSenderId: "10619223676",
  appId: "1:10619223676:web:a59848a05563fe9bff93f9"
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const auth = getAuth(app);

// --- DOM elements
const authStatus = document.getElementById('auth-status');
const createRoomBtn = document.getElementById('createRoom');
const joinRoomBtn = document.getElementById('joinRoom');
const roomIdInput = document.getElementById('roomIdInput');
const roleSelect = document.getElementById('roleSelect');
const roomInfo = document.getElementById('roomInfo');
const roomIdLabel = document.getElementById('roomId');
const presenterLabel = document.getElementById('presenterLabel');
const placerLabel = document.getElementById('placerLabel');
const localRoleLabel = document.getElementById('localRole');
const leaveRoomBtn = document.getElementById('leaveRoom');

const boardSection = document.getElementById('board');
const infoEl = document.getElementById('info');
const offers = Array.from(document.querySelectorAll('.offer'));
const coinsContainer = document.getElementById('coins');
const coinButtonsContainer = document.getElementById('coin-buttons');
const basketContents = [
  document.getElementById('basket-0'),
  document.getElementById('basket-1'),
  document.getElementById('basket-2'),
];
const basketSums = [
  document.getElementById('sum-0'),
  document.getElementById('sum-1'),
  document.getElementById('sum-2'),
];
const movesList = document.getElementById('moves');
const placerPrompt = document.getElementById('placer-prompt');
const resultEl = document.getElementById('result');
const resultText = document.getElementById('result-text');
const newGameBtn = document.getElementById('newGame');

// Grab the basket container elements for highlighting
const basketEls = Array.from(document.querySelectorAll('.basket'));

// --- Local state
let uid = null;
let currentRoomId = null;
let roomRef = null;
let localRole = null; // 'presenter'|'placer'|null
let roomData = null;
let isListening = false;

// coinCount, compensation & refresh UI controls (injected)
let coinCountSelect = null;
let compSelect = null;
let refreshBtn = null;

// Default initial game state factory (defaults: coinCount=5, compensation=2)
function initialState(coinCount = 5, compensation = 2){
  const remaining = [];
  for(let i=1;i<=coinCount;i++) remaining.push(i);
  return {
    baskets: [[],[],[]],
    sums: [0,0,0],
    remaining,
    turn: 0,
    currentOffered: null,
    phase: 'waiting',
    moves: [],
    coinCount: coinCount,
    compensation: compensation
  };
}

// Auth
signInAnonymously(auth).catch(err => {
  console.error('Auth error', err);
  if(authStatus) authStatus.textContent = 'Auth error: ' + err.message;
});
onAuthStateChanged(auth, user => {
  if(user){
    uid = user.uid;
    if(authStatus) authStatus.textContent = `Signed in (uid: ${uid.slice(0,8)})`;
  } else {
    uid = null;
    if(authStatus) authStatus.textContent = 'Signed out';
  }
});

// --- Inject lobby controls (coinCount, compensation, refresh)
function ensureLobbyControls(){
  if(coinCountSelect && compSelect && refreshBtn) return;
  const lobbyControls = document.getElementById('lobby-controls');
  if(!lobbyControls) return;

  // coin count
  const ccWrapper = document.createElement('div');
  ccWrapper.style.display = 'flex';
  ccWrapper.style.gap = '8px';
  ccWrapper.style.alignItems = 'center';
  ccWrapper.innerHTML = `<label for="coinCountSelect">Coins:</label>`;
  const select = document.createElement('select');
  select.id = 'coinCountSelect';
  for(let n=4;n<=10;n++){
    const opt = document.createElement('option');
    opt.value = String(n);
    opt.textContent = String(n);
    select.appendChild(opt);
  }
  select.value = '5'; // default UI value
  ccWrapper.appendChild(select);

  // compensation
  const compWrapper = document.createElement('div');
  compWrapper.style.display = 'flex';
  compWrapper.style.gap = '8px';
  compWrapper.style.alignItems = 'center';
  compWrapper.innerHTML = `<label for="compSelect">Comp:</label>`;
  const cselect = document.createElement('select');
  cselect.id = 'compSelect';
  for(let c=0;c<=10;c++){
    const opt = document.createElement('option');
    opt.value = String(c);
    opt.textContent = String(c);
    cselect.appendChild(opt);
  }
  cselect.value = '2'; // default UI value
  compWrapper.appendChild(cselect);

  // refresh button
  const rWrapper = document.createElement('div');
  rWrapper.style.display = 'flex';
  rWrapper.style.alignItems = 'center';
  rWrapper.style.marginLeft = '6px';
  const rbtn = document.createElement('button');
  rbtn.id = 'refreshBtn';
  rbtn.textContent = 'Refresh';
  rbtn.title = 'Reset game using selected coinCount/comp and assign you to chosen role (force-take if occupied)';
  rbtn.style.padding = '6px 10px';
  rbtn.disabled = false;
  rWrapper.appendChild(rbtn);

  // Insert before createRoomBtn
  lobbyControls.insertBefore(ccWrapper, createRoomBtn);
  lobbyControls.insertBefore(compWrapper, createRoomBtn);
  lobbyControls.insertBefore(rWrapper, createRoomBtn);

  coinCountSelect = select;
  compSelect = cselect;
  refreshBtn = rbtn;

  refreshBtn.addEventListener('click', async () => {
    await handleRefreshClick();
  });
}
ensureLobbyControls();

// Helper to display short id in messages
function shortId(u){ return u ? u.slice(0,8) : '—'; }

// --- Refresh logic (automatic force-take)
async function handleRefreshClick(){
  if(!currentRoomId){
    if(localRole) roleSelect.value = localRole;
    alert('Not in a room — local UI updated.');
    return;
  }

  const roomRefPath = ref(db, `rooms/${currentRoomId}`);
  let snap;
  try {
    snap = await get(roomRefPath);
  } catch(e){
    console.error('Failed to read room', e);
    alert('Refresh failed: could not read room');
    return;
  }
  if(!snap.exists()){
    alert('Room not found on server.');
    return;
  }
  const room = snap.val();
  const state = room.state || {};
  const phase = state.phase || 'waiting';
  if(phase === 'offering' || phase === 'placing'){
    alert('Cannot refresh while a round is active. Wait until the round ends.');
    return;
  }

  const selectedCoinCount = coinCountSelect ? Number(coinCountSelect.value) : (state.coinCount || 5);
  const selectedComp = compSelect ? Number(compSelect.value) : ((state.compensation === undefined || state.compensation === null) ? 2 : state.compensation);
  const selectedRole = roleSelect ? roleSelect.value : null; // 'presenter'|'placer' or null

  // Automatic force-take: if the slot is occupied by another user, we proceed and overwrite it
  // (user intent is signaled by clicking Refresh).
  const forceTakePresenter = (selectedRole === 'presenter' && room.presenter && room.presenter !== uid);
  const forceTakePlacer = (selectedRole === 'placer' && room.placer && room.placer !== uid);

  const newState = initialState(selectedCoinCount, selectedComp);
  newState.phase = (room.presenter && room.placer) ? 'offering' : 'waiting';

  try {
    await runTransaction(roomRefPath, cur => {
      if(cur == null) return cur;
      const curPhase = (cur.state && cur.state.phase) ? cur.state.phase : 'waiting';
      if(curPhase === 'offering' || curPhase === 'placing') {
        throw new Error('Active round detected on server; aborting refresh.');
      }

      // Role assignment logic (force-take automatically)
      if(selectedRole === 'presenter') {
        // if someone else is presenter, overwrite them (force-take)
        cur.presenter = uid;
        if(cur.placer === uid) cur.placer = null;
      } else if(selectedRole === 'placer') {
        cur.placer = uid;
        if(cur.presenter === uid) cur.presenter = null;
      }

      // Set the restarted state
      cur.state = newState;
      return cur;
    });
  } catch(err) {
    console.error('Refresh transaction failed', err);
    alert('Refresh failed: ' + (err.message || err));
    return;
  }

  // Update UI locally and confirm
  renderCoinControls(selectedCoinCount, newState.remaining);
  try {
    const snap2 = await get(roomRefPath);
    if(snap2.exists()){
      const updated = snap2.val();
      if(updated.presenter === uid) roleSelect.value = 'presenter';
      else if(updated.placer === uid) roleSelect.value = 'placer';
      alert(`Room reset: coinCount=${selectedCoinCount}, compensation=${selectedComp}`);
    } else {
      alert('Room updated but could not read confirmation.');
    }
  } catch(e){
    console.warn('Refresh post-read failed', e);
    alert('Room reset but failed to verify.');
  }
}

// --- Helpers: render coin controls
function renderCoinControls(coinCount, remaining){
  coinsContainer.innerHTML = '';
  coinButtonsContainer.innerHTML = '';
  for(let v=1; v<=coinCount; v++){
    const span = document.createElement('span');
    span.className = 'coin';
    span.dataset.value = String(v);
    span.textContent = String(v);
    if(remaining && remaining.includes(v)) span.classList.add('available');
    else span.classList.add('used');
    coinsContainer.appendChild(span);

    const btn = document.createElement('button');
    btn.className = 'place-coin';
    btn.dataset.value = String(v);
    btn.textContent = `Place ${v}`;
    btn.disabled = true;
    coinButtonsContainer.appendChild(btn);
  }
}

// --- Place coin (transaction)
coinButtonsContainer.addEventListener('click', async (e) => {
  const btn = e.target.closest('button.place-coin');
  if(!btn) return;
  const coin = Number(btn.dataset.value);
  if(!currentRoomId) return;
  await placeCoinTransaction(coin);
});

async function placeCoinTransaction(coin){
  const stateRef = ref(db, `rooms/${currentRoomId}/state`);
  try{
    await runTransaction(stateRef, cur => {
      if(cur == null) return cur;
      const curOff = (cur.currentOffered === undefined || cur.currentOffered === null) ? null : cur.currentOffered;
      if(curOff === null) throw new Error('No basket offered');
      if((roomData && roomData.placer) !== uid) throw new Error('Not the placer');
      if(!cur.remaining || !cur.remaining.includes(coin)) throw new Error('Coin not available');
      const idx = curOff;
      cur.baskets = cur.baskets || [[],[],[]];
      cur.baskets[idx] = cur.baskets[idx] || [];
      cur.baskets[idx].push(coin);
      cur.sums = cur.sums || [0,0,0];
      cur.sums[idx] = (cur.sums[idx] || 0) + coin;
      cur.remaining = cur.remaining.filter(c => c !== coin);
      cur.moves = cur.moves || [];
      cur.moves.push({
        turn: cur.turn + 1,
        idx,
        coin,
        by: uid,
        byShort: uid ? uid.slice(0,8) : null,
        ts: Date.now()
      });
      cur.turn = (cur.turn || 0) + 1;
      cur.currentOffered = null;
      if(cur.turn >= (cur.coinCount || 5)) cur.phase = 'finished';
      else cur.phase = 'offering';
      return cur;
    });
  }catch(err){
    console.warn('Place failed', err);
    try {
      const snap = await get(ref(db, `rooms/${currentRoomId}/state`));
      console.info('State after failed place:', snap.val());
    } catch(e){}
    alert('Place failed: ' + (err.message || err));
  }
}

// --- Room creation & join handlers
createRoomBtn.addEventListener('click', async () => {
  const role = roleSelect.value;
  const coinCount = coinCountSelect ? Number(coinCountSelect.value) : 5;
  const compensation = compSelect ? Number(compSelect.value) : 2;
  const roomsRef = ref(db, 'rooms');
  const newRoomRef = push(roomsRef);
  const rid = newRoomRef.key;
  const room = {
    createdAt: Date.now(),
    presenter: role === 'presenter' ? uid : null,
    placer: role === 'placer' ? uid : null,
    state: initialState(coinCount, compensation)
  };
  await set(newRoomRef, room);
  joinRoom(rid, role);
});

joinRoomBtn.addEventListener('click', async () => {
  const rid = (roomIdInput.value || '').trim();
  if(!rid){ alert('Enter a room ID'); return; }
  try{
    await joinRoom(rid);
  }catch(err){
    alert('Join failed: ' + err.message);
  }
});

leaveRoomBtn.addEventListener('click', async () => {
  if(!currentRoomId) return;
  const rRef = ref(db, `rooms/${currentRoomId}`);
  const snap = await get(rRef);
  if(snap.exists()){
    const room = snap.val();
    const updates = {};
    if(room.presenter === uid) updates['presenter'] = null;
    if(room.placer === uid) updates['placer'] = null;
    await set(ref(db, `rooms/${currentRoomId}`), Object.assign(room, updates));
  }
  detachRoomListener();
  currentRoomId = null;
  roomRef = null;
  localRole = null;
  roomInfo.hidden = true;
  boardSection.hidden = true;
  if(authStatus) authStatus.textContent = `Signed in (uid: ${uid ? uid.slice(0,8) : ''})`;
});

// --- joinRoom / attach listener
async function joinRoom(roomId, roleHint = null){
  const rRef = ref(db, `rooms/${roomId}`);
  const snap = await get(rRef);
  if(!snap.exists()) throw new Error('Room not found');
  const room = snap.val();
  if(room.presenter && room.placer && room.presenter !== uid && room.placer !== uid){
    throw new Error('Room already has two players');
  }
  let roleAssigned = null;
  if(room.presenter === uid) roleAssigned = 'presenter';
  if(room.placer === uid) roleAssigned = 'placer';
  if(!roleAssigned){
    if(roleHint && !room[roleHint]) {
      room[roleHint] = uid;
      roleAssigned = roleHint;
    } else {
      if(!room.presenter){
        room.presenter = uid; roleAssigned = 'presenter';
      } else if(!room.placer){
        room.placer = uid; roleAssigned = 'placer';
      } else {
        throw new Error('No role available');
      }
    }
    await set(rRef, room);
  }

  currentRoomId = roomId;
  roomRef = rRef;
  localRole = roleAssigned;
  roomInfo.hidden = false;
  roomIdLabel.textContent = roomId;
  presenterLabel.textContent = shortId(room.presenter);
  placerLabel.textContent = shortId(room.placer);
  localRoleLabel.textContent = `You: ${localRole}`;
  boardSection.hidden = false;
  attachRoomListener(roomId);
}

function detachRoomListener(){
  if(!roomRef) return;
  isListening = false;
  roomData = null;
  movesList.innerHTML = '';
  coinsContainer.innerHTML = '';
  coinButtonsContainer.innerHTML = '';
  basketEls.forEach(el => {
    el.classList.remove('offered');
    el.style.boxShadow = '';
    el.style.borderColor = '';
    el.style.background = '';
  });
}

function attachRoomListener(roomId){
  if(isListening) return;
  const rRef = ref(db, `rooms/${roomId}`);
  onValue(rRef, snap => {
    if(!snap.exists()){
      infoEl.textContent = 'Room deleted';
      return;
    }
    const room = snap.val();
    roomData = room;
    presenterLabel.textContent = shortId(room.presenter);
    placerLabel.textContent = shortId(room.placer);
    if(room.presenter === uid) localRole = 'presenter';
    else if(room.placer === uid) localRole = 'placer';
    else localRole = null;
    localRoleLabel.textContent = `You: ${localRole || 'spectator'}`;
    if(!room.state){
      const coinCount = (room.state && room.state.coinCount) ? room.state.coinCount : (room.coinCount || 5);
      const compensation = (room.state && room.state.compensation) ? room.state.compensation : (room.compensation || 2);
      set(ref(db, `rooms/${roomId}/state`), initialState(coinCount, compensation));
      return;
    }
    renderState(room.state);
  });
  isListening = true;
}

// --- renderState
function renderState(state){
  const coinCount = state.coinCount || 5;
  const compensation = (state.compensation === undefined || state.compensation === null) ? 2 : state.compensation;
  if(coinCountSelect) coinCountSelect.value = String(coinCount);
  if(compSelect) compSelect.value = String(compensation);

  renderCoinControls(coinCount, state.remaining);

  for(let i=0;i<3;i++){
    const arr = state.baskets && state.baskets[i] ? state.baskets[i] : [];
    basketContents[i].textContent = arr.length ? arr.join(', ') : '(empty)';
    const s = (state.sums && state.sums[i]) ? state.sums[i] : 0;
    basketSums[i].textContent = `Sum: ${s}`;
  }

  movesList.innerHTML = '';
  if(state.moves && state.moves.length){
    state.moves.forEach(m => {
      const li = document.createElement('li');
      li.textContent = `Turn ${m.turn}: basket ${m.idx+1} <- ${m.coin} (${m.byShort || m.by})`;
      movesList.appendChild(li);
    });
  }

  const phase = state.phase || 'waiting';

  if(refreshBtn) {
    const inGame = (phase === 'offering' || phase === 'placing');
    refreshBtn.disabled = inGame;
  }

  if(phase === 'waiting'){
    infoEl.textContent = 'Waiting for both players to join...';
    offers.forEach(b => b.disabled = true);
    Array.from(coinButtonsContainer.querySelectorAll('button.place-coin')).forEach(btn => btn.disabled = true);
    placerPrompt.textContent = 'Waiting for basket offer...';
    resultEl.hidden = true;
    basketEls.forEach(el => {
      el.classList.remove('offered');
      el.style.boxShadow = '';
      el.style.borderColor = '';
      el.style.background = '';
    });
    return;
  }

  const offered = state.currentOffered ?? null;

  basketEls.forEach((el, i) => {
    if(offered === i){
      el.classList.add('offered');
      el.style.boxShadow = '0 0 0 4px rgba(37,99,235,0.08)';
      el.style.borderColor = '#2563eb';
      el.style.background = '#f1f8ff';
    } else {
      el.classList.remove('offered');
      el.style.boxShadow = '';
      el.style.borderColor = '';
      el.style.background = '';
    }
  });

  if(phase === 'offering'){
    infoEl.textContent = `Presenter's turn — offer a basket (turn ${state.turn+1}/${state.coinCount || 5})`;
  } else if(phase === 'placing'){
    infoEl.textContent = `Basket ${offered+1} offered — placer must place a coin`;
  } else {
    infoEl.textContent = 'Game in progress';
  }

  offers.forEach(b => {
    const idx = Number(b.dataset.index);
    b.disabled = !(localRole === 'presenter' && offered === null && state.turn < (state.coinCount || 5));
  });

  Array.from(coinButtonsContainer.querySelectorAll('button.place-coin')).forEach(btn => {
    const val = Number(btn.dataset.value);
    btn.disabled = !(localRole === 'placer' && offered !== null && state.remaining && state.remaining.includes(val));
  });

  if(phase === 'placing' && offered !== null){
    placerPrompt.textContent = `Basket ${offered+1} offered — place a coin`;
  } else {
    placerPrompt.textContent = 'Waiting for basket offer...';
  }
  resultEl.hidden = true;

  if(phase === 'finished'){
    const sums = (state.sums || [0,0,0]).slice();
    const sorted = sums.slice().sort((a,b)=>b-a);
    const s1 = sorted[0];
    const s2 = sorted[1];
    const comp = (state.compensation === undefined || state.compensation === null) ? 2 : Number(state.compensation);
    const s2WithComp = s2 + comp;
    if(s1 > s2WithComp) {
      resultText.textContent = `Placer wins — ${s1} : ${s2WithComp}`;
    } else if (s1 === s2WithComp) {
      resultText.textContent = `Draw — ${s1} : ${s2WithComp}`;
    } else {
      resultText.textContent = `Placer loses — ${s1} : ${s2WithComp}`;
    }
    resultEl.hidden = false;
    infoEl.textContent = 'Game over';
    offers.forEach(b => b.disabled = true);
    Array.from(coinButtonsContainer.querySelectorAll('button.place-coin')).forEach(btn => btn.disabled = true);
    placerPrompt.textContent = 'Game over';
  }
}

// --- Offer handler (transaction)
offers.forEach(b => b.addEventListener('click', async (e) => {
  const idx = Number(e.currentTarget.dataset.index);
  if(!currentRoomId) return;
  const stateRef = ref(db, `rooms/${currentRoomId}/state`);
  try{
    await runTransaction(stateRef, cur => {
      if(cur == null) return cur;
      const room = roomData || {};
      if(room.presenter !== uid) {
        throw new Error('Not presenter');
      }
      const curOff = (cur.currentOffered === undefined || cur.currentOffered === null) ? null : cur.currentOffered;
      if (curOff !== null && typeof curOff === 'number') {
        throw new Error('Already offered');
      }
      if(cur.turn >= (cur.coinCount || 5)) {
        throw new Error('Game finished');
      }
      cur.currentOffered = idx;
      cur.phase = 'placing';
      return cur;
    });
  }catch(err){
    console.warn('Offer failed', err);
    try {
      const snap = await get(ref(db, `rooms/${currentRoomId}/state`));
      console.info('State after failed offer:', snap.val());
    } catch(e){}
    alert('Offer failed: ' + (err.message || err));
  }
}));

// --- Reset button handler
newGameBtn.addEventListener('click', async () => {
  if(!currentRoomId) return;
  if(!confirm('Reset game to initial state?')) return;
  const coinCount = (roomData && roomData.state && roomData.state.coinCount) ? roomData.state.coinCount : (coinCountSelect ? Number(coinCountSelect.value) : 5);
  const compensation = (roomData && roomData.state && (roomData.state.compensation !== undefined && roomData.state.compensation !== null)) ? Number(roomData.state.compensation) : (compSelect ? Number(compSelect.value) : 2);
  const sRef = ref(db, `rooms/${currentRoomId}/state`);
  await set(sRef, initialState(coinCount, compensation));
});

// --- Periodic check to move waiting -> offering when both players present
setInterval(async () => {
  if(!currentRoomId || !roomData) return;
  if(roomData.presenter && roomData.placer && roomData.state && roomData.state.phase === 'waiting'){
    await set(ref(db, `rooms/${currentRoomId}/state/phase`), 'offering');
    const sRef = ref(db, `rooms/${currentRoomId}/state`);
    const sSnap = await get(sRef);
    if(!sSnap.exists()){
      const coinCount = (roomData && roomData.state && roomData.state.coinCount) ? roomData.state.coinCount : (roomData.coinCount || 5);
      const compensation = (roomData && roomData.state && (roomData.state.compensation !== undefined && roomData.state.compensation !== null)) ? Number(roomData.state.compensation) : (roomData.compensation || 2);
      await set(sRef, initialState(coinCount, compensation));
    }
  }
}, 1000);

// --- Init
(function init(){
  boardSection.hidden = true;
  roomInfo.hidden = true;
  resultEl.hidden = true;
  ensureLobbyControls();
  // clear any highlight on first load
  basketEls.forEach(el => {
    el.classList.remove('offered');
    el.style.boxShadow = '';
    el.style.borderColor = '';
    el.style.background = '';
  });
})();