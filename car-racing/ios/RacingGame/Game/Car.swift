import SpriteKit

/// A simple Hill-Climb-style car: rectangular chassis + two circular wheels
/// connected by pin joints.  Gas/brake apply torque to the wheels.
final class Car {

    // Visual + physical dimensions
    static let chassisSize  = CGSize(width: 78, height: 26)
    static let wheelRadius: CGFloat = 16
    static let wheelOffsetX: CGFloat = 26
    static let wheelOffsetY: CGFloat = -10

    // Motor tuning
    static let maxTorque: CGFloat = 420
    static let brakeTorque: CGFloat = 380
    static let maxAngularSpeed: CGFloat = 38

    let chassis: SKSpriteNode
    let rearWheel: SKShapeNode
    let frontWheel: SKShapeNode
    let color: SKColor
    let isRemote: Bool

    private weak var scene: SKScene?
    private var rearJoint:  SKPhysicsJointPin?
    private var frontJoint: SKPhysicsJointPin?

    /// Current input: -1 = full brake, 0 = coast, +1 = full gas.
    var throttle: CGFloat = 0

    init(color: SKColor, isRemote: Bool) {
        self.color = color
        self.isRemote = isRemote

        // Chassis
        let chassis = SKSpriteNode(color: color, size: Car.chassisSize)
        chassis.zPosition = 100
        self.chassis = chassis

        // Wheels
        func makeWheel() -> SKShapeNode {
            let w = SKShapeNode(circleOfRadius: Car.wheelRadius)
            w.fillColor = .darkGray
            w.strokeColor = .black
            w.lineWidth = 2
            // Little marker so rotation is visible.
            let marker = SKShapeNode(rectOf: CGSize(width: 4, height: Car.wheelRadius * 1.6))
            marker.fillColor = .lightGray
            marker.strokeColor = .clear
            w.addChild(marker)
            w.zPosition = 99
            return w
        }
        self.rearWheel  = makeWheel()
        self.frontWheel = makeWheel()
    }

    /// Add car to the scene at a world position.  Only call once per car.
    func addToScene(_ scene: SKScene, at position: CGPoint) {
        self.scene = scene

        chassis.position = position
        scene.addChild(chassis)

        rearWheel.position  = CGPoint(x: position.x - Car.wheelOffsetX,
                                      y: position.y + Car.wheelOffsetY)
        frontWheel.position = CGPoint(x: position.x + Car.wheelOffsetX,
                                      y: position.y + Car.wheelOffsetY)
        scene.addChild(rearWheel)
        scene.addChild(frontWheel)

        // Remote cars are driven purely by interpolation from server
        // snapshots — no physics bodies, no joints.  This avoids the local
        // simulation fighting with the snapshots.
        guard !isRemote else { return }

        // Chassis physics body
        let cb = SKPhysicsBody(rectangleOf: Car.chassisSize)
        cb.mass = 1.2
        cb.friction = 0.3
        cb.restitution = 0.1
        cb.linearDamping  = 0.08
        cb.angularDamping = 0.3
        cb.allowsRotation = true
        cb.categoryBitMask    = PhysicsCategory.chassis
        cb.collisionBitMask   = PhysicsCategory.terrain
        cb.contactTestBitMask = PhysicsCategory.finish
        chassis.physicsBody = cb

        // Wheels
        for w in [rearWheel, frontWheel] {
            let wb = SKPhysicsBody(circleOfRadius: Car.wheelRadius)
            wb.mass = 0.35
            wb.friction = 1.4
            wb.restitution = 0.05
            wb.angularDamping = 0.25
            wb.categoryBitMask  = PhysicsCategory.wheel
            wb.collisionBitMask = PhysicsCategory.terrain
            w.physicsBody = wb
        }

        // Pin joints that connect the wheels to the chassis.
        let world = scene.physicsWorld
        if let rb = rearWheel.physicsBody,
           let fb = frontWheel.physicsBody,
           let cb2 = chassis.physicsBody {
            let rj = SKPhysicsJointPin.joint(
                withBodyA: cb2,
                bodyB: rb,
                anchor: rearWheel.position
            )
            let fj = SKPhysicsJointPin.joint(
                withBodyA: cb2,
                bodyB: fb,
                anchor: frontWheel.position
            )
            rj.shouldEnableLimits = false
            fj.shouldEnableLimits = false
            world.add(rj)
            world.add(fj)
            self.rearJoint  = rj
            self.frontJoint = fj
        }
    }

