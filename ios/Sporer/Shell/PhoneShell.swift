import SwiftUI

/// iPhone: the map fills the screen, and the panels live in a sheet that stays, with the sections as its tab bar,
/// as in Find My and Apple Maps. The sheet rests at a peek, half way, or full height.
struct PhoneShell: View {
    @Environment(\.appModel) private var app

    var body: some View {
        @Bindable var app = app
        ZStack {
            AppMap()
            MapControls()
            AreaSelectionLayer()
            ToastOverlay(center: app.toasts)
        }
        .sheet(isPresented: .constant(true)) {
            SheetContent()
                .presentationDetents(SheetDetents.all, selection: $app.detent)
                .presentationBackgroundInteraction(.enabled(upThrough: SheetDetents.medium))
                .presentationDragIndicator(.visible)
                .modifier(DarkSheetBackground())
                .interactiveDismissDisabled()
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height in
                    app.map.obscured.bottom = min(height, 460)
                    app.map.obscured.trailing = MapControls.columnWidth // the glass buttons down the right
                    app.map.obscured.top = MapControls.rowHeight // and across the top
                }
                .sheet(isPresented: $app.isShowingSettings) {
                    SettingsView()
                }
                .sheet(item: Binding(get: { app.map.editing?.inspected }, set: { app.map.editing?.inspected = $0 })) { point in
                    PointCardView(point: point)
                        .presentationDetents([.height(320), .medium, .large])
                        .presentationBackgroundInteraction(.enabled(upThrough: .medium))
                }
        }
    }
}

/// The sections as tabs, inside the sheet.
struct SheetContent: View {
    @Environment(\.appModel) private var app

    var body: some View {
        @Bindable var app = app
        TabView(selection: $app.section) {
            ForEach(AppSection.allCases) { section in
                Tab(section.title, systemImage: section.symbol, value: section) {
                    SectionStack(section: section)
                        .toolbar(app.map.editing == nil ? .automatic : .hidden, for: .tabBar)
                }
            }
        }
    }
}

extension RawPoint: Identifiable {
    nonisolated var id: Int64 { t }
}

/// In dark mode the half-height sheet's clear glass picks up the map and turns pale behind white text;
/// a dark material keeps it legible there. Light mode keeps the system's glass.
private struct DarkSheetBackground: ViewModifier {
    @Environment(\.colorScheme) private var scheme

    func body(content: Content) -> some View {
        if scheme == .dark {
            content.presentationBackground(.ultraThickMaterial)
        } else {
            content
        }
    }
}
