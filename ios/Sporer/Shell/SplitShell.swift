import SwiftUI

/// iPad and Mac: the sections in a sidebar, the panel of the section beside it, and the map filling the rest.
struct SplitShell: View {
    @Environment(\.appModel) private var app
    @State private var visibility = NavigationSplitViewVisibility.all

    var body: some View {
        @Bindable var app = app
        NavigationSplitView(columnVisibility: $visibility) {
            List(selection: Binding<AppSection?>(get: { app.section }, set: { if let s = $0 { app.section = s } })) {
                ForEach(AppSection.allCases) { section in
                    Label(section.title, systemImage: section.symbol)
                        .tag(section)
                }
            }
            .navigationTitle("Sporer")
            .navigationSplitViewColumnWidth(min: 180, ideal: 200, max: 260)
            .safeAreaInset(edge: .bottom) {
                Button {
                    app.isShowingSettings = true
                } label: {
                    Label("Settings", systemImage: "gearshape")
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(.borderless)
                .padding()
            }
        } content: {
            SectionStack(section: app.section)
                .id(app.section)
                .navigationSplitViewColumnWidth(min: 320, ideal: 380, max: 460)
        } detail: {
            ZStack {
                AppMap()
                    .backgroundExtensionEffect()
                MapControls()
                AreaSelectionLayer()
                ToastOverlay(center: app.toasts)
            }
        }
        .onAppear { app.map.obscured = EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: MapControls.columnWidth) }
        .sheet(isPresented: $app.isShowingSettings) {
            SettingsView()
                .frame(minWidth: 520, minHeight: 640)
        }
        .sheet(item: Binding(get: { app.map.editing?.inspected }, set: { app.map.editing?.inspected = $0 })) { point in
            PointCardView(point: point)
                .frame(minWidth: 420, minHeight: 520)
        }
    }
}
