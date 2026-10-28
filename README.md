NeoWarriors Multiplayer Server

Real-time multiplayer server for the NeoWarriors game.

Requirements

- Node.js
- npm

Run Locally

Install dependencies:

npm install

Start the server:

npm start

The server runs on the port specified by the PORT environment variable, or port 3000 by default.

Health Check

Open "/health" on the deployed server to verify that the server is running.

Multiplayer Events

Create a Room

Event: "createRoom"

Creates a room and returns a room code.

Join a Room

Event: "joinRoom"

Joins an existing room using its room code.

Match Ready

Event: "matchReady"

Notifies players when two players have joined the same room.

Player Left

Event: "playerLeft"

Notifies remaining players when someone leaves.
