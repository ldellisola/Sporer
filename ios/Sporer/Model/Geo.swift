import CoreLocation
import MapKit

nonisolated enum Geo {
    static func distance(_ a: CLLocationCoordinate2D, _ b: CLLocationCoordinate2D) -> Double {
        let r = 6_371_000.0
        let dLat = (b.latitude - a.latitude) * .pi / 180
        let dLon = (b.longitude - a.longitude) * .pi / 180
        let h = sin(dLat / 2) * sin(dLat / 2)
            + cos(a.latitude * .pi / 180) * cos(b.latitude * .pi / 180) * sin(dLon / 2) * sin(dLon / 2)
        return 2 * r * asin(min(1, sqrt(h)))
    }

    static func length(_ line: [LonLat]) -> Double {
        zip(line, line.dropFirst()).reduce(0) { $0 + distance($1.0.coordinate, $1.1.coordinate) }
    }

    /// The smallest map rect that holds every coordinate, or nil for none.
    static func rect(_ coordinates: some Sequence<CLLocationCoordinate2D>) -> MKMapRect? {
        var rect: MKMapRect?
        for c in coordinates {
            let p = MKMapPoint(c)
            let r = MKMapRect(x: p.x, y: p.y, width: 0, height: 0)
            rect = rect.map { $0.union(r) } ?? r
        }
        return rect
    }

    /// The middle of the coordinates on the sphere (the mean of their unit vectors), which, unlike the middle of their map rect,
    /// lies under a long flight's great circle. Nil for none.
    static func centroid(_ coordinates: [CLLocationCoordinate2D]) -> CLLocationCoordinate2D? {
        guard !coordinates.isEmpty else { return nil }
        var x = 0.0, y = 0.0, z = 0.0
        for c in coordinates {
            let lat = c.latitude * .pi / 180, lon = c.longitude * .pi / 180
            x += cos(lat) * cos(lon); y += cos(lat) * sin(lon); z += sin(lat)
        }
        let lon = atan2(y, x), lat = atan2(z, sqrt(x * x + y * y))
        return CLLocationCoordinate2D(latitude: lat * 180 / .pi, longitude: lon * 180 / .pi)
    }
}
