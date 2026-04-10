import Foundation
import SpriteKit

/// Procedurally generates a 2D hilly track from a 32-bit seed.
///
/// Identical inputs (seed + length) produce identical terrain on every
/// client, so races are consistent without the server having to describe
/// every hill in bytes.
final class Terrain {

    // MARK: - Tunables

    /// Horizontal distance between sampled points.  Smaller = smoother.
    static let sampleStep: CGFloat = 12

    /// How low the starting flat section sits.
    static let baseY: CGFloat = 0

    /// Length of the flat starting pad before hills begin.
    static let startPadLength: CGFloat = 260

    /// Length of the flat finish pad.
    static let finishPadLength: CGFloat = 200

    // MARK: - Generated data

    let seed: UInt32
    let length: CGFloat
    let points: [CGPoint]

    init(seed: UInt32, length: CGFloat) {
        self.seed = seed
        self.length = length
        self.points = Terrain.buildPoints(seed: seed, length: length)
    }

    /// Interpolated ground height at a given world X.  Used for placing
    /// remote cars and spawning players.
    func height(at x: CGFloat) -> CGFloat {
        if x <= 0 { return points.first?.y ?? 0 }
        if x >= length { return points.last?.y ?? 0 }

        let idx = min(points.count - 2,
                      max(0, Int(x / Terrain.sampleStep)))
        let a = points[idx]
        let b = points[idx + 1]
        let t = (x - a.x) / max(1, (b.x - a.x))
        return a.y + (b.y - a.y) * t
    }

    // MARK: - Builder

    private static func buildPoints(seed: UInt32, length: CGFloat) -> [CGPoint] {
        var rng = SeededRNG(seed: seed)

        // Sum of three sines with random phases/amplitudes/frequencies.
        // We pick the parameters up front so the whole track is deterministic.
        struct Wave { var amp: Double; var freq: Double; var phase: Double }
        let waves: [Wave] = (0..<3).map { i in
            Wave(
                amp:   rng.range(30,  100) * Double(3 - i) / 3.0 + 40,
                freq:  rng.range(0.004, 0.012) * Double(i + 1),
                phase: rng.range(0, .pi * 2)
            )
        }

        var pts: [CGPoint] = []
        var x: CGFloat = 0
        let step = sampleStep
        while x <= length {
            // Flat zones at start and finish
            let dxFromStart = x
            let dxFromEnd   = length - x

            var y: Double = Double(baseY)
            if dxFromStart > startPadLength && dxFromEnd > finishPadLength {
                for w in waves {
                    y += w.amp * sin(w.freq * Double(x) + w.phase)
                }
                // Blend-in the hills near the start pad
                let ramp = min(1.0, Double(dxFromStart - startPadLength) / 120.0)
                y *= ramp
                // Blend-out the hills near the finish pad
                let ramp2 = min(1.0, Double(dxFromEnd - finishPadLength) / 120.0)
                y *= ramp2
            }

            pts.append(CGPoint(x: x, y: CGFloat(y)))
            x += step
        }

        // Ensure the final point is exactly at length so the finish line
        // sits cleanly on a flat piece.
        if let last = pts.last, last.x < length {
            pts.append(CGPoint(x: length, y: CGFloat(baseY)))
        }
        return pts
    }

    /// Build a `SKShapeNode` for the ground with a closed polygon for fill
    /// and an edge-chain physics body for wheels to roll on.
    func buildNode() -> SKShapeNode {
        let groundFloor: CGFloat = -600
        let path = CGMutablePath()
        path.move(to: CGPoint(x: -200, y: groundFloor))
        path.addLine(to: CGPoint(x: -200, y: points.first?.y ?? 0))
        for p in points { path.addLine(to: p) }
        path.addLine(to: CGPoint(x: length + 200, y: points.last?.y ?? 0))
        path.addLine(to: CGPoint(x: length + 200, y: groundFloor))
        path.closeSubpath()

        let node = SKShapeNode(path: path)
        node.fillColor = SKColor(red: 0.20, green: 0.40, blue: 0.18, alpha: 1.0)
        node.strokeColor = SKColor(red: 0.35, green: 0.60, blue: 0.25, alpha: 1.0)
        node.lineWidth = 3

        // Edge chain exactly on the surface — cars roll on this.
        let surface = CGMutablePath()
        surface.move(to: CGPoint(x: -200, y: points.first?.y ?? 0))
        for p in points { surface.addLine(to: p) }
        surface.addLine(to: CGPoint(x: length + 200, y: points.last?.y ?? 0))

        let body = SKPhysicsBody(edgeChainFrom: surface)
        body.isDynamic = false
        body.friction  = 1.0
        body.restitution = 0.05
        body.categoryBitMask    = PhysicsCategory.terrain
        body.collisionBitMask   = PhysicsCategory.chassis | PhysicsCategory.wheel
        body.contactTestBitMask = 0
        node.physicsBody = body
        node.zPosition = 10
        return node
    }
}

/// Shared collision categories for the scene.
enum PhysicsCategory {
    static let terrain: UInt32 = 1 << 0
    static let chassis: UInt32 = 1 << 1
    static let wheel:   UInt32 = 1 << 2
    static let finish:  UInt32 = 1 << 3
}
