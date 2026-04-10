# Hill Climb Multiplayer Racing

A multiplayer car racing game for iOS inspired by *Hill Climb Racing*. Up to
four players race at the same time on the same procedurally-generated hilly
track. Each client simulates its own car physics locally against a
deterministic terrain seed; a small Node.js server handles matchmaking and
relays car positions between clients.

```
car-racing/
├── ios/
│   ├── project.yml                    # XcodeGen spec (recommended)
│   └── RacingGame/
│       ├── RacingGameApp.swift        # @main entry point
│       ├── GameCoordinator.swift      # owns the network + app screen
│       ├── Info.plist
│       ├── Assets.xcassets/
│       ├── Model/GameModels.swift
│       ├── Network/NetworkClient.swift
│       ├── Views/
│       │   ├── RootView.swift
│       │   ├── MenuView.swift
│       │   ├── LobbyView.swift
│       │   ├── GameContainerView.swift
│       │   └── ResultsView.swift
│       └── Game/
│           ├── SeededRNG.swift
│           ├── Terrain.swift
│           ├── Car.swift
│           └── GameScene.swift
├── server/
│   ├── package.json
│   ├── server.js                      # HTTP + WebSocket entry point
│   └── racing.js                      # matchmaking + state relay
└── docs/
    └── PROTOCOL.md                    # WebSocket message protocol
```

## 1 — Run the server

```bash
cd server
npm install
node server.js
# car-racing server listening on http://localhost:9753
#   WebSocket: ws://localhost:9753/ws/racing
```

To expose it to phones on your Wi-Fi, find your Mac's LAN IP
(`ipconfig getifaddr en0`) and use `ws://<your-ip>:9753/ws/racing` as the
server URL in the iOS app.

Environment variables:

- `PORT=8080 node server.js` — change the listening port.

## 2 — Build the iOS app

### Option A: XcodeGen (recommended)

```bash
brew install xcodegen
cd ios
xcodegen generate
open RacingGame.xcodeproj
```

Then in Xcode:

1. Select a development team under **Signing & Capabilities** (or run on the
   simulator, which doesn't need signing).
2. Pick an iPhone simulator (iOS 16+) or a real device.
3. Press **⌘R** to build and run.

### Option B: Create the project manually in Xcode

If you don't want to install XcodeGen:

1. **File → New → Project → iOS → App**.
2. Product name: `RacingGame`, Interface: **SwiftUI**, Language: **Swift**,
   Minimum Deployment: iOS 16.0.
3. Delete the generated `ContentView.swift` and `RacingGameApp.swift`.
4. Drag the `ios/RacingGame/` folder from Finder into the Xcode project
   navigator. Choose **Create groups** and **Copy items if needed**.
5. In **Build Phases → Link Binary With Libraries**, add `SpriteKit.framework`.
6. Replace the default `Info.plist` with the one provided, or copy its keys
   (especially `NSAppTransportSecurity` and `NSLocalNetworkUsageDescription`).
7. Set the device orientation to **Landscape Left** + **Landscape Right**.
8. Build and run.

## 3 — Play

1. Launch two or more instances (simulator + device, or two devices).
2. Each one enters a driver name.
3. Tap **Find Race**. Once two or more players are in the lobby, a 5-second
   countdown begins; the race starts automatically. Four players skips the
   countdown entirely.
4. During the race:
   - **Right half of the screen** = gas
   - **Left half of the screen** = brake (or reverse)
   - In the air, the gas/brake also tilts the car for flip recovery.
5. First to cross the finish line wins. Any players still on the track when
   everyone else has finished are ranked by distance.

## How it works

### Deterministic terrain

The server picks a 32-bit seed and sends it to every client at race start.
`SeededRNG.swift` (Mulberry32) + a sum-of-sines generator in `Terrain.swift`
produce the same hilly path on every device, so physics stays consistent
without the server having to describe every hill byte-by-byte.

### Network model

- Each client is authoritative for its own car.
- Each client publishes its `(x, y, rotation, wheelRotation)` at ~20 Hz.
- The server broadcasts the combined world snapshot to everyone at 20 Hz.
- Remote cars on the receiving end are rendered as interpolated kinematic
  bodies (no physics collisions with other players) to avoid desyncs.
- The server calls the race over once every player has either crossed the
  finish line or disconnected (or after a 3-minute wall-clock cap).

See `docs/PROTOCOL.md` for the full message schema.

### Car physics

`Car.swift` uses SpriteKit's built-in physics: a rectangular chassis + two
circular wheels connected by `SKPhysicsJointPin`. Gas and brake apply torque
to the wheels; an in-air tilt assist lets players rotate mid-jump. It's the
same skeleton Hill Climb Racing uses.

## License

Provided as-is for educational use.
