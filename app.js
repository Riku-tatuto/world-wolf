// Firebase v10 CDN imports
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js";
import { getFirestore, collection, doc, addDoc, setDoc, getDoc, updateDoc, onSnapshot, query, where, orderBy, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-firestore.js";

import { themes } from './themes.js';

// Global State
let app, auth, db;
let currentUser = null;
let currentRoomId = null;
let unsubscribeRoom = null;
let unsubscribeChat = null;
let unsubscribeQa = null;
let isHost = false;
let myPlayerId = null;
let myTheme = "";

// DOM Elements
const screens = {
    home: document.getElementById('screen-home'),
    lobby: document.getElementById('screen-lobby'),
    game: document.getElementById('screen-game'),
    vote: document.getElementById('screen-vote'),
    result: document.getElementById('screen-result')
};

// Utils
function switchScreen(screenId) {
    Object.values(screens).forEach(s => s.classList.remove('active', 'hidden'));
    Object.values(screens).forEach(s => s.classList.add('hidden'));
    screens[screenId].classList.remove('hidden');
    screens[screenId].classList.add('active');
}

// .env Reader Function (for GitHub Pages setup as requested)
async function loadEnv() {
    try {
        const res = await fetch('./.env');
        const text = await res.text();
        const env = {};
        text.split('\n').forEach(line => {
            const match = line.match(/^([^=]+)=(.*)$/);
            if(match) env[match[1].trim()] = match[2].trim();
        });
        return env;
    } catch(e) {
        console.error("Failed to load .env", e);
        return {};
    }
}

// Initialize Firebase
async function initFirebase() {
    const env = await loadEnv();
    const firebaseConfig = {
        apiKey: env.FIREBASE_API_KEY || "YOUR_API_KEY",
        authDomain: env.FIREBASE_AUTH_DOMAIN || "YOUR_AUTH_DOMAIN",
        projectId: env.FIREBASE_PROJECT_ID || "YOUR_PROJECT_ID",
        storageBucket: env.FIREBASE_STORAGE_BUCKET || "YOUR_STORAGE_BUCKET",
        messagingSenderId: env.FIREBASE_MESSAGING_SENDER_ID || "YOUR_SENDER_ID",
        appId: env.FIREBASE_APP_ID || "YOUR_APP_ID"
    };

    app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = getFirestore(app);

    onAuthStateChanged(auth, (user) => {
        if (user) {
            currentUser = user;
            myPlayerId = user.uid;
            console.log("Logged in:", user.uid);
        } else {
            signInAnonymously(auth).catch(console.error);
        }
    });
}

// Random Match Logic
document.getElementById('btn-random-match').addEventListener('click', async () => {
    if (!currentUser) return;
    
    // Find waiting rooms
    const roomsRef = collection(db, "rooms");
    const q = query(roomsRef, where("status", "==", "waiting"), where("isPrivate", "==", false));
    const querySnapshot = await getDoc(q); // Simplified fetch for tutorial-level implementation
    // Actually getDocs(q) is needed. Let's fix.
    import { getDocs } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-firestore.js";
    const docs = await getDocs(q);
    
    let joined = false;
    docs.forEach(d => {
        if (!joined) {
            const data = d.data();
            if (Object.keys(data.players).length < 4) { // Max 4 players
                joinRoom(d.id, false);
                joined = true;
            }
        }
    });

    if (!joined) {
        createRoom(false);
    }
});

// Password Match Logic
document.getElementById('btn-password-match').addEventListener('click', () => {
    if (!currentUser) return;
    const pwd = document.getElementById('input-password').value.trim();
    if (!pwd) return alert('合言葉を入力してください');
    
    // For password match, we use password as custom room ID to make it simple
    joinOrCreateRoomById(pwd);
});

async function joinOrCreateRoomById(roomId) {
    const roomRef = doc(db, "rooms", roomId);
    const roomSnap = await getDoc(roomRef);
    if (roomSnap.exists()) {
        const data = roomSnap.data();
        if (data.status === 'waiting') {
            joinRoom(roomId, true);
        } else {
            alert('この部屋は既にプレイ中です');
        }
    } else {
        createRoom(true, roomId);
    }
}

async function createRoom(isPrivate, customId = null) {
    isHost = true;
    const players = {};
    players[myPlayerId] = {
        name: "Player 1",
        isReady: true,
        role: "", // citizen or wolf
        word: "",
        votes: 0,
        votedFor: null
    };

    const roomData = {
        hostId: myPlayerId,
        status: "waiting", // waiting, playing, voting, finished
        isPrivate: isPrivate,
        createdAt: serverTimestamp(),
        players: players,
        themeData: null // { citizen: 'A', wolf: 'B' }
    };

    let roomId = customId;
    if (customId) {
        await setDoc(doc(db, "rooms", customId), roomData);
    } else {
        const docRef = await addDoc(collection(db, "rooms"), roomData);
        roomId = docRef.id;
    }
    
    currentRoomId = roomId;
    listenRoom(roomId);
    switchScreen('lobby');
}

async function joinRoom(roomId, isPrivate) {
    isHost = false;
    const roomRef = doc(db, "rooms", roomId);
    const roomSnap = await getDoc(roomRef);
    if (!roomSnap.exists()) return alert("部屋が見つかりません");
    
    const data = roomSnap.data();
    const pCount = Object.keys(data.players).length + 1;
    
    const players = { ...data.players };
    players[myPlayerId] = {
        name: `Player ${pCount}`,
        isReady: true,
        role: "",
        word: "",
        votes: 0,
        votedFor: null
    };

    await updateDoc(roomRef, { players });
    currentRoomId = roomId;
    listenRoom(roomId);
    switchScreen('lobby');
}

function listenRoom(roomId) {
    document.getElementById('lobby-room-id').innerText = roomId;
    const roomRef = doc(db, "rooms", roomId);
    
    if (unsubscribeRoom) unsubscribeRoom();
    
    unsubscribeRoom = onSnapshot(roomRef, (snapshot) => {
        if (!snapshot.exists()) return;
        const data = snapshot.data();
        updateLobbyUI(data);
        
        // Handle transitions
        if (data.status === 'playing' && document.getElementById('screen-lobby').classList.contains('active')) {
            startGameUI(data);
            listenChat(roomId);
            listenQa(roomId);
        } else if (data.status === 'voting' && document.getElementById('screen-game').classList.contains('active')) {
            startVotingUI(data);
        } else if (data.status === 'finished' && document.getElementById('screen-vote').classList.contains('active')) {
            showResultUI(data);
        }
    });
}

function updateLobbyUI(data) {
    const list = document.getElementById('lobby-players');
    list.innerHTML = "";
    Object.keys(data.players).forEach(pId => {
        const li = document.createElement('li');
        li.innerText = data.players[pId].name + (pId === myPlayerId ? ' (あなた)' : '');
        list.appendChild(li);
    });

    const startBtn = document.getElementById('btn-start-game');
    if (isHost && Object.keys(data.players).length >= 2) {
        startBtn.classList.remove('hidden');
    } else {
        startBtn.classList.add('hidden');
    }
}

document.getElementById('btn-start-game').addEventListener('click', async () => {
    if (!isHost) return;
    const roomRef = doc(db, "rooms", currentRoomId);
    const snap = await getDoc(roomRef);
    const players = snap.data().players;
    const pIds = Object.keys(players);
    
    // Choose theme
    const randTheme = themes[Math.floor(Math.random() * themes.length)];
    // Choose wolf
    const wolfId = pIds[Math.floor(Math.random() * pIds.length)];
    
    pIds.forEach(id => {
        if (id === wolfId) {
            players[id].role = 'wolf';
            players[id].word = randTheme.wolf;
        } else {
            players[id].role = 'citizen';
            players[id].word = randTheme.citizen;
        }
    });

    await updateDoc(roomRef, {
        status: 'playing',
        players: players,
        themeData: randTheme
    });
});

function startGameUI(data) {
    switchScreen('game');
    myTheme = data.players[myPlayerId].word;
    const themeDisplay = document.getElementById('my-theme');
    themeDisplay.innerText = myTheme;
    themeDisplay.classList.add('blur-reveal');
    themeDisplay.classList.remove('revealed');
    themeDisplay.onclick = () => {
        themeDisplay.classList.remove('blur-reveal');
        themeDisplay.classList.add('revealed');
    };
}

// ------ Chat & QA Logics ------
import { addDoc as addDocCol } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-firestore.js";

async function sendChat(msg) {
    if(!msg || !currentRoomId) return;
    const colRef = collection(db, "rooms", currentRoomId, "messages");
    await addDocCol(colRef, {
        text: msg,
        senderId: myPlayerId,
        createdAt: serverTimestamp()
    });
}

function listenChat(roomId) {
    if(unsubscribeChat) unsubscribeChat();
    const colRef = collection(db, "rooms", roomId, "messages");
    const q = query(colRef, orderBy("createdAt", "asc"));
    unsubscribeChat = onSnapshot(q, async (snapshots) => {
        const area = document.getElementById('chat-messages');
        area.innerHTML = "";
        const roomRef = doc(db, "rooms", currentRoomId);
        const rmSnap = await getDoc(roomRef);
        const players = rmSnap.data().players;

        snapshots.forEach(s => {
            const d = s.data();
            const div = document.createElement('div');
            div.className = "msg";
            const pName = players[d.senderId] ? players[d.senderId].name : "Unknown";
            div.innerHTML = `<span class="sender">${pName}</span> ${d.text}`;
            area.appendChild(div);
        });
        area.scrollTop = area.scrollHeight;
    });
}

document.getElementById('btn-send-chat').addEventListener('click', () => {
    const input = document.getElementById('chat-input');
    sendChat(input.value);
    input.value = "";
});

async function sendQa(qText) {
    if(!qText || !currentRoomId) return;
    const colRef = collection(db, "rooms", currentRoomId, "questions");
    await addDocCol(colRef, {
        questionText: qText,
        answers: [],
        askerId: myPlayerId,
        createdAt: serverTimestamp()
    });
}

function listenQa(roomId) {
    if(unsubscribeQa) unsubscribeQa();
    const colRef = collection(db, "rooms", roomId, "questions");
    const q = query(colRef, orderBy("createdAt", "asc"));
    unsubscribeQa = onSnapshot(q, async (snapshots) => {
        const area = document.getElementById('qa-messages');
        area.innerHTML = "";
        const roomRef = doc(db, "rooms", currentRoomId);
        const rmSnap = await getDoc(roomRef);
        const players = rmSnap.data().players;

        snapshots.forEach(s => {
            const d = s.data();
            const div = document.createElement('div');
            div.className = "qa-item";
            const asker = players[d.askerId] ? players[d.askerId].name : "Unknown";
            
            let answersHtml = d.answers.map(ans => `<div><span class="sender">${players[ans.userId]?.name}</span>: ${ans.text}</div>`).join('');
            
            div.innerHTML = `
                <div class="qa-q">${asker}の質問: ${d.questionText}</div>
                <div class="qa-a">${answersHtml}</div>
                <div class="qa-actions">
                    <input type="text" id="ans-input-${s.id}" placeholder="回答..." class="input-light" style="padding:0.25rem; margin:0; font-size:0.8rem;">
                    <button class="btn secondary small" onclick="window.submitAnswer('${s.id}')">答える</button>
                </div>
            `;
            area.appendChild(div);
        });
        area.scrollTop = area.scrollHeight;
    });
}

window.submitAnswer = async (qId) => {
    const input = document.getElementById(`ans-input-${qId}`);
    const text = input.value;
    if(!text) return;
    const qRef = doc(db, "rooms", currentRoomId, "questions", qId);
    const snap = await getDoc(qRef);
    if(snap.exists()) {
        const ansArr = snap.data().answers || [];
        ansArr.push({ userId: myPlayerId, text: text });
        await updateDoc(qRef, { answers: ansArr });
    }
};

document.getElementById('btn-send-question').addEventListener('click', () => {
    const input = document.getElementById('qa-input-question');
    sendQa(input.value);
    input.value = "";
});

// Tabs
document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(btn.getAttribute('data-target')).classList.add('active');
    });
});

