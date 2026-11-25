import SwiftUI

/// Settings, modelled on iOS Settings: one grouped Form whose sections each load (and fail) on their own.
/// Presented as a sheet with its own navigation stack and a Done button. Every alert, sheet and dialog hangs
/// here, once, never on a section.
struct SettingsView: View {
    @Environment(\.appModel) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var model = SettingsModel()
    @State private var isSettingHome = false
    @State private var isConfirmingClose = false

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                Form {
                    if model.isUnreachable {
                        UnreachableSection(model: model)
                    } else {
                        HomeSection(model: model, setHome: { isSettingHome = true })
                        TripDistanceSection(model: model)
                        DeletedTripsSection(model: model)
                        RemovedPointsSection(model: model)
                        ProcessingSection(model: model)
                        FailedPeriodsSection(model: model)
                    }
                    MapSection()
                    ServerSection(model: model)
                    AboutSection(model: model).id("settings-about")
                }
                .refreshable { await model.loadAll() }
                .task {
                    model.bind(app)
                    await model.loadAll()
                    debugScroll(proxy)
                    while !Task.isCancelled {
                        try? await Task.sleep(for: .seconds(30))
                        if !Task.isCancelled { await model.loadStatus() }
                    }
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        if model.tripIsChanged { isConfirmingClose = true } else { dismiss() }
                    }
                }
            }
            .interactiveDismissDisabled(model.tripIsChanged)
            .overlay(alignment: .top) { ToastOverlay(center: app.toasts).padding(.top, -40) }
        }
        .sheet(isPresented: $isSettingHome) {
            SetHomeFlow { name in
                isSettingHome = false
                Task { await model.homeAdded(name) }
            } onGone: {
                isSettingHome = false
                Task { await model.loadHomes() }
            }
        }
        .confirmationDialog(
            "Remove this home?",
            isPresented: Binding(get: { model.pendingRemoval != nil }, set: { if !$0 { model.pendingRemoval = nil } }),
            titleVisibility: .visible, presenting: model.pendingRemoval
        ) { period in
            Button("Remove Home", role: .destructive) { Task { await model.removeHome(period) } }
            Button("Cancel", role: .cancel) {}
        } message: { period in
            Text("\(Format.placeName(period.placeName)), \(HomePeriodRow.dates(period)). The home that was detected for these dates applies again.")
        }
        .confirmationDialog("Save the new trip distance?", isPresented: $isConfirmingClose, titleVisibility: .visible) {
            if let km = model.tripValue {
                Button("Save and Close") { Task { await model.saveTrip(km); if !model.tripIsChanged { dismiss() } } }
            }
            Button("Discard Changes", role: .destructive) { dismiss() }
            Button("Keep Editing", role: .cancel) {}
        }
        .alert(
            model.failure?.title ?? "",
            isPresented: Binding(get: { model.failure != nil }, set: { if !$0 { model.failure = nil } }),
            presenting: model.failure
        ) { failure in
            if let retry = failure.retry { Button("Retry", action: retry) }
            Button("OK", role: .cancel) {}
        } message: { failure in
            Text(failure.message)
        }
        .onAppear { if SettingsDebug.flag("-settingsSetHome") || SettingsDebug.flag("-settingsSetHomeForm") { isSettingHome = true } }
    }

    /// `-settingsScroll about|removed|deleted|map|trips|home|processing|server` scrolls to a section, for screenshots.
    private func debugScroll(_ proxy: ScrollViewProxy) {
        #if DEBUG
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: "-settingsScroll"), args.indices.contains(i + 1) else { return }
        let target = "settings-" + args[i + 1]
        Task {
            try? await Task.sleep(for: .milliseconds(500))
            proxy.scrollTo(target, anchor: .top)
        }
        #endif
    }
}

/// One banner when the server can't be reached at all, instead of an error in every section.
struct UnreachableSection: View {
    let model: SettingsModel

    var body: some View {
        Section {
            ContentUnavailableView {
                Label("Can't Connect", systemImage: "wifi.exclamationmark")
            } description: {
                Text(model.status.error?.localizedDescription ?? "The server can't be reached. Are you on the VPN?")
            } actions: {
                Button("Try Again") { Task { await model.loadAll() } }
                    .buttonStyle(.glass)
            }
            .listRowBackground(Color.clear)
        }
    }
}

/// Where a debug launch flag asks for a failure or a state (`-settingsFail home`), so error rows can be looked at.
enum SettingsDebug {
    static func fails(_ section: String) -> Bool {
        #if DEBUG
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: "-settingsFail"), args.indices.contains(i + 1) else { return false }
        let list = args[i + 1].split(separator: ",")
        return list.contains(Substring(section)) || list.contains("all")
        #else
        false
        #endif
    }

    static func flag(_ name: String) -> Bool {
        #if DEBUG
        ProcessInfo.processInfo.arguments.contains(name)
        #else
        false
        #endif
    }
}
