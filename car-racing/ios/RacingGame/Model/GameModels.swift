import Foundation
import CoreGraphics

/// Identifier assigned by the server to each connected player.
typealias PlayerID = Int

/// Lightweight description of another racer, sent by the server in the lobby
/// and at race start.
struct PlayerInfo: Identifiable, Hashable {
    let id: PlayerID
    let name: String
    let colorHex: String
    var ready: Bool = false
}

/// A live snapshot of a remote car, as seen at `timestamp` (server time ms).
struct RemoteCarSnapshot {
    let playerId: PlayerID
    let position: CGPoint
    let rotation: CGFloat
    let wheelRotation: CGFloat
    let finished: Bool
    let distance: CGFloat
}

/// High-level app phases.  The root view switches between them.
enum AppScreen: Equatable {
    case menu
    case lobby
    case race(seed: UInt32, trackLength: CGFloat, startTime: Date, players: [PlayerInfo], you: PlayerID)
    case results(rankings: [FinishEntry])
}

/// One row of the end-of-race results board.
struct FinishEntry: Identifiable, Hashable {
    var id: PlayerID { playerId }
    let place: Int
    let playerId: PlayerID
    let name: String
    /// Milliseconds from race start.  `nil` if the player didn't reach the
    /// finish line (DNF).
    let finishMs: Int?
    /// Distance along the track at race end.  Only set for DNF players.
    let distance: CGFloat?
}
