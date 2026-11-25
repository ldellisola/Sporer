import SwiftUI

/// The map with a sheet over it on iPhone; a sidebar, a panel and the map side by side on iPad and Mac.
struct RootView: View {
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.appModel) private var app

    var body: some View {
        Group {
            if sizeClass == .compact {
                PhoneShell()
            } else {
                SplitShell()
            }
        }
        .onChange(of: scenePhase) { app.scenePhaseChanged(to: scenePhase) }
    }
}

/// One section's navigation stack: its root panel, and the days, places and trips pushed onto it.
struct SectionStack: View {
    @Environment(\.appModel) private var app
    let section: AppSection

    var body: some View {
        NavigationStack(path: app.path(for: section)) {
            root
                .environment(\.mapClaimant, MapClaimant(section: section, depth: 0))
                .navigationDestination(for: Route.self) { route in
                    Group {
                        switch route {
                        case .day(let date): DayPanel(pinned: date)
                        case .place(let id): PlaceDetailView(placeID: id)
                        case .trip(let id): TripDetailView(tripID: id)
                        }
                    }
                    .environment(\.mapClaimant, MapClaimant(section: section, depth: depth(of: route)))
                }
        }
    }

    /// How deep the screen of `route` is in the stack: 1 for the first screen pushed.
    private func depth(of route: Route) -> Int {
        ((app.paths[section] ?? []).lastIndex(of: route) ?? 0) + 1
    }

    @ViewBuilder private var root: some View {
        switch section {
        case .day: DayPanel(pinned: nil)
        case .explore: ExplorePanel()
        case .trips: TripsPanel()
        case .places: PlacesPanel()
        }
    }
}

/// The map, wired to open places and pick points.
struct AppMap: View {
    @Environment(\.appModel) private var app

    var body: some View {
        SporerMapView(
            model: app.map,
            onOpenPlace: { id in
                app.open(.place(id))
                if app.detent == SheetDetents.peek { app.detent = SheetDetents.medium }
            },
            onTapPoint: { point in
                guard let editing = app.map.editing, !EditGate.shared.isRemoving else { return }
                editing.toggle(point)
                if !editing.isSelectingArea { editing.inspected = point }
            }
        )
        .ignoresSafeArea()
    }
}
