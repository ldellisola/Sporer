import MapKit
import SwiftUI

/// The full-screen map: MapKit's map with the routes, stops, places, heat and edit-mode points of the screen shown.
struct SporerMapView: UIViewRepresentable {
    let model: MapModel
    var onOpenPlace: (Int) -> Void
    var onTapPoint: (RawPoint) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> MKMapView {
        let map = MKMapView()
        map.delegate = context.coordinator
        map.isRotateEnabled = false
        map.showsCompass = false
        map.showsScale = false
        map.showsUserLocation = false
        map.register(StopAnnotationView.self, forAnnotationViewWithReuseIdentifier: StopAnnotationView.reuseID)
        map.register(DotLabelAnnotationView.self, forAnnotationViewWithReuseIdentifier: DotLabelAnnotationView.reuseID)
        let tap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.tapped(_:)))
        tap.delegate = context.coordinator
        map.addGestureRecognizer(tap)
        context.coordinator.map = map
        model.areaToRect = { [weak map] rect in
            guard let map else { return nil }
            let a = MKMapPoint(map.convert(rect.origin, toCoordinateFrom: map))
            let b = MKMapPoint(map.convert(CGPoint(x: rect.maxX, y: rect.maxY), toCoordinateFrom: map))
            return MKMapRect(x: min(a.x, b.x), y: min(a.y, b.y), width: abs(a.x - b.x), height: abs(a.y - b.y))
        }
        return map
    }

    func updateUIView(_ map: MKMapView, context: Context) {
        context.coordinator.parent = self
        context.coordinator.update(map, model: model)
    }

    @MainActor
    final class Coordinator: NSObject, MKMapViewDelegate, UIGestureRecognizerDelegate {
        var parent: SporerMapView
        weak var map: MKMapView?

        private var drawnKey = ""
        private var fittedKey = ""
        private var fitRequest = 0
        private var focus: MapFocus?
        private var style: MapStyleChoice?
        private var edgeInsets = UIEdgeInsets.zero
        private var tappableDots: DotsOverlay?
        private var editDots: DotsOverlay?
        private var editPoints: [Int64: RawPoint] = [:]
        private var segmentRects: [String: MKMapRect] = [:]
        private var wholeRect: MKMapRect?
        /// Where the globe faces when the drawing is too wide for a flat map: home for the trips, else the drawing's middle.
        private var globeCenter: CLLocationCoordinate2D?

        init(_ parent: SporerMapView) {
            self.parent = parent
        }

        func update(_ map: MKMapView, model: MapModel) {
            if style != model.style {
                style = model.style
                map.preferredConfiguration = switch model.style {
                // Realistic elevation: flat-looking from above, and a globe when zoomed far out, as in Apple Maps.
                case .muted: MKStandardMapConfiguration(elevationStyle: .realistic, emphasisStyle: .muted)
                case .standard: MKStandardMapConfiguration(elevationStyle: .realistic, emphasisStyle: .default)
                case .hybrid: MKHybridMapConfiguration(elevationStyle: .realistic)
                case .satellite: MKImageryMapConfiguration(elevationStyle: .realistic)
                }
                if model.style == .muted, let config = map.preferredConfiguration as? MKStandardMapConfiguration {
                    config.pointOfInterestFilter = .excludingAll
                }
            }

            let insets = UIEdgeInsets(top: model.obscured.top, left: model.obscured.leading, bottom: model.obscured.bottom, right: model.obscured.trailing)
            let insetsChanged = insets != edgeInsets
            edgeInsets = insets

            let editing = model.editing
            let editKey = editing.map { "edit-\($0.points.count)-\($0.selected.hashValue)-\($0.isLoading)" } ?? ""
            let heatKey = model.isHeatOn && model.canShowHeat ? "heat-\(model.heat?.cells.count ?? -1)" : ""
            let key = "\(model.scene.key)#\(model.contentVersion)|\(heatKey)|\(model.fadeRoutes)|\(editKey)"
            if key != drawnKey {
                drawnKey = key
                draw(model, on: map)
            }

            let sceneKey = model.scene.key + (model.editing.map { $0.points.isEmpty ? "|edit-empty" : "|edit" } ?? "")
            if sceneKey != fittedKey || model.fitRequest != fitRequest {
                fittedKey = sceneKey
                fitRequest = model.fitRequest
                focus = nil
                fit(wholeRect, on: map, animated: true)
            } else if model.focus != focus {
                focus = model.focus
                switch model.focus {
                case .segment(let id): fit(segmentRects[id], on: map, animated: true, minimumSpan: 600)
                case .coordinate(let lat, let lon): fit(Geo.rect([CLLocationCoordinate2D(latitude: lat, longitude: lon)]), on: map, animated: true, minimumSpan: 800)
                case nil: break
                }
                for annotation in map.annotations {
                    guard let stop = annotation as? StopAnnotation, let view = map.view(for: stop) as? StopAnnotationView else { continue }
                    if case .segment(let id) = model.focus { view.isStopFocused = stop.segmentIDs.contains(id) } else { view.isStopFocused = false }
                }
            } else if insetsChanged, focus == nil {
                fit(wholeRect, on: map, animated: true)
            }
        }

        // MARK: Drawing

        private func draw(_ model: MapModel, on map: MKMapView) {
            map.removeOverlays(map.overlays)
            map.removeAnnotations(map.annotations)
            segmentRects = [:]
            tappableDots = nil
            editDots = nil
            editPoints = [:]

            let showHeat = model.isHeatOn && model.canShowHeat && !(model.heat?.cells.isEmpty ?? true)
            if showHeat, let heat = model.heat {
                map.addOverlay(HeatOverlay(heat), level: .aboveRoads)
            }
            let faded: CGFloat = showHeat ? 0.2 : 1
            var coords: [CLLocationCoordinate2D] = []
            /// What the map is fitted to, when it is not the whole drawing.
            var framed: [CLLocationCoordinate2D]?

            switch model.scene {
            case .empty:
                break

            case .day(let day):
                var lines: [(Mode?, [LonLat], String)] = []
                var stops: [Int: (PlaceRef?, [String], [String], Bool)] = [:]
                var order: [Int] = []
                var number = 0
                var stayed: [Int: TimeInterval] = [:]
                for segment in day.segments {
                    switch segment {
                    case .move(let m):
                        guard m.geometry.count > 1 else { continue }
                        lines.append((m.mode, m.geometry, segment.id))
                        coords += m.geometry.map(\.coordinate)
                    case .stay(let s):
                        guard let p = s.place else { continue }
                        stayed[p.id, default: 0] += s.end.timeIntervalSince(s.start)
                        var entry = stops[p.id] ?? (p, [], [], s.home)
                        if !s.home {
                            number += 1
                            entry.1.append("\(number)")
                        }
                        entry.2.append(segment.id)
                        if stops[p.id] == nil { order.append(p.id) }
                        stops[p.id] = entry
                        segmentRects[segment.id] = Geo.rect([p.coordinate])
                        coords.append(p.coordinate)
                    case .gap:
                        break
                    }
                }
                addRoutes(lines, bold: true, alpha: faded, on: map)
                // Where names collide, the place with the most time keeps its name.
                let ranked = order.sorted { (stayed[$0] ?? 0) > (stayed[$1] ?? 0) }
                for id in order {
                    guard let (place, numbers, segments, home) = stops[id], let place else { continue }
                    map.addAnnotation(StopAnnotation(coordinate: place.coordinate, placeID: place.id, label: numbers.joined(separator: " · "),
                                                     isHome: home, name: Format.placeName(place.name), segmentIDs: segments,
                                                     rank: ranked.firstIndex(of: id) ?? 0))
                }

            case .range(let range):
                let lines = range.moves.map { ($0.mode, $0.geometry, "move-\($0.id)") }
                addRoutes(lines, bold: false, alpha: (model.fadeRoutes ? 0.35 : 1) * faded, on: map)
                coords += range.moves.flatMap { $0.geometry.map(\.coordinate) }
                coords += range.places.map(\.coordinate)
                addPlaceDots(range.places.map { ($0.coordinate, $0.seconds, Format.placeName($0.name, city: $0.city), Int64($0.id)) },
                             labelled: 5, drawing: coords, on: map)

            case .trips(let trips):
                var cities: [String: (CLLocationCoordinate2D, Double, String)] = [:]
                for city in trips.flatMap(\.cities) {
                    let key = "\(city.name)|\(city.country ?? "")"
                    var entry = cities[key] ?? (city.coordinate, 0, city.name)
                    let total = entry.1 + Double(city.nights)
                    entry.0 = CLLocationCoordinate2D(latitude: (entry.0.latitude * entry.1 + city.lat * Double(city.nights)) / max(total, 1),
                                                     longitude: (entry.0.longitude * entry.1 + city.lon * Double(city.nights)) / max(total, 1))
                    entry.1 = total
                    cities[key] = entry
                }
                let items = cities.values.map { ($0.0, $0.1, Format.nights($0.2, Int($0.1)), Int64(0)) }
                coords += items.map(\.0)
                addPlaceDots(items, labelled: 5, drawing: coords, on: map)

            case .trip(let trip):
                let lines = trip.moves.map { ($0.mode, $0.geometry, "move-\($0.id)") }
                addRoutes(lines, bold: true, alpha: faded, on: map)
                coords += trip.moves.flatMap { $0.geometry.map(\.coordinate) }
                let items = trip.cities.map { ($0.coordinate, Double($0.nights), Format.nights($0.name, $0.nights), Int64(0)) }
                coords += items.map(\.0)
                addPlaceDots(items, labelled: .max, drawing: coords, on: map)
                // Framed on where the trip went: its cities and its moves on the ground. The flights there and back are drawn,
                // and lead off the screen towards home, which could otherwise only be shown with the whole globe.
                // Moves near home (to the airport and back) are not where it went: only those within 300 km of a city count.
                let cities = items.map(\.0)
                let ground = trip.moves.filter { $0.mode != .flight }.flatMap { $0.geometry.map(\.coordinate) }
                let there = cities + ground.filter { point in cities.contains { Geo.distance($0, point) < 300_000 } }
                if !there.isEmpty { framed = there }

            case .place(let place):
                map.addAnnotation(StopAnnotation(coordinate: place.coordinate, placeID: nil, label: "", isHome: false,
                                                 name: Format.placeName(place.name), segmentIDs: []))
                coords.append(place.coordinate)
            }

            if let editing = model.editing {
                addEditPoints(editing, on: map)
                if coords.isEmpty { coords = editing.points.map(\.coordinate) }
            }
            wholeRect = Geo.rect(framed ?? coords)
            if case .trips(let trips) = model.scene, let home = trips.first?.thumbnail.first {
                globeCenter = home.coordinate
            } else {
                globeCenter = Geo.centroid(framed ?? coords)
            }
        }

        private func addRoutes(_ lines: [(Mode?, [LonLat], String)], bold: Bool, alpha: CGFloat, on map: MKMapView) {
            var byMode: [Mode?: [MKPolyline]] = [:]
            var flights: [MKPolyline] = []
            for (mode, geometry, id) in lines {
                let coords = geometry.map(\.coordinate)
                segmentRects[id] = Geo.rect(coords)
                if mode == .flight {
                    for (a, b) in zip(coords, coords.dropFirst()) {
                        flights.append(MKGeodesicPolyline(coordinates: [a, b], count: 2))
                    }
                } else {
                    byMode[mode, default: []].append(MKPolyline(coordinates: coords, count: coords.count))
                }
            }
            let ground = byMode.values.flatMap { $0 }
            if bold, !ground.isEmpty {
                map.addOverlay(RouteOverlay(ground, style: RouteStyle(color: .white, width: 7.5, alpha: alpha)), level: .aboveRoads)
            }
            for mode in [Mode.walk, .cycle, .drive, nil] {
                guard let polylines = byMode[mode], !polylines.isEmpty else { continue }
                map.addOverlay(RouteOverlay(polylines, style: RouteStyle(color: ModeStyle(mode: mode).uiColor, width: bold ? 4.5 : 2.4, alpha: alpha)), level: .aboveRoads)
            }
            if !flights.isEmpty {
                map.addOverlay(RouteOverlay(flights, style: RouteStyle(color: .systemOrange, width: bold ? 3.5 : 2.4, alpha: alpha, dashed: true)), level: .aboveRoads)
            }
        }

        /// Dots sized by time (or nights), the biggest labelled, as the web app draws a period's places.
        private func addPlaceDots(_ items: [(CLLocationCoordinate2D, Double, String, Int64)], labelled: Int, drawing: [CLLocationCoordinate2D], on map: MKMapView) {
            guard !items.isEmpty else { return }
            let top = items.map(\.1).max() ?? 1
            let sorted = items.sorted { $0.1 > $1.1 }
            let all = drawing.isEmpty ? sorted.map(\.0) : drawing
            let middle = (all.map(\.longitude).min()! + all.map(\.longitude).max()!) / 2
            // Smaller dots are drawn last, so they stay visible on top of bigger ones.
            let dots = sorted.reversed().map { item in
                MapDot(point: MKMapPoint(item.0), radius: 4 + 12 * sqrt(item.1 / max(top, 1)),
                       fill: UIColor.pin.withAlphaComponent(0.92), stroke: .white, strokeWidth: 2, tag: item.3)
            }
            let overlay = DotsOverlay(dots, tappable: true)
            tappableDots = overlay
            map.addOverlay(overlay, level: .aboveLabels)
            for item in sorted.prefix(labelled) {
                let radius = 4 + 12 * sqrt(item.1 / max(top, 1))
                map.addAnnotation(DotLabelAnnotation(coordinate: item.0, text: item.2, radius: radius, side: item.0.longitude <= middle ? .right : .left))
            }
        }

        private func addEditPoints(_ editing: EditPointsModel, on map: MKMapView) {
            let dark = map.traitCollection.userInterfaceStyle == .dark
            let ink: UIColor = dark ? UIColor(white: 0.95, alpha: 1) : UIColor(white: 0.11, alpha: 1)
            let halo: UIColor = dark ? UIColor(white: 0.11, alpha: 1) : .white
            let hollow: UIColor = dark ? .systemGray : UIColor(white: 0.42, alpha: 1)
            var dots: [MapDot] = []
            for p in editing.points {
                editPoints[p.t] = p
                let point = MKMapPoint(p.coordinate)
                if editing.selected.contains(p.t) {
                    dots.append(MapDot(point: point, radius: 7, fill: .systemRed, stroke: .white, strokeWidth: 2, tag: p.t))
                } else if p.status.isIgnored {
                    dots.append(MapDot(point: point, radius: 4, fill: nil, stroke: hollow, strokeWidth: 1.5, tag: p.t))
                } else {
                    dots.append(MapDot(point: point, radius: 4, fill: ink, stroke: halo, strokeWidth: 1, tag: p.t))
                }
            }
            let overlay = DotsOverlay(dots, tappable: true)
            editDots = overlay
            map.addOverlay(overlay, level: .aboveLabels)
        }

        private func fit(_ rect: MKMapRect?, on map: MKMapView, animated: Bool, minimumSpan: Double = 1200) {
            guard var rect, map.bounds.width > 0 else { return }
            // A single place or a short route: show some streets round it.
            let span = minimumSpan * MKMapPointsPerMeterAtLatitude(rect.origin.coordinate.latitude)
            if rect.width < span || rect.height < span {
                rect = rect.insetBy(dx: -max(0, span - rect.width) / 2, dy: -max(0, span - rect.height) / 2)
            }
            // The padding is counted from the safe area. Where buttons cover a side, a little room beyond them is enough.
            let pad = UIEdgeInsets(top: edgeInsets.top + (edgeInsets.top > 0 ? 16 : 40), left: edgeInsets.left + 40,
                                   bottom: edgeInsets.bottom + 40, right: edgeInsets.right + 40)
            let free = CGSize(width: max(1, map.bounds.width - pad.left - pad.right), height: max(1, map.bounds.height - pad.top - pad.bottom))
            let pointsPerMapPoint = min(Double(free.width) / rect.width, Double(free.height) / rect.height)
            // A flat map wider than a quarter of the world bends into MapKit's globe and no longer holds the rect it was asked for.
            if rect.width > MKMapRect.world.width / 4 || MKMapRect.world.width * pointsPerMapPoint < Double(map.bounds.width) * 1.6 {
                // Too wide for a flat map (trips on several continents): look at the globe instead, facing home, lifted above the sheet.
                var center = globeCenter ?? MKMapPoint(x: rect.midX, y: rect.midY).coordinate
                let lift = Double(edgeInsets.bottom - edgeInsets.top) / Double(max(1, map.bounds.height)) * 35
                center.latitude = max(-80, center.latitude - lift)
                map.setCamera(MKMapCamera(lookingAtCenter: center, fromDistance: 16_000_000, pitch: 0, heading: 0), animated: animated)
                return
            }
            map.setVisibleMapRect(rect, edgePadding: pad, animated: animated)
        }

        // MARK: Taps

        @objc func tapped(_ gesture: UITapGestureRecognizer) {
            guard let map else { return }
            let location = gesture.location(in: map)
            let point = MKMapPoint(map.convert(location, toCoordinateFrom: map))
            let pointsPerMapPoint = Double(map.bounds.width) / map.visibleMapRect.width
            if let editDots, let dot = editDots.nearest(to: point, tolerance: 12, pointsPerMapPoint: pointsPerMapPoint), let raw = editPoints[dot.tag] {
                parent.onTapPoint(raw)
                return
            }
            if let tappableDots, let dot = tappableDots.nearest(to: point, tolerance: 8, pointsPerMapPoint: pointsPerMapPoint), dot.tag > 0 {
                parent.onOpenPlace(Int(dot.tag))
            }
        }

        nonisolated func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
            true
        }

        // MARK: MKMapViewDelegate

        func mapView(_ mapView: MKMapView, rendererFor overlay: any MKOverlay) -> MKOverlayRenderer {
            switch overlay {
            case let route as RouteOverlay:
                let r = MKMultiPolylineRenderer(multiPolyline: route)
                r.strokeColor = route.style.color
                r.lineWidth = route.style.width
                r.alpha = route.style.alpha
                r.lineCap = .round
                r.lineJoin = .round
                if route.style.dashed { r.lineDashPattern = [0.01, NSNumber(value: Double(route.style.width) * 2.2)] }
                return r
            case let dots as DotsOverlay:
                return DotsRenderer(overlay: dots)
            case let heat as HeatOverlay:
                return HeatRenderer(overlay: heat)
            default:
                return MKOverlayRenderer(overlay: overlay)
            }
        }

        func mapView(_ mapView: MKMapView, viewFor annotation: any MKAnnotation) -> MKAnnotationView? {
            switch annotation {
            case is StopAnnotation:
                mapView.dequeueReusableAnnotationView(withIdentifier: StopAnnotationView.reuseID, for: annotation)
            case is DotLabelAnnotation:
                mapView.dequeueReusableAnnotationView(withIdentifier: DotLabelAnnotationView.reuseID, for: annotation)
            default:
                nil
            }
        }

        func mapViewDidChangeVisibleRegion(_ mapView: MKMapView) {
            layOutStopNames(mapView)
        }

        func mapView(_ mapView: MKMapView, regionDidChangeAnimated animated: Bool) {
            // The annotation views are moved after the region: lay the names out once they are where they end.
            DispatchQueue.main.async { [weak self, weak mapView] in
                guard let self, let mapView else { return }
                self.layOutStopNames(mapView)
            }
        }

        func mapView(_ mapView: MKMapView, didAdd views: [MKAnnotationView]) {
            DispatchQueue.main.async { [weak self, weak mapView] in
                guard let self, let mapView else { return }
                self.layOutStopNames(mapView)
            }
        }

        /// Shows the name of a stop only where it covers no other stop and no name that matters more (a stop of lower rank):
        /// MapKit's own collisions would judge a name under its disc as if it sat on the disc, and hide them all.
        func layOutStopNames(_ map: MKMapView) {
            let stops = map.annotations.compactMap { annotation -> (rank: Int, view: StopAnnotationView, disc: CGRect, name: CGRect?)? in
                guard let stop = annotation as? StopAnnotation, let view = map.view(for: stop) as? StopAnnotationView else { return nil }
                let frames = view.frames(at: map.convert(stop.coordinate, toPointTo: map))
                return (stop.rank, view, frames.disc, frames.name)
            }
            guard stops.count > 1 else { return }
            var names: [CGRect] = []
            for (index, stop) in stops.enumerated().sorted(by: { $0.element.rank < $1.element.rank }) {
                guard let name = stop.name else { continue }
                let coversStop = stops.indices.contains { $0 != index && stops[$0].disc.intersects(name) }
                let clear = !coversStop && !names.contains { $0.intersects(name) }
                stop.view.showsName = clear
                if clear { names.append(name) }
            }
        }

        func mapView(_ mapView: MKMapView, didSelect annotation: any MKAnnotation) {
            mapView.deselectAnnotation(annotation, animated: false)
            if let stop = annotation as? StopAnnotation, let id = stop.placeID, parent.model.editing == nil {
                parent.onOpenPlace(id)
            }
        }
    }
}