// ------ Voting Logics ------
document.getElementById('btn-vote-phase').addEventListener('click', async () => {
    if(isHost) {
        const roomRef = doc(db, "rooms", currentRoomId);
        await updateDoc(roomRef, { status: 'voting' });
    }
});

function startVotingUI(data) {
    switchScreen('vote');
    const ul = document.getElementById('vote-players');
    ul.innerHTML = "";
    Object.keys(data.players).forEach(pId => {
        if(pId === myPlayerId) return; // Cannot vote yourself
        const li = document.createElement('li');
        li.innerText = data.players[pId].name;
        li.style.cursor = 'pointer';
        li.onclick = () => submitVote(pId);
        ul.appendChild(li);
    });
}

async function submitVote(targetId) {
    const roomRef = doc(db, "rooms", currentRoomId);
    const snap = await getDoc(roomRef);
    const { players } = snap.data();
    
    players[targetId].votes += 1;
    players[myPlayerId].votedFor = targetId;

    await updateDoc(roomRef, { players });

    const updatedSnap = await getDoc(roomRef);
    const updatedPlayers = updatedSnap.data().players;
    
    // Check if everyone voted
    let allVoted = true;
    Object.keys(updatedPlayers).forEach(id => {
        if(!updatedPlayers[id].votedFor) allVoted = false;
    });

    if (allVoted) {
        await updateDoc(roomRef, { status: 'finished' });
    } else {
        alert("投票しました。全員の投票を待っています...");
        document.getElementById('vote-players').innerHTML = "<p>他のプレイヤーを待機中...</p>";
    }
}

