// Multiplayer Game of Chests using Firebase Realtime Database + Anonymous Auth
// Defaults: coinCount = 5, compensation = 2.
// Updated: guest detection uses the room.creator (the user who created the room).
// Added: play a short click sound each time a coin is placed.
// Added: play triumphant music if guest wins, sad music if guest loses (no sound on draw).
// Added: "Guest:" selector with names (default "My guest"); final message shows selected name.
// Reworked: "Refresh" button replaced by "Play". It can be pressed any time and starts a new game
//           with selected coinCount, role, compensation and guest name. The bottom "New Game"
//           button is hidden (superseded).
// Change requested: removed the small squares that indicate which coins are still available.
//                  Only the Place buttons remain visible.
// Fixes: Play now swaps roles between players when the caller is already in the room.
//        If caller isn't in the room, Play only assigns the selected role if the slot is empty
//        (to avoid evicting another player).
//
// Put this file alongside index.html and styles.css and serve as described earlier.

import { initializeApp } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js";
import {
  getDatabase, ref, set, push, onValue, runTransaction, get
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js";
import {
  getAuth, signInAnonymously, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js";

/* Firebase setup omitted for brevity (same as before) */

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
const coinsContainer = document.getElementById('coins'); // (kept for compatibility but no spans will be rendered)
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

// coinCount, compensation, play & guest UI controls (injected)
let coinCountSelect = null;
let compSelect = null;
let playBtn = null;
let guestSelect = null; // UI select for guest name

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

// --- Click sound & end-of-game music setup (Web Audio API)
const audioCtx = (typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext))
  ? new (window.AudioContext || window.webkitAudioContext)()
  : null;

function resumeAudioContextIfNeeded(){
  if(!audioCtx) return Promise.resolve();
  if(audioCtx.state === 'suspended') {
    return audioCtx.resume().catch(()=>{/* ignore */});
  }
  return Promise.resolve();
}

function playClick(){
  if(!audioCtx) return;
  resumeAudioContextIfNeeded().then(()=>{
    try{
      const now = audioCtx.currentTime;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(1200, now);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.12, now + 0.001);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.06);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(now);
      osc.stop(now + 0.07);
    }catch(err){
      console.warn('playClick error', err);
    }
  });
}

function playSequence(notes, type = 'sine', volume = 0.12){
  if(!audioCtx) return;
  resumeAudioContextIfNeeded().then(()=>{
    try{
      const now = audioCtx.currentTime;
      let t = now;
      notes.forEach(n => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(n.freq, t);
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(volume, t + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + n.dur * 0.9);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(t);
        osc.stop(t + n.dur);
        t += n.dur;
      });
    }catch(err){
      console.warn('playSequence error', err);
    }
  });
}

function playTriumphant(){
  const C5 = 523.25, E5 = 659.25, G5 = 783.99, C6 = 1046.5;
  const notes = [
    {freq: C5, dur: 0.18},
    {freq: E5, dur: 0.18},
    {freq: G5, dur: 0.18},
    {freq: C6, dur: 0.28},
    {freq: G5, dur: 0.2}
  ];
  playSequence(notes, 'triangle', 0.14);
}

function playSad(){
  const A4 = 440.0, F4 = 349.23, E4 = 329.63, D4 = 293.66;
  const notes = [
    {freq: A4, dur: 0.25},
    {freq: F4, dur: 0.25},
    {freq: E4, dur: 0.3},
    {freq: D4, dur: 0.4}
  ];
  playSequence(notes, 'sine', 0.12);
}

let lastOutcomePlayed = null; // 'win'|'lose'|'draw'|null

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

