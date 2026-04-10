import SwiftUI

struct RootView: View {
    @EnvironmentObject var coord: GameCoordinator

    var body: some View {
        ZStack {
            // Each screen pushes itself full-bleed; the background matches so
            // transitions feel consistent.
            LinearGradient(
                colors: [Color(red: 0.05, green: 0.07, blue: 0.18),
                         Color(red: 0.10, green: 0.13, blue: 0.26)],
                startPoint: .top,
                endPoint: .bottom
            )
            .ignoresSafeArea()

            switch coord.screen {
            case .menu:
                MenuView()
            case .lobby:
                LobbyView()
            case .race(let seed, let len, let start, let players, let you):
                GameContainerView(seed: seed,
                                  trackLength: len,
                                  startTime: start,
                                  players: players,
                                  youId: you)
            case .results(let rankings):
                ResultsView(rankings: rankings)
            }
        }
    }
}
