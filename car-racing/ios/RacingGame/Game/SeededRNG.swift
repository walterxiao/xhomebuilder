import Foundation

/// Deterministic PRNG so both iOS clients generate the exact same terrain
/// from the same 32-bit seed the server sends. Mulberry32 is small, fast,
/// and well-distributed enough for cosmetic procedural content.
struct SeededRNG {
    private var state: UInt32

    init(seed: UInt32) {
        // Avoid zero state.
        self.state = seed == 0 ? 0x9e3779b9 : seed
    }

    /// Next value in `[0, 1)`.
    mutating func next() -> Double {
        state = state &+ 0x6D2B79F5
        var t: UInt32 = state
        t = (t ^ (t >> 15)) &* (t | 1)
        t = t &+ ((t ^ (t >> 7)) &* (t | 61))
        let r = UInt32(t ^ (t >> 14))
        return Double(r) / Double(UInt32.max)
    }

    /// Uniform value in `[lo, hi)`.
    mutating func range(_ lo: Double, _ hi: Double) -> Double {
        lo + (hi - lo) * next()
    }
}