// --- Inject lobby controls (coinCount, compensation, guest selector and Play)
function ensureLobbyControls(){
  if(coinCountSelect && compSelect && playBtn && guestSelect) return;
  const lobbyControls = document.getElementById('lobby-controls');
  if(!lobbyControls) return;

  // coin count control
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
  select.value = '5';
  ccWrapper.appendChild(select);

  // compensation control
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
  cselect.value = '2';
  compWrapper.appendChild(cselect);

  // guest selector (NEW)
  const guestWrapper = document.createElement('div');
  guestWrapper.style.display = 'flex';
  guestWrapper.style.gap = '8px';
  guestWrapper.style.alignItems = 'center';
  guestWrapper.innerHTML = `<label for="guestSelect">Guest:</label>`;
  const gselect = document.createElement('select');
  gselect.id = 'guestSelect';
  const guestNames = ['My guest', 'Burkhard', 'Felix', 'Hans-Martin', 'Heribert', 'Kester', 'Laura', 'Melanie', 'Patrick', 'Robin'];
  guestNames.forEach(name => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    gselect.appendChild(opt);
  });
  gselect.value = 'My guest';
  guestWrapper.appendChild(gselect);

  // Play button (replaces Refresh)
  const pWrapper = document.createElement('div');
  pWrapper.style.display = 'flex';
  pWrapper.style.alignItems = 'center';
  pWrapper.style.marginLeft = '6px';
  const pbtn = document.createElement('button');
  pbtn.id = 'playBtn';
  pbtn.textContent = 'Play';
  pbtn.title = 'Start a new game using the selected coinCount, compensation, role and guest name';
  pbtn.style.padding = '6px 10px';
  pbtn.disabled = false;
  pWrapper.appendChild(pbtn);

  // Insert controls before the Create Room button
  lobbyControls.insertBefore(ccWrapper, createRoomBtn);
  lobbyControls.insertBefore(compWrapper, createRoomBtn);
  lobbyControls.insertBefore(guestWrapper, createRoomBtn);
  lobbyControls.insertBefore(pWrapper, createRoomBtn);

  coinCountSelect = select;
  compSelect = cselect;
  playBtn = pbtn;
  guestSelect = gselect;

  // Play button handler: start new game with selected settings
  playBtn.addEventListener('click', async () => {
    await handlePlayClick();
  });
}
ensureLobbyControls();

// Hide bottom "New Game" button because Play supersedes it
if(newGameBtn) newGameBtn.hidden = true;

function shortId(u){ return u ? u.slice(0,8) : '—'; }

// Helper to set role with timestamp
function assignRoleWithTimestamp(obj, role, uidToAssign){
  const now = Date.now();
  if(role === 'presenter'){
    obj.presenter = uidToAssign;
    obj.presenterJoinedAt = now;
    if(obj.placer === uidToAssign) { obj.placer = null; obj.placerJoinedAt = null; }
  } else if(role === 'placer'){
    obj.placer = uidToAssign;
    obj.placerJoinedAt = now;
    if(obj.presenter === uidToAssign) { obj.presenter = null; obj.presenterJoinedAt = null; }
  }
}

