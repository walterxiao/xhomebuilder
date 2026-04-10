import SwiftUI

struct ResultsView: View {
    @EnvironmentObject var coord: GameCoordinator
    let rankings: [FinishEntry]

    var body: some View {
        VStack(spacing: 20) {
            Text("RESULTS")
                .font(.system(size: 28, weight: .black, design: .rounded))
                .kerning(4)
                .foregroundStyle(.white)
                .padding(.top, 60)

            VStack(spacing: 10) {
                ForEach(rankings) { entry in
                    HStack {
                        Text("\(entry.place).")
                            .frame(width: 36, alignment: .leading)
                            .foregroundStyle(entry.place == 1 ? .yellow : .white)
                            .font(.system(size: 18, weight: .heavy, design: .rounded))
                        Text(entry.name)
                            .foregroundStyle(.white)
                            .font(.system(size: 16, weight: .semibold, design: .rounded))
                        Spacer()
                        if let ms = entry.finishMs {
                            Text(formatTime(ms: ms))
                                .font(.system(size: 16, weight: .medium, design: .monospaced))
                                .foregroundStyle(.secondary)
                        } else if let d = entry.distance {
                            Text(String(format: "%.0fm", d))
                                .font(.system(size: 16, weight: .medium, design: .monospaced))
                                .foregroundStyle(.secondary)
                        } else {
                            Text("DNF")
                                .font(.caption).bold()
                                .foregroundStyle(.red)
                        }
                    }
                    .padding(.horizontal, 18)
                    .padding(.vertical, 12)
                    .background(
                        entry.place == 1
                            ? Color.yellow.opacity(0.12)
                            : Color.white.opacity(0.06)
                    )
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                }
            }
            .padding(.horizontal, 30)

            Spacer()

            Button(action: {
                coord.leaveToMenu()
                coord.findMatch()
            }) {
                Text("RACE AGAIN")
                    .font(.system(size: 16, weight: .heavy, design: .rounded))
                    .kerning(3)
                    .foregroundStyle(.black)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .background(
                        LinearGradient(
                            colors: [.yellow, .orange],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )
                    .clipShape(RoundedRectangle(cornerRadius: 12))
            }
            .padding(.horizontal, 40)

            Button(action: coord.leaveToMenu) {
                Text("MAIN MENU")
                    .font(.system(size: 14, weight: .bold, design: .rounded))
                    .kerning(2)
                    .foregroundStyle(.white)
                    .padding(.vertical, 12)
            }
            .padding(.bottom, 30)
        }
    }

    private func formatTime(ms: Int) -> String {
        let totalSeconds = Double(ms) / 1000.0
        let minutes = Int(totalSeconds) / 60
        let seconds = totalSeconds.truncatingRemainder(dividingBy: 60)
        return String(format: "%d:%06.3f", minutes, seconds)
    }
}