    /// Call every physics step with the local throttle input.
    func applyInputs(dt: CGFloat) {
        guard !isRemote,
              let rb = rearWheel.physicsBody,
              let fb = frontWheel.physicsBody else { return }

        if throttle > 0 {
            // Gas: accelerate wheels forward.
            let torque = Car.maxTorque * throttle * dt
            // Negative torque == forward rotation in SpriteKit's y-up world
            // because we're driving left-to-right.
            rb.applyTorque(-torque)
            fb.applyTorque(-torque * 0.4)
            // Clamp top rotational speed.
            rb.angularVelocity = max(-Car.maxAngularSpeed, rb.angularVelocity)
            fb.angularVelocity = max(-Car.maxAngularSpeed, fb.angularVelocity)
        } else if throttle < 0 {
            // Brake / reverse: oppose current angular velocity.
            let torque = Car.brakeTorque * (-throttle) * dt
            rb.applyTorque(torque)
            fb.applyTorque(torque)
        }

        // Mid-air pitch control: gives the car a little aerial stability so
        // players can correct flips like in Hill Climb.
        if let cb = chassis.physicsBody, isInAir() {
            let corrective = -cb.angularVelocity * 0.05
            cb.applyAngularImpulse(corrective)
            if throttle != 0 {
                cb.applyAngularImpulse(throttle * 0.06)
            }
        }
    }

    /// Very coarse air check — if both wheels are a bit above the terrain
    /// we assume we're in the air.
    private func isInAir() -> Bool {
        // We let the physics world resolve it; just ensure both wheels are
        // currently not in contact.
        return (rearWheel.physicsBody?.allContactedBodies().isEmpty ?? true) &&
               (frontWheel.physicsBody?.allContactedBodies().isEmpty ?? true)
    }

    /// Lift the car back onto its wheels if it has flipped.
    func recover(at x: CGFloat, groundY: CGFloat) {
        chassis.position = CGPoint(x: x, y: groundY + 40)
        chassis.zRotation = 0
        chassis.physicsBody?.velocity = .zero
        chassis.physicsBody?.angularVelocity = 0
        rearWheel.position  = CGPoint(x: x - Car.wheelOffsetX, y: groundY + 22)
        frontWheel.position = CGPoint(x: x + Car.wheelOffsetX, y: groundY + 22)
        rearWheel.physicsBody?.velocity = .zero
        frontWheel.physicsBody?.velocity = .zero
        rearWheel.physicsBody?.angularVelocity = 0
        frontWheel.physicsBody?.angularVelocity = 0
    }

    // MARK: - Remote interpolation

    /// Smoothly move a remote car toward a network snapshot.
    func interpolateTo(position: CGPoint, rotation: CGFloat, wheelRot: CGFloat, alpha: CGFloat) {
        let p = chassis.position
        let np = CGPoint(x: p.x + (position.x - p.x) * alpha,
                         y: p.y + (position.y - p.y) * alpha)
        chassis.position = np
        chassis.zRotation += (rotation - chassis.zRotation) * alpha

        let dx = CGFloat(Car.wheelOffsetX)
        let dy = CGFloat(Car.wheelOffsetY)
        let cs = cos(chassis.zRotation)
        let sn = sin(chassis.zRotation)
        rearWheel.position = CGPoint(
            x: np.x + (-dx) * cs - dy * sn,
            y: np.y + (-dx) * sn + dy * cs
        )
        frontWheel.position = CGPoint(
            x: np.x + ( dx) * cs - dy * sn,
            y: np.y + ( dx) * sn + dy * cs
        )
        rearWheel.zRotation  += (wheelRot - rearWheel.zRotation) * alpha
        frontWheel.zRotation += (wheelRot - frontWheel.zRotation) * alpha
    }

    var worldPosition: CGPoint { chassis.position }
}
