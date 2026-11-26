import MapKit
import SwiftUI

/// What the map draws. Each screen says what it wants drawn (see `.mapScene(_:)`), and the map draws what the top-most screen of
/// the section on show wants (`AppModel.updateMapScene`).
nonisolated enum MapScene: Sendable, Equatable {
    case empty
    case day(DayResponse)
    case range(RangeResponse)
    case trips([TripListItem])
    case trip(TripResponse)
    /// A place, its pin, and the places round it as dots (`around`, every place in use: the place itself is left out of them).
    case place(PlaceResponse, around: [MapPlace])
    /// Every place in use, as dots.
    case places([MapPlace])

    /// Which drawing this is: the map refits only when this changes. A refresh of the same drawing (new routes after an edit, a
    /// place renamed) keeps it, and is redrawn without moving the map (`MapModel.contentVersion`).
    var key: String {
        switch self {
        case .empty: "empty"
        case .day(let d): "day-\(d.date)-\(d.segments.count)-\(d.segments.last?.end.timeIntervalSince1970 ?? 0)"
        case .range(let r): "range-\(r.from)-\(r.to)-\(r.moves.count)"
        case .trips(let t): "trips-\(t.map(\.id).joined(separator: ","))"
        case .trip(let t): "trip-\(t.id)-\(t.moves.count)"
        case .place(let p, _): "place-\(p.id)-\(p.name ?? "")"
        // The same drawing whatever is in it: a merge takes places off without moving the map.
        case .places: "places"
        }
    }

    /// The dates the heat layer covers for this drawing, when it has one.
    var heatSpan: (LocalDate, LocalDate)? {
        switch self {
        case .day(let d): (d.date, d.date)
        case .range(let r): (r.from, r.to)
        case .trip(let t): (t.localStartDate, min(t.localEndDate, t.localStartDate.adding(days: 399)))
        default: nil
        }
    }
}

/// What the map is asked to bring into view, beyond the whole drawing.
nonisolated enum MapFocus: Equatable, Sendable {
    case segment(String)
    case coordinate(Double, Double)
    /// All of these places, close: a place and the places round it that merge mode picks from.
    case area([LonLat])
}

nonisolated enum MapStyleChoice: String, CaseIterable, Identifiable, Sendable {
    case muted, standard, hybrid, satellite
    var id: String { rawValue }
    var title: String {
        switch self {
        case .muted: "Muted"
        case .standard: "Standard"
        case .hybrid: "Hybrid"
        case .satellite: "Satellite"
        }
    }
}

/// Edit mode's points and selection, drawn by the map and changed by both the map (taps, area) and the panel.
@Observable
final class EditPointsModel {
    var date: LocalDate
    var devices: [String] = []
    var points: [RawPoint] = []
    var selected: Set<Int64> = []
    var isLoading = true
    var isSelectingArea = false
    var inspected: RawPoint?

    init(date: LocalDate) {
        self.date = date
    }

    var ignoredCount: Int { points.filter { $0.status.isIgnored }.count }

    func toggle(_ point: RawPoint) {
        if selected.contains(point.t) { selected.remove(point.t) } else { selected.insert(point.t) }
    }
}

/// Merge mode of a place: the places picked on the map (or in the list) to merge into it. A tap on a place picks it instead of opening it.
@Observable
final class PlaceMergeModel {
    /// The place they go into: the place on show, which survives.
    let into: Int
    /// In the order they were picked.
    private(set) var picked: [Int] = []

    init(into: Int) {
        self.into = into
    }

    /// Picks a place, or takes it off; the place they go into is never picked (a tap on its own pin does nothing).
    func toggle(_ id: Int) {
        guard id != into else { return }
        if let i = picked.firstIndex(of: id) { picked.remove(at: i) } else { picked.append(id) }
    }
}

@Observable
final class MapModel {
    private(set) var scene: MapScene = .empty
    /// Bumped to ask the map to fit the whole drawing again.
    private(set) var fitRequest = 0
    var focus: MapFocus?
    var heat: HeatResponse?
    var isHeatOn: Bool = UserDefaults.standard.bool(forKey: "heat") {
        didSet { UserDefaults.standard.set(isHeatOn, forKey: "heat") }
    }
    var fadeRoutes: Bool = UserDefaults.standard.object(forKey: "fadeRoutes") as? Bool ?? true {
        didSet { UserDefaults.standard.set(fadeRoutes, forKey: "fadeRoutes") }
    }
    var style: MapStyleChoice = MapStyleChoice(rawValue: UserDefaults.standard.string(forKey: "mapStyle") ?? "") ?? .muted {
        didSet { UserDefaults.standard.set(style.rawValue, forKey: "mapStyle") }
    }
    var editing: EditPointsModel?
    var merging: PlaceMergeModel?

    /// Ends merge mode, and lets go of where it brought the map, so that the next one brings it there again.
    func endMerging() {
        merging = nil
        if case .area = focus { focus = nil }
    }

    /// The insets of the map that the sheet, sidebar or bars cover.
    var obscured = EdgeInsets()

    /// Turns a rectangle of the map's view into the map rect it covers (set by the map, used by area selection).
    @ObservationIgnored var areaToRect: ((CGRect) -> MKMapRect?)?

    /// Bumped when the drawing on show is replaced by a newer answer for the same drawing: the map redraws it where it is.
    private(set) var contentVersion = 0

    func show(_ scene: MapScene) {
        guard scene.key != self.scene.key else {
            if scene != self.scene {
                self.scene = scene
                contentVersion += 1
            }
            return
        }
        // The glow of another stretch of days under this drawing would be wrong; the same days' glow stays until it is reloaded.
        if !Self.sameSpan(scene.heatSpan, self.scene.heatSpan) { heat = nil }
        self.scene = scene
        focus = nil
    }

    private static func sameSpan(_ a: (LocalDate, LocalDate)?, _ b: (LocalDate, LocalDate)?) -> Bool {
        switch (a, b) {
        case (nil, nil): true
        case let (a?, b?): a.0 == b.0 && a.1 == b.1
        default: false
        }
    }

    func recenter() {
        focus = nil
        fitRequest += 1
    }

    var canShowHeat: Bool { scene.heatSpan != nil && editing == nil }
}

private struct MapSceneModifier: ViewModifier {
    @Environment(\.appModel) private var app
    @Environment(\.mapClaimant) private var claimant
    @State private var token = UUID()
    let scene: MapScene?

    func body(content: Content) -> some View {
        content
            .onAppear { if let scene { app.claimMap(scene, by: claimant, token: token) } }
            .onChange(of: scene) { if let scene { app.claimMap(scene, by: claimant, token: token) } }
            .onDisappear { app.releaseMap(claimant, token: token) }
    }
}

extension View {
    /// Says what the map should draw while this screen is the one shown.
    func mapScene(_ scene: MapScene?) -> some View {
        modifier(MapSceneModifier(scene: scene))
    }
}
