// index.js
// ============================
// Complete Multiplayer Blackjack WebSocket Server
// ============================

import express from "express";
import http from "http";
import { WebSocketServer } from "ws";

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 8080;

// Rooms werden hier gespeichert
const rooms = new Map();

function makeDeck() {
  const suits = ["♠", "♥", "♦", "♣"];
  const ranks = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
  const deck = [];
  for (let i = 0; i < 6; i++) {
    for (const s of suits)
      for (const r of ranks)
        deck.push({ id: `${i}-${s}${r}`, suit: s, rank: r });
  }
  // Shuffle
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function broadcast(room) {
  // Create a clean copy without WebSocket connections and timers
  const cleanRoom = {
    code: room.code,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      stack: p.stack,
      bet: p.bet,
      insuranceBet: p.insuranceBet,
      ready: p.ready,
      cards: p.cards,
      status: p.status,
      result: p.result
    })),
    dealer: room.dealer,
    phase: room.phase,
    turnIdx: room.turnIdx
  };
  
  const data = JSON.stringify({ type: "state", state: cleanRoom });
  room.players.forEach((p) => {
    try {
      p.ws.send(data);
    } catch (err) {
      console.error(`Failed to send to ${p.name}:`, err.message);
    }
  });
}

function calculateValue(cards) {
  let sum = 0;
  let aces = 0;
  for (const c of cards) {
    if (c.rank === "A") {
      aces++;
      sum += 11;
    } else if (["J", "Q", "K"].includes(c.rank)) {
      sum += 10;
    } else {
      sum += parseInt(c.rank);
    }
  }
  while (sum > 21 && aces > 0) {
    sum -= 10;
    aces--;
  }
  return sum;
}

function startRound(room) {
  // Check if shoe needs reshuffling (less than 52 cards left)
  if (room.shoe.length < 52) {
    console.log(`🔀 Reshuffling deck in room ${room.code}`);
    room.shoe = makeDeck();
    room.discard = [];
    
    // Send shuffle notification
    room.phase = "SHUFFLING";
    broadcast(room);
    
    // Wait 2 seconds for shuffle animation
    setTimeout(() => startDealingPhase(room), 2000);
  } else {
    startDealingPhase(room);
  }
}

function startDealingPhase(room) {
  room.phase = "DEALING";
  room.dealer.cards = [];
  room.players.forEach((p) => {
    p.cards = [];
    p.status = "";
    p.result = null;
  });

  // Deal sequence: Player1, Dealer, Player2, Dealer (etc)
  const seq = [];
  room.players.forEach((p) => seq.push({ to: p }));
  seq.push({ to: "D" });
  room.players.forEach((p) => seq.push({ to: p }));
  seq.push({ to: "D" });

  let i = 0;
  function step() {
    if (i >= seq.length) {
      // Check if dealer shows Ace for insurance
      if (room.dealer.cards[0]?.rank === "A") {
        room.phase = "INSURANCE";
        room.turnIdx = 0;
        broadcast(room);
        // Skip to player phase after 5 seconds if no insurance
        setTimeout(() => {
          if (room.phase === "INSURANCE") {
            room.phase = "PLAYER";
            room.turnIdx = 0;
            broadcast(room);
            startTurnTimer(room);
          }
        }, 5000);
      } else {
        room.phase = "PLAYER";
        room.turnIdx = 0;
        broadcast(room);
        startTurnTimer(room);
      }
      return;
    }
    const s = seq[i++];
    if (s.to === "D")
      room.dealer.cards.push(room.shoe.shift());
    else s.to.cards.push(room.shoe.shift());
    broadcast(room);
    setTimeout(step, 450);
  }
  step();
}

function startTurnTimer(room) {
  // Clear any existing timer
  if (room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }

  // Check if we're still in PLAYER phase
  if (room.phase !== "PLAYER" || room.turnIdx < 0) {
    console.log("⏱️ Timer not started: not in PLAYER phase or invalid turnIdx");
    return;
  }

  const current = room.players[room.turnIdx];
  if (!current) {
    console.log("⏱️ Timer not started: no current player");
    return;
  }

  console.log(`⏱️ Timer started for ${current.name} (20 seconds)`);
  
  room.turnTimer = setTimeout(() => {
    console.log(`⏰ Timeout for player ${current.name}`);
    
    // Double-check we're still in the right phase and it's still this player's turn
    if (room.phase === "PLAYER" && room.players[room.turnIdx] === current) {
      if (current.status !== "DONE" && current.status !== "BUST") {
        current.status = "TIMEOUT";
        nextTurn(room);
        broadcast(room);
      }
    }
  }, 20000); // 20 seconds
}

