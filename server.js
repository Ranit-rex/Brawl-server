const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  transports: ["websocket", "polling"]
});

const PORT = process.env.PORT || 10000;
const rooms = new Map();
const waitingPlayers = new Set();
const socketRoom = new Map();

app.get("/", (_req, res) => {
  res.json({
    status: "ok",
    game: "NeoWarriors",
    multiplayer: true
  });
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    game: "NeoWarriors"
  });
});

function makeCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";

  for (let i = 0; i < 6; i++) {
    code += alphabet[crypto.randomInt(0, alphabet.length)];
  }

  return code;
}

function uniqueCode() {
  let code;

  do {
    code = makeCode();
  } while (rooms.has(code));

  return code;
}

function safeName(value) {
  return String(value || "Fighter")
    .replace(/[<>]/g, "")
    .trim()
    .slice(0, 18) || "Fighter";
}

function publicPlayers(room) {
  return [...room.players.values()].map((player, index) => ({
    id: player.id,
    name: player.name,
    slot: index + 1
  }));
}

function sendRoomError(socket, message) {
  socket.emit("roomError", { message });
}

function removeFromQueue(socket) {
  waitingPlayers.delete(socket.id);
}

function detachSocket(socket, reason = "left") {
  removeFromQueue(socket);

  const code = socketRoom.get(socket.id);

  if (!code) return;

  socketRoom.delete(socket.id);

  const room = rooms.get(code);

  if (!room) return;

  room.players.delete(socket.id);
  socket.leave(code);

  socket.to(code).emit("playerLeft", {
    roomCode: code,
    reason
  });

  if (room.players.size === 0) {
    rooms.delete(code);
    return;
  }

  room.status = "waiting";
  room.state = null;

  room.players.forEach((player) => {
    player.socket.emit("roomWaiting", {
      roomCode: code,
      players: publicPlayers(room),
      message: "Opponent left. Waiting for another player."
    });
  });
}

function joinSocketRoom(socket, room, name) {
  room.players.set(socket.id, {
    id: socket.id,
    name: safeName(name),
    socket
  });

  socketRoom.set(socket.id, room.code);
  socket.join(room.code);
}

function startRoom(room) {
  if (!room || room.players.size !== 2 || room.status === "matched") {
    return;
  }

  room.status = "matched";

  const players = publicPlayers(room);

  room.players.forEach((player, index) => {
    player.socket.emit("matchReady", {
      roomCode: room.code,
      players,
      yourSlot: index + 1
    });
  });
}

