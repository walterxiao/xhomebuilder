import SwiftUI
import SpriteKit
import Combine

/// SwiftUI wrapper around the SpriteKit `GameScene`, plus the on-screen HUD
/// and touch-based throttle/brake pedals.
struct GameContainerView: View {
    @EnvironmentObject var coord: GameCoordinator

    let seed: UInt32
    let trackLength: CGFloat
    let startTime: Date
    let players: [PlayerInfo]
    let youId: PlayerID

    @State private var localDistance: CGFloat = 0
    @State private var sceneProxy = SceneProxy()

    var body: some View {
        ZStack {
            SpriteKitView(sceneProxy: sceneProxy,
                          seed: seed,
                          trackLength: trackLength,
                          startTime: startTime,
                          players: players,
                          youId: youId,
                          coord: coord,
                          onLocalDistance: { localDistance = $0 })
                .ignoresSafeArea()

            // HUD
            VStack {
                HStack {
                    Button(action: coord.leaveToMenu) {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 30))
                            .foregroundStyle(.white.opacity(0.7))
                    }
                    .padding(.leading, 18)

                    Spacer()

                    // Progress bar
                    progressBar
                        .frame(width: 220, height: 14)

                    Spacer()

                    // Rank / player count
                    Text("\(players.count) RACERS")
                        .font(.caption).bold().kerning(1)
                        .foregroundStyle(.white.opacity(0.8))
                        .padding(.trailing, 18)
                }
                .padding(.top, 20)

                Spacer()
            }

            // Touch pedals — left half brake, right half gas
            HStack(spacing: 0) {
                PedalArea(symbol: "tortoise.fill", label: "BRAKE",
                          onPress: { sceneProxy.scene?.setThrottle(-1) },
                          onRelease: { sceneProxy.scene?.setThrottle(0) })
                PedalArea(symbol: "hare.fill", label: "GAS",
                          onPress: { sceneProxy.scene?.setThrottle(1) },
                          onRelease: { sceneProxy.scene?.setThrottle(0) })
            }
            .ignoresSafeArea()
            .allowsHitTesting(true)
        }
    }

    private var progressBar: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule()
                    .fill(.white.opacity(0.15))
                Capsule()
                    .fill(LinearGradient(colors: [.yellow, .orange],
                                         startPoint: .leading,
                                         endPoint: .trailing))
                    .frame(width: geo.size.width * min(1, max(0, localDistance / trackLength)))
            }
        }
    }
}

// MARK: - Scene proxy so SwiftUI can pass the scene pointer around

final class SceneProxy: ObservableObject {
    weak var scene: GameScene?
}

// MARK: - UIViewRepresentable hosting the SKView

struct SpriteKitView: UIViewRepresentable {
    let sceneProxy: SceneProxy
    let seed: UInt32
    let trackLength: CGFloat
    let startTime: Date
    let players: [PlayerInfo]
    let youId: PlayerID
    let coord: GameCoordinator
    let onLocalDistance: (CGFloat) -> Void

    func makeUIView(context: Context) -> SKView {
        let view = SKView(frame: .zero)
        view.ignoresSiblingOrder = true
        view.showsFPS    = false
        view.showsNodeCount = false
        view.isMultipleTouchEnabled = true

        let scene = GameScene(
            size: UIScreen.main.bounds.size,
            seed: seed,
            trackLength: trackLength,
            players: players,
            youId: youId,
            raceStart: startTime
        )
        scene.sceneDelegate = context.coordinator
        view.presentScene(scene)
        sceneProxy.scene = scene
        context.coordinator.scene = scene
        return view
    }

    func updateUIView(_ uiView: SKView, context: Context) {
        // Forward the latest world snapshot to the scene.
        sceneProxy.scene?.updateRemoteCars(coord.worldSnapshot)
    }

    func makeCoordinator() -> Bridge {
        Bridge(coord: coord, onLocalDistance: onLocalDistance)
    }

    /// Sits between `GameScene` (which publishes physics events) and the
    /// `GameCoordinator` (which owns the network connection).
    final class Bridge: NSObject, GameSceneDelegate {
        let coord: GameCoordinator
        let onLocalDistance: (CGFloat) -> Void
        weak var scene: GameScene?

        init(coord: GameCoordinator, onLocalDistance: @escaping (CGFloat) -> Void) {
            self.coord = coord
            self.onLocalDistance = onLocalDistance
        }

        func gameScene(_ scene: GameScene, didPublishLocalState x: CGFloat, y: CGFloat, rot: CGFloat, wheelRot: CGFloat) {
            Task { @MainActor in
                self.coord.publishLocalState(x: x, y: y, rot: rot, wheelRot: wheelRot)
            }
        }

        func gameSceneDidFinishLocally(_ scene: GameScene) {
            Task { @MainActor in
                self.coord.reportLocalFinished()
            }
        }

        func gameScene(_ scene: GameScene, didUpdateLocalDistance distance: CGFloat, totalTrackLength: CGFloat) {
            Task { @MainActor in
                self.onLocalDistance(distance)
            }
        }
    }
}

// MARK: - Pedal control

struct PedalArea: View {
    let symbol: String
    let label: String
    let onPress: () -> Void
    let onRelease: () -> Void

    @State private var pressed: Bool = false

    var body: some View {
        ZStack(alignment: .bottom) {
            Color.clear.contentShape(Rectangle())
            VStack(spacing: 4) {
                Image(systemName: symbol)
                    .font(.system(size: 28, weight: .bold))
                    .foregroundStyle(.white.opacity(pressed ? 0.9 : 0.45))
                Text(label)
                    .font(.caption2).bold().kerning(1.5)
                    .foregroundStyle(.white.opacity(pressed ? 0.9 : 0.4))
            }
            .padding(.bottom, 40)
        }
        .gesture(
            DragGesture(minimumDistance: 0)
                .onChanged { _ in
                    if !pressed {
                        pressed = true
                        onPress()
                    }
                }
                .onEnded { _ in
                    pressed = false
                    onRelease()
                }
        )
    }
}