// --- Play handler (start a new game with current UI settings)
// IMPORTANT: When caller is already in room, swap roles with the other player to reflect the selected role.
// If caller is not in room, only take a role when the slot is empty (no eviction).
async function handlePlayClick(){
  const selectedCoinCount = coinCountSelect ? Number(coinCountSelect.value) : 5;
  const selectedComp = compSelect ? Number(compSelect.value) : 2;
  const selectedRole = roleSelect ? roleSelect.value : null; // 'presenter'|'placer' or null
  const selectedGuestName = guestSelect ? guestSelect.value : 'My guest';

  // Build new state
  const newState = initialState(selectedCoinCount, selectedComp);

  if(!currentRoomId){
    // Create new room and assign role to creator (current user)
    const roomsRef = ref(db, 'rooms');
    const newRoomRef = push(roomsRef);
    const rid = newRoomRef.key;
    const room = {
      createdAt: Date.now(),
      creator: uid,
      presenter: null,
      placer: null,
      presenterJoinedAt: null,
      placerJoinedAt: null,
      guestName: selectedGuestName,
      state: newState
    };
    // assign role for creator (force)
    if(selectedRole === 'presenter') assignRoleWithTimestamp(room, 'presenter', uid);
    else if(selectedRole === 'placer') assignRoleWithTimestamp(room, 'placer', uid);
    // set phase
    room.state.phase = (room.presenter && room.placer) ? 'offering' : 'waiting';
    await set(newRoomRef, room);
    // join the created room
    await joinRoom(rid, selectedRole);
    lastOutcomePlayed = null;
    return;
  }

  // In-room: update atomically with swap semantics if caller is already a participant
  const roomRefPath = ref(db, `rooms/${currentRoomId}`);
  try {
    await runTransaction(roomRefPath, cur => {
      if(cur == null) return cur;

      // persist guestName
      cur.guestName = selectedGuestName;

      const priorPresenter = cur.presenter || null;
      const priorPlacer = cur.placer || null;
      const priorPresenterAt = cur.presenterJoinedAt || null;
      const priorPlacerAt = cur.placerJoinedAt || null;
      const now = Date.now();

      const callerInRoom = (priorPresenter === uid) || (priorPlacer === uid);

      if(callerInRoom){
        // Perform a role swap so both players keep being in the room but roles are swapped to reflect selection
        if(selectedRole === 'presenter'){
          // Set caller as presenter
          cur.presenter = uid;
          cur.presenterJoinedAt = now;
          // The other player (if present and not caller) becomes placer
          let other = (priorPresenter === uid) ? priorPlacer : (priorPlacer === uid) ? priorPresenter : priorPlacer;
          if(other && other !== uid){
            cur.placer = other;
            // keep previous timestamp for that user if available
            cur.placerJoinedAt = (other === priorPresenter) ? priorPresenterAt : priorPlacerAt;
          } else {
            cur.placer = null;
            cur.placerJoinedAt = null;
          }
        } else if(selectedRole === 'placer'){
          // Set caller as placer
          cur.placer = uid;
          cur.placerJoinedAt = now;
          // The other player (if present and not caller) becomes presenter
          let other = (priorPlacer === uid) ? priorPresenter : (priorPresenter === uid) ? priorPlacer : priorPresenter;
          if(other && other !== uid){
            cur.presenter = other;
            cur.presenterJoinedAt = (other === priorPlacer) ? priorPlacerAt : priorPresenterAt;
          } else {
            cur.presenter = null;
            cur.presenterJoinedAt = null;
          }
        }
      } else {
        // Caller not in room. Do NOT evict someone. Only take the selected role if slot empty.
        if(selectedRole === 'presenter'){
          if(!cur.presenter){
            assignRoleWithTimestamp(cur, 'presenter', uid);
          } else {
            // abort: presenter slot already taken
            throw new Error('Presenter slot already taken — join the room first or choose another role.');
          }
        } else if(selectedRole === 'placer'){
          if(!cur.placer){
            assignRoleWithTimestamp(cur, 'placer', uid);
          } else {
            // abort: placer slot already taken
            throw new Error('Placer slot already taken — join the room first or choose another role.');
          }
        }
      }

      // set new state and phase
      cur.state = newState;
      cur.state.phase = (cur.presenter && cur.placer) ? 'offering' : 'waiting';
      // reset last outcome marker
      lastOutcomePlayed = null;
      return cur;
    });
  }catch(err){
    console.error('Play transaction failed', err);
    alert('Play failed: ' + (err.message || err));
    return;
  }

  // Update UI immediately
  renderCoinControls(selectedCoinCount, newState.remaining);
  try{
    const snap2 = await get(roomRefPath);
    if(snap2.exists()){
      const updated = snap2.val();
      if(updated.presenter === uid) roleSelect.value = 'presenter';
      else if(updated.placer === uid) roleSelect.value = 'placer';
    }
  }catch(e){
    console.warn('Post-play read failed', e);
  }
}

