import SwiftUI

struct MenuView: View {
    @EnvironmentObject var coord: GameCoordinator
    @State private var showingServerField = false

    var body: some View {
        VStack(spacing: 28) {
            Spacer()

            Text("HILL CLIMB")
                .font(.system(size: 44, weight: .black, design: .rounded))
                .foregroundStyle(.white)
                .kerning(4)
                .shadow(color: .orange.opacity(0.6), radius: 18)

            Text("MULTIPLAYER RACING")
                .font(.system(size: 14, weight: .semibold, design: .rounded))
                .foregroundStyle(.orange)
                .kerning(6)

            Spacer().frame(height: 20)

            // Name field
            VStack(alignment: .leading, spacing: 6) {
                Text("DRIVER NAME")
                    .font(.caption).bold().kerning(2)
                    .foregroundStyle(.secondary)
                TextField("Your name", text: $coord.playerName)
                    .textFieldStyle(.plain)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
                    .background(.white.opacity(0.08))
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                    .foregroundStyle(.white)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.words)
            }
            .padding(.horizontal, 40)

            // Server URL (collapsed by default)
            DisclosureGroup(isExpanded: $showingServerField) {
                TextField("ws://host:port/ws/racing", text: $coord.serverURL)
                    .textFieldStyle(.plain)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
                    .background(.white.opacity(0.08))
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                    .foregroundStyle(.white)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .keyboardType(.URL)
                    .padding(.top, 6)
            } label: {
                Text("SERVER")
                    .font(.caption).bold().kerning(2)
                    .foregroundStyle(.secondary)
            }
            .tint(.secondary)
            .padding(.horizontal, 40)

            // Find match button
            Button(action: coord.findMatch) {
                Text("FIND RACE")
                    .font(.system(size: 18, weight: .heavy, design: .rounded))
                    .kerning(3)
                    .foregroundStyle(.black)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 16)
                    .background(
                        LinearGradient(
                            colors: [.yellow, .orange],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )
                    .clipShape(RoundedRectangle(cornerRadius: 14))
                    .shadow(color: .orange.opacity(0.5), radius: 12, y: 4)
            }
            .padding(.horizontal, 40)
            .padding(.top, 12)
            .disabled(coord.playerName.trimmingCharacters(in: .whitespaces).isEmpty)
            .opacity(coord.playerName.trimmingCharacters(in: .whitespaces).isEmpty ? 0.4 : 1)

            if let err = coord.lastError {
                Text(err)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .padding(.horizontal, 40)
                    .multilineTextAlignment(.center)
            }

            Spacer()

            Text("Left half = brake  ·  Right half = gas")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .padding(.bottom, 20)
        }
    }
}

#Preview {
    MenuView()
        .environmentObject(GameCoordinator())
        .background(.black)
}
