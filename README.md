# Connect-5 (Multiplayer Gomoku)

A two-player Connect-5 (Gomoku) game playable in the browser over a network. Each player enters their name, gets matched automatically, and takes turns placing pieces. First to get 5 in a row — horizontal, vertical, or diagonal — wins.

### Prerequisites

- [Node.js](https://nodejs.org/) v16 or later

### Setup

```bash
# Install the WebSocket dependency
npm install

# Start the server (default port 3000)
node server.js
```

The terminal will print:
```
Connect-5 running → http://localhost:3000
```

### Playing locally (same machine)

Open two browser tabs at `http://localhost:3000`, enter a different name in each tab, and the game starts automatically.

### Playing over a network (two devices)

1. Find your machine's local IP address:
   - **macOS / Linux:** run `ipconfig getifaddr en0` (or `ifconfig | grep "inet "`)
   - **Windows:** run `ipconfig` and look for **IPv4 Address**

2. Both players open `http://<your-ip>:3000` (e.g. `http://192.168.1.42:3000`)

3. Each player enters their name and clicks **Find Game** — the first two to join are matched together.

### Custom port

```bash
PORT=8080 node server.js
```

### Files

- `index.html` — frontend: lobby, waiting room, and game board
- `server.js` — Node.js HTTP + WebSocket server (serves the page and handles all game logic)
- `package.json` — dependencies (`ws`)