// --- Helpers: render coin controls (only Place buttons now)
function renderCoinControls(coinCount, remaining){
  if(coinsContainer) coinsContainer.innerHTML = '';
  coinButtonsContainer.innerHTML = '';
  for(let v=1; v<=coinCount; v++){
    const btn = document.createElement('button');
    btn.className = 'place-coin';
    btn.dataset.value = String(v);
    btn.textContent = `Place ${v}`;
    btn.disabled = true; // enabled by renderState when appropriate
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

    // transaction succeeded -> play click
    playClick();

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
    creator: uid,
    presenter: null,
    placer: null,
    presenterJoinedAt: null,
    placerJoinedAt: null,
    guestName: guestSelect ? guestSelect.value : 'My guest',
    state: initialState(coinCount, compensation)
  };

  if(role === 'presenter') assignRoleWithTimestamp(room, 'presenter', uid);
  else if(role === 'placer') assignRoleWithTimestamp(room, 'placer', uid);

  room.state.phase = (room.presenter && room.placer) ? 'offering' : 'waiting';
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
    if(room.presenter === uid) {
      updates['presenter'] = null;
      updates['presenterJoinedAt'] = null;
    }
    if(room.placer === uid) {
      updates['placer'] = null;
      updates['placerJoinedAt'] = null;
    }
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

// joinRoom: attempt to join existing room; if roleHint provided try to take that role
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
      if(roleHint === 'presenter') room.presenterJoinedAt = Date.now();
      if(roleHint === 'placer') room.placerJoinedAt = Date.now();
      roleAssigned = roleHint;
    } else {
      if(!room.presenter){
        room.presenter = uid; room.presenterJoinedAt = Date.now(); roleAssigned = 'presenter';
      } else if(!room.placer){
        room.placer = uid; room.placerJoinedAt = Date.now(); roleAssigned = 'placer';
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
  // clear coin buttons (and coins container)
  if(coinsContainer) coinsContainer.innerHTML = '';
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

// Helper to determine guest role using room.creator (fall back to timestamps if missing)
function determineGuestRole(room){
  if(!room) return 'placer';
  if(room.creator){
    if(room.presenter && room.placer){
      if(room.creator === room.presenter) return 'placer';
      if(room.creator === room.placer) return 'presenter';
    } else {
      return 'placer';
    }
  }
  const pAt = room.presenterJoinedAt || 0;
  const plAt = room.placerJoinedAt || 0;
  if(pAt && plAt){
    return (pAt > plAt) ? 'presenter' : 'placer';
  }
  if(!pAt && plAt) return 'placer';
  if(pAt && !plAt) return 'presenter';
  return 'placer';
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

  if(playBtn) {
    // Play is always available (user requested), so keep enabled.
    playBtn.disabled = false;
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

  // highlight offered basket
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

  // If finished, show result (apply compensation to the second-highest sum)
  if(phase === 'finished'){
    const sums = (state.sums || [0,0,0]).slice();
    const sorted = sums.slice().sort((a,b)=>b-a);
    const s1 = sorted[0]; // highest basket sum
    const s2 = sorted[1]; // second-highest
    const comp = (state.compensation === undefined || state.compensation === null) ? 2 : Number(state.compensation);
    const s2WithComp = s2 + comp;

    // Determine winner side: placer wins if top > second+comp
    let winnerSide = 'presenter';
    if(s1 > s2WithComp) winnerSide = 'placer';
    else if(s1 === s2WithComp) winnerSide = 'draw';

    // Determine guest role using creator/uid logic
    const guestRole = determineGuestRole(roomData);

    // Map guestScore and opponentScore
    let guestScore, opponentScore;
    if(guestRole === 'placer'){
      guestScore = s1;
      opponentScore = s2WithComp;
    } else {
      guestScore = s2WithComp;
      opponentScore = s1;
    }

    // Determine selected guest name: prefer room.guestName (persisted), fall back to UI
    const guestName = (roomData && roomData.guestName) ? roomData.guestName : (guestSelect ? guestSelect.value : 'My guest');

    // Compose message from guest perspective with chosen name and past tense; format "7:6"
    if(winnerSide === 'draw'){
      resultText.textContent = `The game ended in a draw ${guestScore}:${opponentScore}`;
      if(lastOutcomePlayed !== 'draw') lastOutcomePlayed = 'draw';
    } else {
      const guestWon = (winnerSide === guestRole);
      if(guestWon){
        resultText.textContent = `${guestName} won ${guestScore}:${opponentScore}`;
        if(lastOutcomePlayed !== 'win'){
          lastOutcomePlayed = 'win';
          playTriumphant();
        }
      } else {
        resultText.textContent = `${guestName} lost ${guestScore}:${opponentScore}`;
        if(lastOutcomePlayed !== 'lose'){
          lastOutcomePlayed = 'lose';
          playSad();
        }
      }
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

// --- Reset/new-game handler hidden (Play supersedes it)
if(newGameBtn) {
  newGameBtn.style.display = 'none';
  newGameBtn.disabled = true;
}

// Periodic check to move waiting -> offering when both players present
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

// Init
(function init(){
  boardSection.hidden = true;
  roomInfo.hidden = true;
  resultEl.hidden = true;
  ensureLobbyControls();
  basketEls.forEach(el => {
    el.classList.remove('offered');
    el.style.boxShadow = '';
    el.style.borderColor = '';
    el.style.background = '';
  });
})();