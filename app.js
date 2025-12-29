// Multiplayer Game of Chests using Firebase Realtime Database + Anonymous Auth
// Firebase config below has been filled with the values you provided.
// Put this file alongside index.html and styles.css and serve as described earlier.

import { initializeApp } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js";
import {
  getDatabase, ref, set, push, onValue, runTransaction, get, child, serverTimestamp
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js";
import {
  getAuth, signInAnonymously, onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js";

/*
  Firebase setup reminders:
  1) In the Firebase console enable Authentication -> Anonymous.
  2) Create a Realtime Database and set rules (for testing you can allow authenticated users).
*/

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
const coinButtons = Array.from(document.querySelectorAll('.place-coin'));
const coinSpans = Array.from(document.querySelectorAll('#coins .coin'));
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

// --- Local state
let uid = null;
let currentRoomId = null;
let roomRef = null;
let localRole = null; // 'presenter'|'placer'|null
let roomData = null;
let isListening = false;

// Default initial game state factory
function initialState(){
  return {
    baskets: [[],[],[]],
    sums: [0,0,0],
    remaining: [1,2,3,4],
    turn: 0,
    currentOffered: null,
    phase: 'waiting', // waiting -> offering -> placing -> finished
    moves: []
  };
}

// Sign in anonymously
signInAnonymously(auth).catch(err => {
  console.error('Auth error', err);
  authStatus.textContent = 'Auth error: ' + err.message;
});
onAuthStateChanged(auth, user => {
  if(user){
    uid = user.uid;
    authStatus.textContent = `Signed in (uid: ${uid.slice(0,8)})`;
  } else {
    uid = null;
    authStatus.textContent = 'Signed out';
  }
});

// --- Room creation/joining
createRoomBtn.addEventListener('click', async () => {
  const role = roleSelect.value;
  // push new room to /rooms to get unique key
  const roomsRef = ref(db, 'rooms');
  const newRoomRef = push(roomsRef);
  const rid = newRoomRef.key;
  const room = {
    createdAt: Date.now(),
    presenter: role === 'presenter' ? uid : null,
    placer: role === 'placer' ? uid : null,
    state: initialState()
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
  // remove role assignment if we occupy it
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
  authStatus.textContent = `Signed in (uid: ${uid.slice(0,8)})`;
});

// joinRoom: attempt to join existing room; if roleHint provided try to take that role
async function joinRoom(roomId, roleHint = null){
  const rRef = ref(db, `rooms/${roomId}`);
  const snap = await get(rRef);
  if(!snap.exists()) throw new Error('Room not found');
  const room = snap.val();
  // If both slots full and we aren't already in it, refuse
  if(room.presenter && room.placer && room.presenter !== uid && room.placer !== uid){
    throw new Error('Room already has two players');
  }
  // if not present, try to occupy preferred role or the empty one
  let roleAssigned = null;
  if(room.presenter === uid) roleAssigned = 'presenter';
  if(room.placer === uid) roleAssigned = 'placer';
  if(!roleAssigned){
    if(roleHint && !room[roleHint]) {
      room[roleHint] = uid;
      roleAssigned = roleHint;
    } else {
      // take any empty
      if(!room.presenter){
        room.presenter = uid; roleAssigned = 'presenter';
      } else if(!room.placer){
        room.placer = uid; roleAssigned = 'placer';
      } else {
        // shouldn't get here because we checked above, but guard
        throw new Error('No role available');
      }
    }
    // write back assignment
    await set(rRef, room);
  }

  currentRoomId = roomId;
  roomRef = rRef;
  localRole = roleAssigned;
  roomInfo.hidden = false;
  roomIdLabel.textContent = roomId;
  presenterLabel.textContent = shortId(room.presenter);
  placerLabel.textContent = shortId(room.placer);
  localRoleLabel.textContent = `4You: ${localRole}`;
  boardSection.hidden = false;
  attachRoomListener(roomId);
}

// helper: short id display
function shortId(u){ return u ? u.slice(0,8) : '—'; }

// detach listener when leaving or switching room
function detachRoomListener(){
  if(!roomRef) return;
  // onValue returns an unsubscribe function, but since we used onValue we need to call off.
  // For simplicity, we'll reload page when leaving. But better to clear state:
  // We'll null out roomData and stop logic by setting isListening=false.
  isListening = false;
  roomData = null;
  movesList.innerHTML = '';
  coinSpans.forEach(s => s.classList.add('available'), s.classList.remove('used'));
}

// attach listener and keep updating UI
function attachRoomListener(roomId){
  if(isListening) return;
  const rRef = ref(db, `rooms/${roomId}`);
  onValue(rRef, snap => {
    if(!snap.exists()) {
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
    // if state missing, initialize
    if(!room.state) {
      // set initial state
      set(ref(db, `rooms/${roomId}/state`), initialState());
      return;
    }
    renderState(room.state);
  });
  isListening = true;
}

// UI rendering based on room.state
function renderState(state){
  // show/hide pieces
  // phase handling
  const phase = state.phase || 'waiting';
  // updates for baskets
  for(let i=0;i<3;i++){
    const arr = state.baskets && state.baskets[i] ? state.baskets[i] : [];
    basketContents[i].textContent = arr.length ? arr.join(', ') : '(empty)';
    const s = (state.sums && state.sums[i]) ? state.sums[i] : 0;
    basketSums[i].textContent = `Sum: ${s}`;
  }
  // remaining coins UI
  coinSpans.forEach(s => {
    const v = Number(s.dataset.value);
    if(state.remaining && state.remaining.includes(v)) s.classList.add('available'), s.classList.remove('used');
    else s.classList.remove('available'), s.classList.add('used');
  });
  // history
  movesList.innerHTML = '';
  if(state.moves && state.moves.length){
    state.moves.forEach(m => {
      const li = document.createElement('li');
      li.textContent = `Turn ${m.turn}: basket ${m.idx+1} <- ${m.coin} (${m.byShort || m.by})`;
      movesList.appendChild(li);
    });
  }

  // control enabling depending on role and phase
  if(phase === 'waiting'){
    infoEl.textContent = 'Waiting for both players to join...';
    offers.forEach(b => b.disabled = true);
    coinButtons.forEach(b => b.disabled = true);
    placerPrompt.textContent = 'Waiting for basket offer...';
    resultEl.hidden = true;
  } else if(phase === 'offering' || phase === 'placing' || phase === 'ready'){
    // default: offering means presenter should offer; placing means a coin must be placed on currentOffered
    const offered = state.currentOffered ?? null;
    if(phase === 'offering'){
      infoEl.textContent = `Presenter's turn — offer a basket (turn ${state.turn+1}/4)`;
    } else if(phase === 'placing'){
      infoEl.textContent = `Basket ${offered+1} offered — placer must place a coin`;
    } else {
      infoEl.textContent = 'Game in progress';
    }

    // Presenter can offer only if it's their turn and no currentOffered
    offers.forEach(b => {
      const idx = Number(b.dataset.index);
      b.disabled = !(localRole === 'presenter' && offered === null && state.turn < 4);
    });

    // Placer can place only if localRole is placer and currentOffered != null
    coinButtons.forEach(b => {
      const val = Number(b.dataset.value);
      b.disabled = !(localRole === 'placer' && offered !== null && state.remaining && state.remaining.includes(val));
    });

    if(phase === 'placing' && offered !== null){
      placerPrompt.textContent = `Basket ${offered+1} offered — place a coin`;
    } else {
      placerPrompt.textContent = 'Waiting for basket offer...';
    }
    resultEl.hidden = true;

  } else if(phase === 'finished'){
    // compute result display
    const sorted = (state.sums || [0,0,0]).slice().sort((a,b)=>b-a);
    const s1 = sorted[0], s2 = sorted[1];
    if(s1 > s2) {
      resultText.textContent = `Placer wins — top ${s1} vs second ${s2}`;
    } else {
      resultText.textContent = `Presenter wins (draw) — top ${s1} vs second ${s2}`;
    }
    resultEl.hidden = false;
    infoEl.textContent = 'Game over';
    offers.forEach(b => b.disabled = true);
    coinButtons.forEach(b => b.disabled = true);
    placerPrompt.textContent = 'Game over';
  }
}

// --- Game actions using transactions
// Offer basket (presenter action)
offers.forEach(b => b.addEventListener('click', async (e) => {
  const idx = Number(e.currentTarget.dataset.index);
  if(!currentRoomId) return;
  const stateRef = ref(db, `rooms/${currentRoomId}/state`);
  try{
    await runTransaction(stateRef, cur => {
      if(cur == null) return cur;
      // only presenter may offer and there must be no currentOffered
      const room = roomData || {};
      if(room.presenter !== uid) {
        throw new Error('Not presenter');
      }
      if(cur.currentOffered !== null) {
        throw new Error('Already offered');
      }
      if(cur.turn >= 4) {
        throw new Error('Game finished');
      }
      cur.currentOffered = idx;
      cur.phase = 'placing';
      // add a transient lastOffer (not required)
      return cur;
    });
  }catch(err){
    console.warn('Offer failed', err);
    alert('Offer failed: ' + (err.message || err));
  }
}));

// Place coin (placer action)
coinButtons.forEach(btn => btn.addEventListener('click', async (e) => {
  const coin = Number(e.currentTarget.dataset.value);
  if(!currentRoomId) return;
  const stateRef = ref(db, `rooms/${currentRoomId}/state`);
  try{
    await runTransaction(stateRef, cur => {
      if(cur == null) return cur;
      if(cur.currentOffered === null){
        throw new Error('No basket offered');
      }
      if((roomData && roomData.placer) !== uid){
        throw new Error('Not the placer');
      }
      if(!cur.remaining || !cur.remaining.includes(coin)){
        throw new Error('Coin not available');
      }
      const idx = cur.currentOffered;
      // place coin
      cur.baskets = cur.baskets || [[],[],[]];
      cur.baskets[idx] = cur.baskets[idx] || [];
      cur.baskets[idx].push(coin);
      cur.sums = cur.sums || [0,0,0];
      cur.sums[idx] = (cur.sums[idx] || 0) + coin;
      // remove coin
      cur.remaining = cur.remaining.filter(c => c !== coin);
      // record move
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
      // if finished
      if(cur.turn >= 4){
        cur.phase = 'finished';
        // winner can be computed client-side; we preserve sums
      } else {
        cur.phase = 'offering';
      }
      return cur;
    });
  }catch(err){
    console.warn('Place failed', err);
    alert('Place failed: ' + (err.message || err));
  }
}));

// new game / reset (either player can request — in a real app you'd restrict)
newGameBtn.addEventListener('click', async () => {
  if(!currentRoomId) return;
  if(!confirm('Reset game to initial state?')) return;
  const sRef = ref(db, `rooms/${currentRoomId}/state`);
  await set(sRef, initialState());
});

// Utility: short helper to show/hide and update UI when user refreshes
// Periodically check if roomData.phase is missing and when both players present set phase to offering
setInterval(async () => {
  if(!currentRoomId || !roomData) return;
  // if both players present and phase is waiting, set to offering
  if(roomData.presenter && roomData.placer && roomData.state && roomData.state.phase === 'waiting'){
    await set(ref(db, `rooms/${currentRoomId}/state/phase`), 'offering');
    // ensure state object exists
    const sRef = ref(db, `rooms/${currentRoomId}/state`);
    const sSnap = await get(sRef);
    if(!sSnap.exists()){
      await set(sRef, initialState());
    }
  }
}, 1000);

// small helper: when room is available and both players present, ensure UI visible
// (rendering occurs in onValue listener)

// Helper to compute final winner (optional local check)
// Not required because we present sums and phase finished means game ended.

// helper to show initial UI state on load
(function init(){
  boardSection.hidden = true;
  roomInfo.hidden = true;
  resultEl.hidden = true;
})();