function showResultUI(data) {
    switchScreen('result');
    const { players, themeData } = data;
    
    document.getElementById('result-citizen-theme').innerText = themeData.citizen;
    document.getElementById('result-wolf-theme').innerText = themeData.wolf;

    const list = document.getElementById('result-players');
    list.innerHTML = "";

    let wolfId = null;
    let maxVotes = 0;
    let mostVotedId = null;

    Object.keys(players).forEach(id => {
        if (players[id].role === 'wolf') wolfId = id;
        if (players[id].votes > maxVotes) {
            maxVotes = players[id].votes;
            mostVotedId = id;
        }
    });

    const isWolfVotedOut = (mostVotedId === wolfId);
    const title = document.getElementById('result-title');
    if (isWolfVotedOut) {
        title.innerText = "市民の勝利！";
        title.style.color = "#4ade80"; // green
    } else {
        title.innerText = "ワードウルフの勝利！";
        title.style.color = "#ef4444"; // red
    }

    Object.keys(players).forEach(id => {
        const p = players[id];
        const isWolf = (id === wolfId);
        const li = document.createElement('li');
        li.innerHTML = `
            <span>${p.name} ${isWolf ? '<b style="color:var(--secondary-color)">(ウルフ)</b>' : '(市民)'}</span>
            <span>得票: ${p.votes}</span>
        `;
        list.appendChild(li);
    });
}

document.getElementById('btn-back-home').addEventListener('click', () => {
    // Reset state and reload
    window.location.reload();
});

document.getElementById('btn-leave-lobby').addEventListener('click', () => {
    window.location.reload();
});

// Start
initFirebase();
