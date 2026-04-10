import Foundation
import Combine
import CoreGraphics

/// Events the game logic cares about. The network layer decodes raw JSON
/// messages and republishes them as strongly-typed events on the main queue.
enum NetworkEvent {
    case connected
    case disconnected(reason: String?)
    case joined(you: PlayerID, color: String)
    case lobbyUpdate(players: [PlayerInfo], state: String)
    case countdown(endsAt: Date)
    case countdownCancel
    case raceStart(seed: UInt32, trackLength: CGFloat, startTime: Date, players: [PlayerInfo])
    case worldSnapshot(serverTime: Int64, cars: [RemoteCarSnapshot])
    case playerFinished(playerId: PlayerID, name: String, finishMs: Int, place: Int)
    case playerLeft(playerId: PlayerID, name: String)
    case raceFinished(reason: String, rankings: [FinishEntry])
    case chat(from: String, text: String)
    case error(String)
}

/// Minimal WebSocket client using `URLSessionWebSocketTask`. No external deps.
final class NetworkClient: NSObject, ObservableObject {

    // Publishers the UI/game can subscribe to.
    let events = PassthroughSubject<NetworkEvent, Never>()
    @Published private(set) var isConnected: Bool = false

    private var task: URLSessionWebSocketTask?
    private var session: URLSession!
    private var pingTimer: Timer?

    private(set) var youId: PlayerID = 0

    override init() {
        super.init()
        let config = URLSessionConfiguration.default
        config.waitsForConnectivity = true
        self.session = URLSession(configuration: config, delegate: self, delegateQueue: .main)
    }

    // MARK: - Connect / disconnect

    func connect(url: URL) {
        disconnect()
        let t = session.webSocketTask(with: url)
        self.task = t
        t.resume()
        // Receive loop starts once we see didOpenWithProtocol in delegate.
    }

    func disconnect() {
        pingTimer?.invalidate()
        pingTimer = nil
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        if isConnected {
            isConnected = false
            events.send(.disconnected(reason: nil))
        }
    }

    // MARK: - Outgoing messages

    func sendJoin(name: String) {
        send(["type": "join", "name": name])
    }

    func sendReady(_ ready: Bool) {
        send(["type": "ready", "ready": ready])
    }

    func sendState(x: CGFloat, y: CGFloat, rot: CGFloat, wheelRot: CGFloat) {
        send([
            "type": "state",
            "x": Double(x),
            "y": Double(y),
            "rot": Double(rot),
            "wheelRot": Double(wheelRot),
        ])
    }

    func sendFinished() {
        send(["type": "finished"])
    }

    func sendChat(_ text: String) {
        send(["type": "chat", "text": text])
    }

    private func send(_ dict: [String: Any]) {
        guard let task = task else { return }
        guard let data = try? JSONSerialization.data(withJSONObject: dict, options: []),
              let s = String(data: data, encoding: .utf8) else { return }
        task.send(.string(s)) { [weak self] err in
            if let err = err {
                DispatchQueue.main.async {
                    self?.events.send(.error("send failed: \(err.localizedDescription)"))
                }
            }
        }
    }

    // MARK: - Receive loop

