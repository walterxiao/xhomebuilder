import SpriteKit
import CoreGraphics

protocol GameSceneDelegate: AnyObject {
    func gameScene(_ scene: GameScene, didPublishLocalState x: CGFloat, y: CGFloat, rot: CGFloat, wheelRot: CGFloat)
    func gameSceneDidFinishLocally(_ scene: GameScene)
    func gameScene(_ scene: GameScene, didUpdateLocalDistance distance: CGFloat, totalTrackLength: CGFloat)
}

/// SpriteKit scene that owns the terrain, the local car, any number of
/// remote cars, and the camera that follows the local player.
final class GameScene: SKScene, SKPhysicsContactDelegate {

    // Injection
    weak var sceneDelegate: GameSceneDelegate?
    let seed: UInt32
    let trackLength: CGFloat
    let players: [PlayerInfo]
    let youId: PlayerID
    let raceStart: Date

    // Game state
    private var terrain: Terrain!
    private var localCar: Car!
    private var remoteCars: [PlayerID: Car] = [:]
    private let cam = SKCameraNode()
    private var finishLineNode: SKShapeNode!
    private var hasFinishedLocally = false
    private var sendAccum: CGFloat = 0
    private var lastUpdate: TimeInterval = 0
    private var raceHasStarted = false

    init(size: CGSize,
         seed: UInt32,
         trackLength: CGFloat,
         players: [PlayerInfo],
         youId: PlayerID,
         raceStart: Date) {
        self.seed = seed
        self.trackLength = trackLength
        self.players = players
        self.youId = youId
        self.raceStart = raceStart
        super.init(size: size)
        self.scaleMode = .resizeFill
        self.anchorPoint = CGPoint(x: 0, y: 0)
        self.backgroundColor = SKColor(red: 0.45, green: 0.70, blue: 0.95, alpha: 1.0)
    }

    required init?(coder aDecoder: NSCoder) {
        fatalError("init(coder:) not supported")
    }

    override func didMove(to view: SKView) {
        physicsWorld.gravity = CGVector(dx: 0, dy: -12.5)
        physicsWorld.contactDelegate = self

        addSkybox()

        // Terrain
        terrain = Terrain(seed: seed, length: trackLength)
        addChild(terrain.buildNode())

        // Camera
        cam.setScale(0.85)
        addChild(cam)
        camera = cam

        // Spawn cars — local + remotes — spaced horizontally so they don't
        // collide at the start line.
        let me = players.first(where: { $0.id == youId })
        let others = players.filter { $0.id != youId }

        func spawnX(index: Int) -> CGFloat { 60 + CGFloat(index) * 60 }

        var idx = 0
        for p in players {
            let color = SKColor(hexString: p.colorHex) ?? .red
            let isRemote = (p.id != youId)
            let car = Car(color: color, isRemote: isRemote)
            let x = spawnX(index: idx)
            let y = terrain.height(at: x) + 60
            car.addToScene(self, at: CGPoint(x: x, y: y))
            if isRemote {
                remoteCars[p.id] = car
            } else {
                localCar = car
            }
            idx += 1
        }

        // Safety: if no local player in the list (shouldn't happen), still
        // create one so the scene doesn't crash.
        if localCar == nil {
            let color = SKColor(hexString: me?.colorHex ?? "#ff3b30") ?? .red
            localCar = Car(color: color, isRemote: false)
            localCar.addToScene(self, at: CGPoint(x: 60, y: terrain.height(at: 60) + 60))
        }

        // Finish line visual + trigger
        let flHeight: CGFloat = 260
        let finishX = trackLength - Terrain.finishPadLength * 0.5
        let finishPath = CGMutablePath()
        finishPath.move(to: CGPoint(x: 0, y: 0))
        finishPath.addLine(to: CGPoint(x: 0, y: flHeight))
        finishLineNode = SKShapeNode(path: finishPath)
        finishLineNode.position = CGPoint(x: finishX, y: terrain.height(at: finishX))
        finishLineNode.strokeColor = .white
        finishLineNode.lineWidth = 8
        finishLineNode.zPosition = 50

        // Flag
        let flag = SKShapeNode(rectOf: CGSize(width: 30, height: 20))
        flag.position = CGPoint(x: 15, y: flHeight - 12)
        flag.fillColor = .white
        flag.strokeColor = .black
        finishLineNode.addChild(flag)

        let fb = SKPhysicsBody(edgeFrom: CGPoint(x: 0, y: 0),
                               to: CGPoint(x: 0, y: flHeight))
        fb.isDynamic = false
        fb.categoryBitMask = PhysicsCategory.finish
        fb.collisionBitMask = 0
        fb.contactTestBitMask = PhysicsCategory.chassis
        finishLineNode.physicsBody = fb
        addChild(finishLineNode)

        // Start the countdown clock visually; inputs remain disabled until
        // `raceHasStarted` flips.
        startCountdownOverlay()
    }