io.on("connection", (socket) => {
  console.log("Player connected:", socket.id);

  socket.emit("serverReady", {
    status: "ok",
    socketId: socket.id
  });

  // CREATE PRIVATE ROOM
  socket.on("createRoom", (payload = {}) => {
    detachSocket(socket, "changed-room");

    const code = uniqueCode();

    const room = {
      code,
      status: "waiting",
      players: new Map(),
      state: null,
      createdAt: Date.now()
    };

    rooms.set(code, room);

    joinSocketRoom(socket, room, payload.name);

    socket.emit("roomCreated", {
      roomCode: code,
      players: publicPlayers(room),
      status: "waiting"
    });

    console.log("Room created:", code);
  });

  // JOIN PRIVATE ROOM
  socket.on("joinRoom", (payload = {}) => {
    const code = String(
      payload.roomCode || payload.code || ""
    ).trim().toUpperCase();

    if (!/^[A-HJ-NP-Z2-9]{6}$/.test(code)) {
      sendRoomError(
        socket,
        "Enter a valid 6-character room code."
      );
      return;
    }

    const room = rooms.get(code);

    if (!room) {
      sendRoomError(
        socket,
        "Room not found. Check the code and try again."
      );
      return;
    }

    if (room.players.has(socket.id)) {
      socket.emit("roomJoined", {
        roomCode: code,
        players: publicPlayers(room),
        status: room.status
      });

      if (room.players.size === 2) {
        startRoom(room);
      }

      return;
    }

    if (room.players.size >= 2 || room.status === "matched") {
      sendRoomError(socket, "Room is full.");
      return;
    }

    detachSocket(socket, "changed-room");

    joinSocketRoom(socket, room, payload.name);

    socket.emit("roomJoined", {
      roomCode: code,
      players: publicPlayers(room),
      status: room.status
    });

    if (room.players.size === 2) {
      startRoom(room);
    } else {
      socket.to(code).emit("playerJoined", {
        roomCode: code,
        players: publicPlayers(room)
      });
    }

    console.log("Player joined room:", code);
  });

  // RANDOM MATCHMAKING
  socket.on("findMatch", (payload = {}) => {
    detachSocket(socket, "matchmaking");

    let target = null;

    for (const id of waitingPlayers) {
      if (id !== socket.id) {
        const other = io.sockets.sockets.get(id);

        if (
          other &&
          other.connected &&
          !socketRoom.has(id)
        ) {
          target = other;
          break;
        }
      }
    }

    if (target) {
      removeFromQueue(target);

      const code = uniqueCode();

      const room = {
        code,
        status: "waiting",
        players: new Map(),
        state: null,
        createdAt: Date.now()
      };

      rooms.set(code, room);

      joinSocketRoom(
        target,
        room,
        target.data.playerName || "Fighter"
      );

      joinSocketRoom(socket, room, payload.name);

      startRoom(room);

      console.log("Match found:", code);
    } else {
      socket.data.playerName = safeName(payload.name);
      waitingPlayers.add(socket.id);

      socket.emit("matchmakingWaiting", {
        message: "Searching for an opponent…"
      });

      console.log("Searching for opponent:", socket.id);
    }
  });

  // CANCEL MATCHMAKING
  socket.on("cancelMatchmaking", () => {
    removeFromQueue(socket);

    socket.emit("matchmakingCancelled", {
      message: "Matchmaking cancelled."
    });
  });

  // SEND PLAYER CONTROLS TO OPPONENT
  socket.on("playerInput", (payload = {}) => {
    const code = socketRoom.get(socket.id);
    const room = code && rooms.get(code);

    if (!room || room.status !== "matched") return;

    const input =
      payload.input && typeof payload.input === "object"
        ? payload.input
        : {};

    const clean = {};

    for (const key of [
      "l", "r", "j", "p", "k", "b", "s", "z", "d"
    ]) {
      clean[key] = !!input[key];
    }

    socket.to(code).emit("opponentInput", {
      input: clean,
      sentAt: Date.now()
    });
  });

  // SHARE GAME STATE
  socket.on("gameState", (payload = {}) => {
    const code = socketRoom.get(socket.id);
    const room = code && rooms.get(code);

    if (!room || room.status !== "matched") return;

    // Slot 1 is the authoritative game-state sender.
    const player = room.players.get(socket.id);

    if (
      !player ||
      [...room.players.keys()][0] !== socket.id
    ) {
      return;
    }

    const state = payload.state;

    if (!state || typeof state !== "object") return;

    room.state = state;

    socket.to(code).emit("gameState", {
      state,
      sentAt: Date.now()
    });
  });

  // MATCH RESULT
  socket.on("matchResult", (payload = {}) => {
    const code = socketRoom.get(socket.id);
    const room = code && rooms.get(code);

    if (!room) return;

    io.to(code).emit("matchResult", {
      winner: safeName(payload.winner),
      score: String(payload.score || "").slice(0, 20),
      reason: String(payload.reason || "completed").slice(0, 40)
    });
  });

  // LEAVE ROOM
  socket.on("leaveRoom", () => {
    detachSocket(socket, "left");
  });

  // PLAYER DISCONNECTED
  socket.on("disconnect", () => {
    console.log("Player disconnected:", socket.id);
    detachSocket(socket, "disconnected");
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `NeoWarriors multiplayer server listening on ${PORT}`
  );
});