    private func receiveLoop() {
        guard let task = task else { return }
        task.receive { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .failure(let err):
                self.isConnected = false
                self.events.send(.disconnected(reason: err.localizedDescription))
            case .success(let message):
                switch message {
                case .string(let text):
                    self.handleIncoming(text: text)
                case .data(let data):
                    if let s = String(data: data, encoding: .utf8) {
                        self.handleIncoming(text: s)
                    }
                @unknown default:
                    break
                }
                self.receiveLoop()
            }
        }
    }

    private func handleIncoming(text: String) {
        guard let data = text.data(using: .utf8),
              let any  = try? JSONSerialization.jsonObject(with: data),
              let msg  = any as? [String: Any],
              let type = msg["type"] as? String else { return }

        switch type {
        case "joined":
            if let you = msg["you"] as? [String: Any],
               let id = you["id"] as? Int {
                self.youId = id
                let color = (you["color"] as? String) ?? "#ffffff"
                events.send(.joined(you: id, color: color))
            }

        case "lobby":
            let state = (msg["state"] as? String) ?? "lobby"
            let players = decodePlayers(msg["players"] as? [[String: Any]] ?? [])
            events.send(.lobbyUpdate(players: players, state: state))

        case "countdown":
            if let endsAt = msg["endsAt"] as? Double {
                let d = Date(timeIntervalSince1970: endsAt / 1000.0)
                events.send(.countdown(endsAt: d))
            }

        case "countdown_cancel":
            events.send(.countdownCancel)

        case "start":
            guard
                let seedAny    = msg["seed"],
                let lenAny     = msg["trackLength"],
                let startAny   = msg["startTime"]
            else { return }
            let seed        = UInt32(truncatingIfNeeded: (seedAny as? NSNumber)?.int64Value ?? 0)
            let trackLength = CGFloat((lenAny as? NSNumber)?.doubleValue ?? 3500)
            let startTime   = Date(timeIntervalSince1970:
                                   ((startAny as? NSNumber)?.doubleValue ?? 0) / 1000.0)
            let players = decodePlayers(msg["players"] as? [[String: Any]] ?? [])
            events.send(.raceStart(seed: seed,
                                   trackLength: trackLength,
                                   startTime: startTime,
                                   players: players))

        case "world":
            let t = (msg["t"] as? NSNumber)?.int64Value ?? 0
            let arr = msg["players"] as? [[String: Any]] ?? []
            let snapshots: [RemoteCarSnapshot] = arr.map { p in
                RemoteCarSnapshot(
                    playerId: (p["id"] as? Int) ?? 0,
                    position: CGPoint(
                        x: (p["x"] as? NSNumber)?.doubleValue ?? 0,
                        y: (p["y"] as? NSNumber)?.doubleValue ?? 0
                    ),
                    rotation: CGFloat((p["rot"] as? NSNumber)?.doubleValue ?? 0),
                    wheelRotation: CGFloat((p["wheelRot"] as? NSNumber)?.doubleValue ?? 0),
                    finished: (p["finished"] as? Bool) ?? false,
                    distance: CGFloat((p["dist"] as? NSNumber)?.doubleValue ?? 0)
                )
            }
            events.send(.worldSnapshot(serverTime: t, cars: snapshots))

        case "player_finished":
            events.send(.playerFinished(
                playerId: (msg["playerId"] as? Int) ?? 0,
                name:     (msg["name"] as? String) ?? "?",
                finishMs: (msg["finishMs"] as? Int) ?? 0,
                place:    (msg["place"] as? Int) ?? 0
            ))

        case "player_left":
            events.send(.playerLeft(
                playerId: (msg["playerId"] as? Int) ?? 0,
                name:     (msg["name"] as? String) ?? "?"
            ))

        case "finish":
            let reason = (msg["reason"] as? String) ?? ""
            let raw = msg["rankings"] as? [[String: Any]] ?? []
            let rankings: [FinishEntry] = raw.map { r in
                FinishEntry(
                    place:    (r["place"] as? Int) ?? 0,
                    playerId: (r["id"] as? Int) ?? 0,
                    name:     (r["name"] as? String) ?? "?",
                    finishMs: r["finishMs"] as? Int,
                    distance: (r["distance"] as? NSNumber).map { CGFloat($0.doubleValue) }
                )
            }
            events.send(.raceFinished(reason: reason, rankings: rankings))

        case "chat":
            events.send(.chat(
                from: (msg["from"] as? String) ?? "?",
                text: (msg["text"] as? String) ?? ""
            ))

        default:
            break
        }
    }

    private func decodePlayers(_ arr: [[String: Any]]) -> [PlayerInfo] {
        arr.map { p in
            PlayerInfo(
                id:       (p["id"] as? Int) ?? 0,
                name:     (p["name"] as? String) ?? "?",
                colorHex: (p["color"] as? String) ?? "#ffffff",
                ready:    (p["ready"] as? Bool) ?? false
            )
        }
    }
}

// MARK: - URLSessionWebSocketDelegate

extension NetworkClient: URLSessionWebSocketDelegate {
    func urlSession(_ session: URLSession,
                    webSocketTask: URLSessionWebSocketTask,
                    didOpenWithProtocol protocol: String?) {
        isConnected = true
        events.send(.connected)
        receiveLoop()

        // Keep the connection alive through NATs / idle timeouts.
        pingTimer?.invalidate()
        pingTimer = Timer.scheduledTimer(withTimeInterval: 20, repeats: true) { [weak self] _ in
            self?.task?.sendPing { _ in }
        }
    }

    func urlSession(_ session: URLSession,
                    webSocketTask: URLSessionWebSocketTask,
                    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
                    reason: Data?) {
        isConnected = false
        let reasonStr = reason.flatMap { String(data: $0, encoding: .utf8) }
        events.send(.disconnected(reason: reasonStr))
        pingTimer?.invalidate()
        pingTimer = nil
    }
}