    // MARK: - Countdown

    private func startCountdownOverlay() {
        let label = SKLabelNode(fontNamed: "Helvetica-Bold")
        label.fontSize = 120
        label.fontColor = .white
        label.zPosition = 5000
        cam.addChild(label)

        let untilStart = raceStart.timeIntervalSinceNow
        let initialDelay = max(0, untilStart - 3)

        let waitInitial = SKAction.wait(forDuration: initialDelay)
        let count: (String) -> SKAction = { text in
            let set = SKAction.run { label.text = text }
            let wait = SKAction.wait(forDuration: 1.0)
            return SKAction.sequence([set, wait])
        }
        let go = SKAction.run { [weak self] in
            label.text = "GO!"
            self?.raceHasStarted = true
        }
        let fade = SKAction.fadeOut(withDuration: 0.4)
        let remove = SKAction.removeFromParent()

        label.run(SKAction.sequence([
            waitInitial,
            count("3"), count("2"), count("1"),
            go,
            SKAction.wait(forDuration: 0.5),
            fade,
            remove
        ]))
    }

    // MARK: - Input (owned by GameContainerView via `setThrottle`)

    func setThrottle(_ v: CGFloat) {
        guard raceHasStarted, !hasFinishedLocally, localCar != nil else { return }
        localCar.throttle = v
    }

    // MARK: - Update

    override func update(_ currentTime: TimeInterval) {
        let dt: CGFloat
        if lastUpdate == 0 {
            dt = 1.0 / 60.0
        } else {
            dt = CGFloat(min(0.05, currentTime - lastUpdate))
        }
        lastUpdate = currentTime

        guard let localCar = localCar else { return }

        if raceHasStarted && !hasFinishedLocally {
            localCar.applyInputs(dt: dt)
        }

        // Camera follows the local car with a slight lead in the direction
        // of travel.
        let vx = localCar.chassis.physicsBody?.velocity.dx ?? 0
        let lead = min(200, max(-100, vx * 0.3))
        let target = CGPoint(
            x: localCar.worldPosition.x + lead,
            y: localCar.worldPosition.y + 80
        )
        cam.position = CGPoint(
            x: cam.position.x + (target.x - cam.position.x) * 0.12,
            y: cam.position.y + (target.y - cam.position.y) * 0.08
        )

        // Distance reporting for HUD
        let dist = min(trackLength, max(0, localCar.worldPosition.x))
        sceneDelegate?.gameScene(self, didUpdateLocalDistance: dist, totalTrackLength: trackLength)

        // Publish local state at ~20 Hz
        sendAccum += dt
        if sendAccum >= 0.05 {
            sendAccum = 0
            let rot = localCar.chassis.zRotation
            let wheelRot = localCar.rearWheel.zRotation
            sceneDelegate?.gameScene(self,
                                     didPublishLocalState: localCar.worldPosition.x,
                                     y: localCar.worldPosition.y,
                                     rot: rot,
                                     wheelRot: wheelRot)
        }

        // Auto-recover if the car has been upside-down for too long or
        // fallen off the world.
        if localCar.worldPosition.y < -500 {
            let groundY = terrain.height(at: localCar.worldPosition.x)
            localCar.recover(at: localCar.worldPosition.x, groundY: groundY)
        }
    }

