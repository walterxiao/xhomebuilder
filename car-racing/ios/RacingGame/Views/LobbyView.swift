import SwiftUI

struct LobbyView: View {
    @EnvironmentObject var coord: GameCoordinator
    @State private var now: Date = Date()
    private let tick = Timer.publish(every: 0.1, on: .main, in: .common).autoconnect()

    var body: some View {
        VStack(spacing: 24) {
            Text("MATCHMAKING")
                .font(.system(size: 22, weight: .black, design: .rounded))
                .kerning(4)
                .foregroundStyle(.white)
                .padding(.top, 60)

            Text(coord.connectionStatus)
                .font(.caption)
                .foregroundStyle(.secondary)

            if let endsAt = coord.countdownEndsAt {
                let remaining = max(0, endsAt.timeIntervalSince(now))
                VStack(spacing: 4) {
                    Text("STARTING IN")
                        .font(.caption).bold().kerning(2)
                        .foregroundStyle(.secondary)
                    Text(String(format: "%.1fs", remaining))
                        .font(.system(size: 52, weight: .black, design: .rounded))
                        .foregroundStyle(.orange)
                        .shadow(color: .orange.opacity(0.6), radius: 16)
                }
                .padding(.vertical, 8)
            } else {
                Text("WAITING FOR RACERS…")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .padding(.vertical, 8)
            }

            VStack(spacing: 10) {
                ForEach(coord.lobbyPlayers) { player in
                    HStack(spacing: 14) {
                        Circle()
                            .fill(Color(hex: player.colorHex) ?? .gray)
                            .frame(width: 16, height: 16)
                        Text(player.name)
                            .foregroundStyle(.white)
                            .font(.system(size: 16, weight: .semibold, design: .rounded))
                        Spacer()
                        if player.id == coord.net.youId {
                            Text("YOU")
                                .font(.caption2).bold().kerning(1.5)
                                .foregroundStyle(.yellow)
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                    .background(.white.opacity(0.06))
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                }
                if coord.lobbyPlayers.isEmpty {
                    Text("Connecting…")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding()
                }
            }
            .padding(.horizontal, 40)

            Spacer()

            Button(action: coord.leaveToMenu) {
                Text("CANCEL")
                    .font(.system(size: 14, weight: .bold, design: .rounded))
                    .kerning(2)
                    .foregroundStyle(.white)
                    .padding(.horizontal, 32)
                    .padding(.vertical, 12)
                    .background(.white.opacity(0.1))
                    .clipShape(Capsule())
            }
            .padding(.bottom, 40)
        }
        .onReceive(tick) { now = $0 }
    }
}

extension Color {
    /// Parse "#rrggbb" (with or without leading `#`).
    init?(hex: String) {
        var s = hex.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("#") { s.removeFirst() }
        guard s.count == 6, let v = UInt32(s, radix: 16) else { return nil }
        let r = Double((v >> 16) & 0xff) / 255.0
        let g = Double((v >>  8) & 0xff) / 255.0
        let b = Double( v        & 0xff) / 255.0
        self = Color(red: r, green: g, blue: b)
    }
}