function nextTurn(room) {
  // Clear the timer
  if (room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
    console.log("⏱️ Timer cleared");
  }

  // Find next player who hasn't finished
  let nextIdx = -1;
  for (let i = room.turnIdx + 1; i < room.players.length; i++) {
    const p = room.players[i];
    if (p.status !== "DONE" && p.status !== "BUST" && p.status !== "TIMEOUT") {
      nextIdx = i;
      break;
    }
  }

  if (nextIdx === -1) {
    // All players done, dealer's turn
    console.log("🎩 All players done, dealer's turn");
    room.phase = "DEALER";
    room.turnIdx = -1;
    broadcast(room);
    setTimeout(() => dealerTurn(room), 1000);
  } else {
    // Next player's turn
    room.turnIdx = nextIdx;
    console.log(`👉 Next turn: ${room.players[nextIdx].name}`);
    broadcast(room);
    startTurnTimer(room);
  }
}

function dealerTurn(room) {
  const dealerValue = calculateValue(room.dealer.cards);
  
  // Dealer must draw to 17
  if (dealerValue < 17) {
    room.dealer.cards.push(room.shoe.shift());
    broadcast(room);
    setTimeout(() => dealerTurn(room), 800);
  } else {
    // Dealer done, evaluate results
    setTimeout(() => evaluateResults(room), 1000);
  }
}

function evaluateResults(room) {
  room.phase = "RESULT";
  const dealerValue = calculateValue(room.dealer.cards);
  const dealerBust = dealerValue > 21;
  const dealerBlackjack = room.dealer.cards.length === 2 && dealerValue === 21;

  room.players.forEach((player) => {
    const playerValue = calculateValue(player.cards);
    const playerBust = playerValue > 21;
    const isBlackjack = player.cards.length === 2 && playerValue === 21;

    // Handle insurance
    if (player.insuranceBet && dealerBlackjack) {
      player.stack += player.insuranceBet * 3; // Insurance pays 2:1
      console.log(`${player.name} insurance paid ${player.insuranceBet * 2}`);
    }

    if (playerBust) {
      player.result = "LOSE";
      player.status = "BUST";
    } else if (isBlackjack && dealerBlackjack) {
      player.result = "PUSH";
      player.status = "PUSH";
      player.stack += player.bet;
    } else if (isBlackjack) {
      player.result = "BLACKJACK";
      player.status = "BLACKJACK! 🎉";
      player.stack += Math.floor(player.bet * 2.5);
    } else if (dealerBust) {
      player.result = "WIN";
      player.status = "WIN!";
      player.stack += player.bet * 2;
    } else if (playerValue > dealerValue) {
      player.result = "WIN";
      player.status = "WIN!";
      player.stack += player.bet * 2;
    } else if (playerValue === dealerValue) {
      player.result = "PUSH";
      player.status = "PUSH";
      player.stack += player.bet;
    } else {
      player.result = "LOSE";
      player.status = "LOSE";
    }

    player.bet = 0;
    player.insuranceBet = 0;
    console.log(`${player.name}: ${player.status} (Value: ${playerValue})`);
  });

  broadcast(room);

  setTimeout(() => {
    room.phase = "LOBBY";
    room.turnIdx = -1;
    room.dealer.cards = [];
    room.players.forEach((p) => {
      p.cards = [];
      p.status = "";
      p.ready = false;
      p.result = null;
    });
    broadcast(room);
  }, 5000);
}

// ============================
// WebSocket setup
// ============================

