# WebSocket Protocol

All messages are JSON objects with a `type` field. Sent over the
`/ws/racing` WebSocket endpoint.

## Client → Server

| type       | fields                                   | when                                    |
|------------|------------------------------------------|-----------------------------------------|
| `join`     | `name` (string, ≤24 chars)               | Entering matchmaking                    |
| `ready`    | `ready` (bool)                           | Optional: toggle ready state in lobby   |
| `state`    | `x`, `y`, `rot`, `wheelRot` (numbers)    | ~20 Hz position updates during a race   |
| `finished` | —                                        | When the local car crosses the finish   |
| `chat`     | `text` (string, ≤200 chars)              | Lobby or mid-race chat                  |

## Server → Client

| type               | fields                                               | meaning                                              |
|--------------------|------------------------------------------------------|------------------------------------------------------|
| `joined`           | `you: {id, color}`                                   | Matchmaking accepted; your player id + car color     |
| `lobby`            | `matchId, seed, trackLength, players, minPlayers, maxPlayers, state` | Current lobby roster                    |
| `countdown`        | `endsAt` (ms since epoch)                            | Auto-start countdown begins                          |
| `countdown_cancel` | —                                                    | Countdown aborted (player left)                      |
| `start`            | `matchId, seed, trackLength, startTime, players`     | Race is starting — clients generate terrain from seed|
| `world`            | `t, players[{id, x, y, rot, wheelRot, finished, dist}]` | ~20 Hz snapshot of every car                     |
| `player_finished`  | `playerId, name, finishMs, place`                    | Someone crossed the finish                           |
| `player_left`      | `playerId, name`                                     | Player disconnected                                  |
| `finish`           | `reason, rankings[{place, id, name, finishMs, distance}]` | Race is over                                    |
| `chat`             | `from, text`                                         | Chat message                                         |

## Constants

| name              | value | notes                                        |
|-------------------|-------|----------------------------------------------|
| `MIN_PLAYERS`     | 2     | Countdown starts at this many                |
| `MAX_PLAYERS`     | 4     | Lobby closes at this many                    |
| `LOBBY_COUNTDOWN` | 5s    | Window after `MIN_PLAYERS` reached           |
| `TRACK_LENGTH`    | 3500  | World units to the finish line               |
| `BROADCAST_TICK`  | 50ms  | Server world-snapshot cadence                |
| `RACE_TIMEOUT`    | 180s  | Hard cap on a single race                    |

## Terrain seed

The server generates a 32-bit seed once per match. Clients feed it into
their Mulberry32 PRNG and produce a sum-of-sines hill profile from it. As
long as the seed + length are identical, every client generates the exact
same terrain, so each player's local physics simulation matches what the
others see.
