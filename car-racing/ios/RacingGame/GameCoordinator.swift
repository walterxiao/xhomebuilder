import Foundation
import Combine
import SwiftUI

/// Owns the network connection and the current app screen.  Views observe
/// this object and dispatch actions back through it.
@MainActor
final class GameCoordinator: ObservableObject {

    // MARK: - Persisted player settings

    @AppStorage("playerName")   var playerName: String = ""
    @AppStorage("serverURL")    var serverURL:  String = "ws://localhost:9753/ws/racing"

    // MARK: - Published UI state

    @Published var screen: AppScreen = .menu
    @Published var lobbyPlayers: [PlayerInfo] = []
    @Published var countdownEndsAt: Date? = nil
    @Published var connectionStatus: String = "Offline"
    @Published var lastError: String? = nil

    // MARK: - Mid-race state (consumed by the SpriteKit scene)

    @Published var worldSnapshot: [RemoteCarSnapshot] = []
    @Published var finishedEvents: [FinishEntry] = []

    let net = NetworkClient()
    private var cancellables = Set<AnyCancellable>()

    init() {
        net.events
            .receive(on: DispatchQueue.main)
            .sink { [weak self] ev in self?.handle(ev) }
            .store(in: &cancellables)
    }

    // MARK: - Actions

    func findMatch() {
        let name = playerName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else {
            lastError = "Enter a name first"
            return
        }
        guard let url = URL(string: serverURL) else {
            lastError = "Invalid server URL"
            return
        }
        lastError = nil
        connectionStatus = "Connecting…"
        lobbyPlayers = []
        countdownEndsAt = nil
        screen = .lobby
        net.connect(url: url)
        // Send "join" as soon as the socket opens — handled in `handle(.connected)`.
        pendingJoin = name
    }

    func leaveToMenu() {
        net.disconnect()
        lobbyPlayers = []
        countdownEndsAt = nil
        worldSnapshot = []
        finishedEvents = []
        screen = .menu
    }

    func reportLocalFinished() {
        net.sendFinished()
    }

    func publishLocalState(x: CGFloat, y: CGFloat, rot: CGFloat, wheelRot: CGFloat) {
        net.sendState(x: x, y: y, rot: rot, wheelRot: wheelRot)
    }

    // MARK: - Event handling

    private var pendingJoin: String?

    private func handle(_ event: NetworkEvent) {
        switch event {
        case .connected:
            connectionStatus = "Connected"
            if let name = pendingJoin {
                net.sendJoin(name: name)
                pendingJoin = nil
            }

        case .disconnected(let reason):
            connectionStatus = "Disconnected"
            if let reason = reason, !reason.isEmpty {
                lastError = reason
            }
            // If we were mid-lobby, bounce to menu.
            if case .lobby = screen { screen = .menu }

        case .joined(let you, _):
            connectionStatus = "In lobby (id \(you))"

        case .lobbyUpdate(let players, _):
            lobbyPlayers = players

        case .countdown(let endsAt):
            countdownEndsAt = endsAt

        case .countdownCancel:
            countdownEndsAt = nil

        case .raceStart(let seed, let len, let startTime, let players):
            worldSnapshot = []
            finishedEvents = []
            screen = .race(seed: seed,
                           trackLength: len,
                           startTime: startTime,
                           players: players,
                           you: net.youId)

        case .worldSnapshot(_, let cars):
            worldSnapshot = cars

        case .playerFinished(let id, let name, let ms, let place):
            finishedEvents.append(FinishEntry(place: place,
                                              playerId: id,
                                              name: name,
                                              finishMs: ms,
                                              distance: nil))

        case .playerLeft:
            break

        case .raceFinished(_, let rankings):
            screen = .results(rankings: rankings)

        case .chat:
            break

        case .error(let msg):
            lastError = msg
        }
    }
}
