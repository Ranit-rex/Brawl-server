const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
cors: {
origin: "*",
methods: ["GET", "POST"]
}
});

const PORT = process.env.PORT || 3000;
const rooms = new Map();

app.get("/", (req, res) => {
res.send("NeoWarriors Multiplayer Server is Running!");
});

app.get("/health", (req, res) => {
res.json({ status: "ok", game: "NeoWarriors" });
});

io.on("connection", (socket) => {
console.log("Player connected:", socket.id);

socket.on("createRoom", (callback) => {
const roomCode = Math.random()
.toString(36)
.substring(2, 8)
.toUpperCase();

rooms.set(roomCode, {
  players: [socket.id],
  createdAt: Date.now()
});

socket.join(roomCode);

if (typeof callback === "function") {
  callback({
    success: true,
    roomCode,
    playerNumber: 1
  });
}

console.log("Room created:", roomCode);

});

socket.on("joinRoom", (roomCode, callback) => {
roomCode = String(roomCode || "").trim().toUpperCase();

const room = rooms.get(roomCode);

if (!room) {
  if (typeof callback === "function") {
    callback({ success: false, message: "Room not found" });
  }
  return;
}

if (room.players.length >= 2) {
  if (typeof callback === "function") {
    callback({ success: false, message: "Room is full" });
  }
  return;
}

if (room.players.includes(socket.id)) {
  if (typeof callback === "function") {
    callback({ success: false, message: "Already in room" });
  }
  return;
}

room.players.push(socket.id);
socket.join(roomCode);

if (typeof callback === "function") {
  callback({
    success: true,
    roomCode,
    playerNumber: 2
  });
}

io.to(roomCode).emit("playerJoined", {
  playerCount: room.players.length
});

if (room.players.length === 2) {
  io.to(roomCode).emit("matchReady", {
    roomCode,
    players: room.players
  });
}

console.log("Player joined room:", roomCode);

});

socket.on("leaveRoom", (roomCode) => {
leaveRoom(socket, roomCode);
});

socket.on("disconnect", () => {
console.log("Player disconnected:", socket.id);

for (const roomCode of rooms.keys()) {
  leaveRoom(socket, roomCode);
}

});
});

function leaveRoom(socket, roomCode) {
roomCode = String(roomCode || "").trim().toUpperCase();

const room = rooms.get(roomCode);

if (!room || !room.players.includes(socket.id)) {
return;
}

room.players = room.players.filter(
(playerId) => playerId !== socket.id
);

socket.leave(roomCode);

io.to(roomCode).emit("playerLeft", {
playerCount: room.players.length
});

if (room.players.length === 0) {
rooms.delete(roomCode);
}
}

server.listen(PORT, "0.0.0.0", () => {
console.log("NeoWarriors server running on port ${PORT}");
});
