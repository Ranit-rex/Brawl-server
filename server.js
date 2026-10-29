const express = require("express");
const http = require("http");
const crypto = require("crypto");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 10000;

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  transports: ["websocket", "polling"],
  pingInterval: 10000,
  pingTimeout: 20000,
  connectTimeout: 20000,
  maxHttpBufferSize: 1e6
});

const rooms = new Map();
const waitingPlayers = new Map();
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
    uptime: Math.floor(process.uptime())
  });
});

function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";

  for (let i = 0; i < 6; i++) {
    code += chars[crypto.randomInt(0, chars.length)];
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

function emitError(socket, message) {
  socket.emit("roomError", { message });
}

function clearWaiting(socketId) {
  waitingPlayers.delete(socketId);
}

function getRoom(socket) {
  const code = socketRoom.get(socket.id);
  return code ? rooms.get(code) : null;
}

function playersList(room) {
  return [...room.players.values()].map(p => ({
    id: p.id,
    name: p.name,
    uid: p.uid,
    role: p.role
  }));
}

function leaveRoom(socket, reason = "left") {
  clearWaiting(socket.id);

  const code = socketRoom.get(socket.id);
  if (!code) return;

  socketRoom.delete(socket.id);

  const room = rooms.get(code);
  if (!room) return;

  const departing = room.players.get(socket.id);

  room.players.delete(socket.id);
  socket.leave(code);

  socket.to(code).emit("playerLeft", {
    roomCode: code,
    reason,
    name: departing ? departing.name : "Opponent"
  });

  if (room.players.size === 0) {
    rooms.delete(code);
    return;
  }

  room.status = "waiting";
  room.state = null;
  room.lastGuestInput = null;

  for (const player of room.players.values()) {
    player.socket.emit("roomWaiting", {
      roomCode: code,
      role: player.role,
      status: "waiting",
      message: "Opponent left. Waiting for another player."
    });
  }
}

function addPlayer(socket, room, payload, role) {
  const player = {
    id: socket.id,
    socket,
    name: safeName(payload.name),
    uid: String(payload.uid || "").slice(0, 128),
    role
  };

  room.players.set(socket.id, player);
  socketRoom.set(socket.id, room.code);
  socket.join(room.code);

  return player;
}

function readyRoom(room) {
  if (!room || room.players.size !== 2) return;
  if (room.status === "matched") return;

  const host = [...room.players.values()]
    .find(p => p.role === "host");

  const guest = [...room.players.values()]
    .find(p => p.role === "guest");

  if (!host || !guest) return;

  room.status = "matched";

  const makePayload = player => ({
    roomCode: room.code,
    role: player.role,
    yourSlot: player.role === "host" ? 1 : 2,
    hostName: host.name,
    guestName: guest.name,
    hostUid: host.uid,
    guestUid: guest.uid,
    players: playersList(room)
  });

  host.socket.emit("matchReady", makePayload(host));
  guest.socket.emit("matchReady", makePayload(guest));

  console.log("Match ready:", room.code);
}

function createRoomFor(hostSocket, guestSocket, hostData, guestData) {
  const code = uniqueCode();

  const room = {
    code,
    status: "waiting",
    players: new Map(),
    state: null,
    lastGuestInput: null,
    createdAt: Date.now()
  };

  rooms.set(code, room);

  addPlayer(hostSocket, room, hostData || {}, "host");

  if (guestSocket) {
    addPlayer(guestSocket, room, guestData || {}, "guest");
    readyRoom(room);
  } else {
    hostSocket.emit("roomWaiting", {
      roomCode: code,
      role: "host",
      status: "waiting",
      message: "Room ready. Share this code with your opponent."
    });
  }

  return room;
}

io.on("connection", socket => {
  console.log("Connected:", socket.id);

  socket.emit("serverReady", {
    status: "ok",
    socketId: socket.id
  });

  // CREATE PRIVATE ROOM
  socket.on("createRoom", (payload = {}) => {
    leaveRoom(socket, "changed-room");

    createRoomFor(socket, null, payload, null);
  });

  // JOIN PRIVATE ROOM
  socket.on("joinRoom", (payload = {}) => {
    const code = String(
      payload.roomCode || payload.code || ""
    ).trim().toUpperCase();

    if (!/^[A-HJ-NP-Z2-9]{6}$/.test(code)) {
      emitError(socket, "Enter a valid 6-character room code.");
      return;
    }

    const room = rooms.get(code);

    if (!room) {
      emitError(socket, "Room not found. Check the code and try again.");
      return;
    }

    const uid = String(payload.uid || "");

    const host = [...room.players.values()]
      .find(p => p.role === "host");

    if (host && uid && host.uid && host.uid === uid) {
      emitError(socket, "Use another account or device to join this room.");
      return;
    }

    if (room.status !== "waiting" || room.players.size >= 2) {
      emitError(socket, "Room is full or the match has already started.");
      return;
    }

    leaveRoom(socket, "changed-room");

    // Recheck after leaving any previous room.
    const currentRoom = rooms.get(code);

    if (
      !currentRoom ||
      currentRoom.status !== "waiting" ||
      currentRoom.players.size >= 2
    ) {
      emitError(socket, "Room is no longer available. Try again.");
      return;
    }

    addPlayer(socket, currentRoom, payload, "guest");
    readyRoom(currentRoom);
  });

  // RANDOM MATCHMAKING
  socket.on("findMatch", (payload = {}) => {
    leaveRoom(socket, "matchmaking");

    let otherSocket = null;
    let otherPayload = null;

    for (const [id, queued] of waitingPlayers) {
      if (id === socket.id) continue;

      const candidate = io.sockets.sockets.get(id);

      if (
        candidate &&
        candidate.connected &&
        !socketRoom.has(id)
      ) {
        otherSocket = candidate;
        otherPayload = queued;
        waitingPlayers.delete(id);
        break;
      }

      waitingPlayers.delete(id);
    }

    if (otherSocket) {
      createRoomFor(
        otherSocket,
        socket,
        otherPayload || {},
        payload
      );
    } else {
      waitingPlayers.set(socket.id, {
        name: safeName(payload.name),
        uid: String(payload.uid || "").slice(0, 128)
      });

      socket.emit("matchmakingWaiting", {
        message: "Searching for an opponent..."
      });
    }
  });

  // CANCEL SEARCH
  socket.on("cancelMatchmaking", () => {
    clearWaiting(socket.id);

    socket.emit("matchmakingCancelled", {
      message: "Matchmaking cancelled."
    });
  });

  // LOW-OVERHEAD PING CHECK
  socket.on("pingCheck", payload => {
    const token = Number(payload && payload.token);

    socket.emit("pingCheckResult", {
      token: Number.isFinite(token) ? token : 0,
      serverTime: Date.now()
    });
  });

  // GUEST INPUTS -> HOST
  socket.on("playerInput", payload => {
    const room = getRoom(socket);

    if (!room || room.status !== "matched") return;

    const player = room.players.get(socket.id);

    if (!player || player.role !== "guest") return;

    const raw =
      payload && payload.input && typeof payload.input === "object"
        ? payload.input
        : {};

    const input = {};

    for (const key of ["l", "r", "j", "p", "k", "b", "s", "z", "d"]) {
      input[key] = !!raw[key];
    }

    // Preserve optional timing data if the client sends it.
    for (const key of ["pingToken", "clientTs"]) {
      const n = Number(raw[key]);
      if (Number.isFinite(n)) input[key] = n;
    }

    room.lastGuestInput = input;

    socket.to(room.code).emit("opponentInput", {
      input,
      sentAt: Date.now()
    });
  });

  // HOST GAME STATE -> GUEST
  socket.on("gameState", payload => {
    const room = getRoom(socket);

    if (!room || room.status !== "matched") return;

    const player = room.players.get(socket.id);

    if (!player || player.role !== "host") return;

    const state = payload && payload.state;

    if (!state || typeof state !== "object") return;

    // Do not mutate the client's original state object.
    const safeState = { ...state };

    if (
      room.lastGuestInput &&
      room.lastGuestInput.pingToken
    ) {
      safeState.echoToken = room.lastGuestInput.pingToken;
    }

    room.state = safeState;

    socket.to(room.code).emit("gameState", {
      state: safeState,
      sentAt: Date.now()
    });
  });

  // MATCH FINISHED
  socket.on("matchResult", payload => {
    const room = getRoom(socket);

    if (!room || room.status !== "matched") return;

    const player = room.players.get(socket.id);

    if (!player || player.role !== "host") return;

    const winnerRole =
      payload && (
        payload.winnerRole === "host" ||
        payload.winnerRole === "guest"
      )
        ? payload.winnerRole
        : null;

    room.status = "completed";

    const host = [...room.players.values()]
      .find(p => p.role === "host");

    const guest = [...room.players.values()]
      .find(p => p.role === "guest");

    io.to(room.code).emit("matchResult", {
      roomCode: room.code,
      winnerRole,
      hostName: host ? host.name : "Host",
      guestName: guest ? guest.name : "Guest",
      reason: String(
        (payload && payload.reason) || "completed"
      ).slice(0, 40)
    });
  });

  // PLAYER FORFEITS
  socket.on("forfeit", () => {
    const room = getRoom(socket);

    if (!room || room.status !== "matched") return;

    const player = room.players.get(socket.id);
    if (!player) return;

    room.status = "completed";

    const winnerRole =
      player.role === "host" ? "guest" : "host";

    const host = [...room.players.values()]
      .find(p => p.role === "host");

    const guest = [...room.players.values()]
      .find(p => p.role === "guest");

    io.to(room.code).emit("matchResult", {
      roomCode: room.code,
      winnerRole,
      hostName: host ? host.name : "Host",
      guestName: guest ? guest.name : "Guest",
      reason: "forfeit"
    });
  });

  // LEAVE ROOM
  socket.on("leaveRoom", () => {
    leaveRoom(socket, "left");
  });

  // DISCONNECT CLEANUP
  socket.on("disconnect", reason => {
    console.log("Disconnected:", socket.id, reason);
    leaveRoom(socket, "disconnected");
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `NeoWarriors multiplayer server listening on ${PORT}`
  );
});