    override func didSimulatePhysics() {
        // Apply incoming remote snapshots to remote cars each frame.
        applyRemoteSnapshots()
    }

    // Called from outside with latest world snapshots.
    private var pendingRemote: [RemoteCarSnapshot] = []
    func updateRemoteCars(_ snapshots: [RemoteCarSnapshot]) {
        pendingRemote = snapshots
    }

    private func applyRemoteSnapshots() {
        for snap in pendingRemote {
            guard snap.playerId != youId else { continue }
            guard let car = remoteCars[snap.playerId] else { continue }
            car.interpolateTo(position: snap.position,
                              rotation: snap.rotation,
                              wheelRot: snap.wheelRotation,
                              alpha: 0.35)
        }
    }

    // MARK: - Contact handling

    func didBegin(_ contact: SKPhysicsContact) {
        let a = contact.bodyA.categoryBitMask
        let b = contact.bodyB.categoryBitMask
        let combined = a | b
        if combined == (PhysicsCategory.chassis | PhysicsCategory.finish),
           !hasFinishedLocally {
            // Make sure it's the LOCAL car that hit the finish.
            if contact.bodyA.node === localCar?.chassis ||
               contact.bodyB.node === localCar?.chassis {
                hasFinishedLocally = true
                localCar.throttle = 0
                sceneDelegate?.gameSceneDidFinishLocally(self)

                let label = SKLabelNode(fontNamed: "Helvetica-Bold")
                label.text = "FINISHED!"
                label.fontSize = 72
                label.fontColor = .yellow
                label.zPosition = 5000
                label.position = CGPoint(x: 0, y: 60)
                cam.addChild(label)
                label.run(SKAction.sequence([
                    SKAction.scale(to: 1.2, duration: 0.15),
                    SKAction.scale(to: 1.0, duration: 0.15),
                ]))
            }
        }
    }

    // MARK: - Background

    private func addSkybox() {
        let sky = SKSpriteNode(color: SKColor(red: 0.45, green: 0.70, blue: 0.95, alpha: 1.0),
                               size: CGSize(width: 10000, height: 2000))
        sky.position = CGPoint(x: trackLength / 2, y: 400)
        sky.zPosition = -100
        addChild(sky)

        // A few cheap parallax clouds
        for i in 0..<8 {
            let cloud = SKShapeNode(ellipseOf: CGSize(width: 160, height: 40))
            cloud.fillColor = SKColor(white: 1, alpha: 0.9)
            cloud.strokeColor = .clear
            cloud.position = CGPoint(
                x: CGFloat(i) * (trackLength / 8) + 100,
                y: 320 + CGFloat((i * 37) % 80)
            )
            cloud.zPosition = -90
            addChild(cloud)
        }

        // Distant hill silhouettes
        let hillPath = CGMutablePath()
        hillPath.move(to: CGPoint(x: -500, y: 0))
        var hx: CGFloat = -500
        while hx < trackLength + 500 {
            hillPath.addLine(to: CGPoint(x: hx, y: 100 + 40 * sin(hx * 0.01)))
            hx += 40
        }
        hillPath.addLine(to: CGPoint(x: trackLength + 500, y: -200))
        hillPath.addLine(to: CGPoint(x: -500, y: -200))
        hillPath.closeSubpath()
        let hills = SKShapeNode(path: hillPath)
        hills.fillColor = SKColor(red: 0.30, green: 0.45, blue: 0.55, alpha: 1.0)
        hills.strokeColor = .clear
        hills.zPosition = -50
        addChild(hills)
    }
}

// MARK: - Helpers

extension SKColor {
    /// Parse "#rrggbb" → SKColor.
    convenience init?(hexString: String) {
        var s = hexString.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("#") { s.removeFirst() }
        guard s.count == 6, let v = UInt32(s, radix: 16) else { return nil }
        let r = CGFloat((v >> 16) & 0xff) / 255.0
        let g = CGFloat((v >>  8) & 0xff) / 255.0
        let b = CGFloat( v        & 0xff) / 255.0
        self.init(red: r, green: g, blue: b, alpha: 1.0)
    }
}
