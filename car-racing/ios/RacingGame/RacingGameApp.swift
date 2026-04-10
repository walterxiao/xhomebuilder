import SwiftUI

@main
struct RacingGameApp: App {
    @StateObject private var coordinator = GameCoordinator()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(coordinator)
                .preferredColorScheme(.dark)
                .statusBar(hidden: true)
                .persistentSystemOverlays(.hidden)
        }
    }
}
