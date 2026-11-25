import SwiftUI

/// Map: the style of the base map and how strongly long periods draw their routes. Both apply at once.
struct MapSection: View {
    @Environment(\.appModel) private var app

    var body: some View {
        @Bindable var map = app.map
        Section {
            Picker("Map Style", selection: $map.style) {
                ForEach(MapStyleChoice.allCases) { style in
                    Text(style.title).tag(style)
                }
            }
            Toggle("Fade Routes in Weeks, Months and Years", isOn: $map.fadeRoutes)
        } header: {
            Text("Map")
        } footer: {
            Text("Off draws them as strongly as a day's.")
        }
        .id("settings-map")
    }
}