wss.on("connection", (ws) => {
  let currentRoom = null;
  let self = null;

  ws.on("message", (msg) => {
    try {
      msg = JSON.parse(msg);
    } catch {
      return;
    }

    const { type, roomId, payload } = msg;

    // Player will einem Raum joinen oder neuen erstellen
    if (type === "join") {
      currentRoom =
        rooms.get(roomId) ||
        (rooms.set(roomId, {
          code: roomId,
          players: [],
          dealer: { cards: [] },
          shoe: makeDeck(),
          discard: [],
          turnIdx: -1,
          phase: "LOBBY",
          turnTimer: null,
        }),
        rooms.get(roomId));

      self = {
        id: Math.random().toString(36).slice(2, 9),
        name: payload?.name || "Player",
        stack: 5000,
        bet: 0,
        ready: false,
        cards: [],
        status: "",
        result: null,
        ws,
      };

      currentRoom.players.push(self);
      console.log(`✅ ${self.name} joined room ${roomId}`);
      broadcast(currentRoom);
      return;
    }

    if (!currentRoom || !self) return;

    if (type === "leave") {
      currentRoom.players = currentRoom.players.filter((p) => p !== self);
      console.log(`👋 ${self.name} left room ${currentRoom.code}`);
      
      // Clean up if no players left
      if (currentRoom.players.length === 0) {
        if (currentRoom.turnTimer) clearTimeout(currentRoom.turnTimer);
        rooms.delete(currentRoom.code);
        console.log(`🗑️  Room ${currentRoom.code} deleted (empty)`);
      } else {
        broadcast(currentRoom);
      }
      
      ws.close();
      return;
    }

    if (type === "ready") {
      self.ready = !!payload?.ready;
      console.log(`${self.name} ready: ${self.ready}`);
      broadcast(currentRoom);
      return;
    }

    if (type === "bet") {
      const v = payload?.value | 0;
      if (v > 0 && self.stack >= v) {
        self.stack -= v;
        self.bet += v;
        console.log(`${self.name} bet $${v} (total: $${self.bet})`);
        broadcast(currentRoom);
      }
      return;
    }

    if (type === "insurance") {
      if (currentRoom.phase === "INSURANCE" && self.stack >= self.bet / 2) {
        self.insuranceBet = self.bet / 2;
        self.stack -= self.insuranceBet;
        self.status = "INSURED";
        console.log(`${self.name} bought insurance for ${self.insuranceBet}`);
        broadcast(currentRoom);
      }
      return;
    }

    if (type === "start") {
      if (currentRoom.phase === "LOBBY") {
        const allReady = currentRoom.players.every((p) => p.ready && p.bet > 0);
        if (allReady) {
          console.log(`🎲 Starting game in room ${currentRoom.code}`);
          startRound(currentRoom);
        }
      }
      return;
    }

    // Spieleraktionen während der Player-Phase
    if (currentRoom.phase === "PLAYER") {
      if (type === "hit") {
        if (currentRoom.players[currentRoom.turnIdx] === self) {
          self.cards.push(currentRoom.shoe.shift());
          console.log(`${self.name} hit`);
          
          // Check for bust
          const value = calculateValue(self.cards);
          if (value > 21) {
            self.status = "BUST";
            console.log(`${self.name} busted with ${value}`);
            nextTurn(currentRoom);
          }
          
          broadcast(currentRoom);
        }
        return;
      }

      if (type === "stand") {
        if (currentRoom.players[currentRoom.turnIdx] === self) {
          self.status = "DONE";
          console.log(`${self.name} stand`);
          nextTurn(currentRoom);
          broadcast(currentRoom);
        }
        return;
      }

      if (type === "double") {
        if (
          currentRoom.players[currentRoom.turnIdx] === self &&
          self.cards.length === 2 &&
          self.stack >= self.bet
        ) {
          self.stack -= self.bet;
          self.bet *= 2;
          self.cards.push(currentRoom.shoe.shift());
          self.status = "DONE";
          console.log(`${self.name} doubled down`);
          
          // Check for bust
          const value = calculateValue(self.cards);
          if (value > 21) {
            self.status = "BUST";
            console.log(`${self.name} busted with ${value}`);
          }
          
          nextTurn(currentRoom);
          broadcast(currentRoom);
        }
        return;
      }
    }
  });

  ws.on("close", () => {
    if (currentRoom && self) {
      currentRoom.players = currentRoom.players.filter((p) => p !== self);
      console.log(`❌ ${self.name} disconnected from ${currentRoom.code}`);
      
      // If no players left, clean up room
      if (currentRoom.players.length === 0) {
        if (currentRoom.turnTimer) clearTimeout(currentRoom.turnTimer);
        rooms.delete(currentRoom.code);
        console.log(`🗑️  Room ${currentRoom.code} deleted (empty)`);
      } else {
        broadcast(currentRoom);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Blackjack WebSocket Server running on port ${PORT}`);
  console.log(`📡 WebSocket endpoint: ws://localhost:${PORT}`);
});