import SwiftUI

@main
struct SporerApp: App {
    @State private var app: AppModel = {
        // The server, or with -mock the prototype's made-up data (screenshots, and trying the app with no server).
        let service: any SporerService = ProcessInfo.processInfo.arguments.contains("-mock") ? MockService.shared : HTTPService()
        let app = AppModel(service: service)
        app.applyLaunchArguments()
        #if DEBUG
        DebugSnapshot.scheduleIfAsked()
        #endif
        return app
    }()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(\.appModel, app)
        }
        .commands {
            SporerCommands(app: app)
        }
    }
}

/// The Go menu on Mac and the keyboard shortcuts on iPad.
struct SporerCommands: Commands {
    let app: AppModel

    var body: some Commands {
        CommandMenu("Go") {
            Button("Previous Day") { app.day = app.day.adding(days: -1); app.section = .day }
                .keyboardShortcut(.leftArrow, modifiers: .command)
            Button("Next Day") { app.day = app.day.adding(days: 1); app.section = .day }
                .keyboardShortcut(.rightArrow, modifiers: .command)
            Button("Today") { app.day = .today; app.section = .day }
                .keyboardShortcut("t", modifiers: .command)
            Divider()
            ForEach(Array(AppSection.allCases.enumerated()), id: \.element) { index, section in
                Button(section.title) { app.section = section }
                    .keyboardShortcut(KeyEquivalent(Character("\(index + 1)")), modifiers: .command)
            }
        }
    }
}
