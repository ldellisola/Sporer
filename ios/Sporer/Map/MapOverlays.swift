import MapKit
import UIKit

// The overlays of the map and the renderers that draw them. MapKit draws overlays off the main thread,
// so everything here is nonisolated and immutable once made.

/// How a set of routes is stroked.
nonisolated struct RouteStyle: Sendable {
    var color: UIColor
    var width: CGFloat
    var alpha: CGFloat = 1
    var dashed = false
}

/// Many routes stroked alike: one per mode, the white casing under them, or the flights.
nonisolated final class RouteOverlay: MKMultiPolyline, @unchecked Sendable {
    let style: RouteStyle

    init(_ polylines: [MKPolyline], style: RouteStyle) {
        self.style = style
        super.init(polylines)
    }
}

/// A dot drawn at a fixed size on screen, whatever the zoom: the places of a period, the cities of trips, the raw points of edit mode.
nonisolated struct MapDot: Sendable {
    var point: MKMapPoint
    var radius: CGFloat
    var fill: UIColor?
    var stroke: UIColor?
    var strokeWidth: CGFloat = 0
    /// What a tap on the dot opens or selects.
    var tag: Int64
}

nonisolated final class DotsOverlay: NSObject, MKOverlay, @unchecked Sendable {
    /// Sorted by x, to find the dots of a tile quickly.
    let dots: [MapDot]
    let maxRadius: CGFloat
    let boundingMapRect: MKMapRect
    let coordinate: CLLocationCoordinate2D
    /// Whether a tap on a dot opens it.
    let tappable: Bool

    init(_ dots: [MapDot], tappable: Bool) {
        self.dots = dots.sorted { $0.point.x < $1.point.x }
        self.maxRadius = dots.map(\.radius).max() ?? 0
        self.tappable = tappable
        // Dots are drawn at a size on screen, so the whole world is their bounds: no dot is ever cut at a tile's edge.
        self.boundingMapRect = .world
        self.coordinate = dots.first?.point.coordinate ?? CLLocationCoordinate2D()
        super.init()
    }

    /// The dots whose x lies in `minX...maxX`.
    func dots(xFrom minX: Double, to maxX: Double) -> ArraySlice<MapDot> {
        var lo = 0, hi = dots.count
        while lo < hi {
            let mid = (lo + hi) / 2
            if dots[mid].point.x < minX { lo = mid + 1 } else { hi = mid }
        }
        var end = lo
        while end < dots.count, dots[end].point.x <= maxX { end += 1 }
        return dots[lo..<end]
    }

    /// The nearest dot to `point` within `tolerance` screen points, at the zoom `pointsPerMapPoint`.
    func nearest(to point: MKMapPoint, tolerance: CGFloat, pointsPerMapPoint: Double) -> MapDot? {
        let reach = Double(tolerance + maxRadius) / pointsPerMapPoint
        var best: (MapDot, Double)?
        for dot in dots(xFrom: point.x - reach, to: point.x + reach) {
            let dx = (dot.point.x - point.x) * pointsPerMapPoint
            let dy = (dot.point.y - point.y) * pointsPerMapPoint
            let d = (dx * dx + dy * dy).squareRoot()
            if d <= Double(tolerance + dot.radius), d < (best?.1 ?? .infinity) { best = (dot, d) }
        }
        return best?.0
    }
}

nonisolated final class DotsRenderer: MKOverlayRenderer {
    override func draw(_ mapRect: MKMapRect, zoomScale: MKZoomScale, in context: CGContext) {
        guard let overlay = overlay as? DotsOverlay else { return }
        let pad = Double(overlay.maxRadius + 2) / Double(zoomScale)
        let area = mapRect.insetBy(dx: -pad, dy: -pad)
        for dot in overlay.dots(xFrom: area.minX, to: area.maxX) where dot.point.y >= area.minY && dot.point.y <= area.maxY {
            let r = Double(dot.radius) / Double(zoomScale)
            let center = point(for: dot.point)
            let rect = CGRect(x: center.x - r, y: center.y - r, width: 2 * r, height: 2 * r)
            if let fill = dot.fill {
                context.setFillColor(fill.cgColor)
                context.fillEllipse(in: rect)
            }
            if let stroke = dot.stroke, dot.strokeWidth > 0 {
                let w = Double(dot.strokeWidth) / Double(zoomScale)
                context.setStrokeColor(stroke.cgColor)
                context.setLineWidth(w)
                context.strokeEllipse(in: rect.insetBy(dx: w / 2, dy: w / 2))
            }
        }
    }
}

/// Where the time of a period was spent, as a glow: cells weighted by seconds, coloured from transparent pink to pale yellow.
nonisolated final class HeatOverlay: NSObject, MKOverlay, @unchecked Sendable {
    struct Cell: Sendable {
        var point: MKMapPoint
        var weight: Double
    }

    let cells: [Cell]
    let boundingMapRect: MKMapRect = .world
    let coordinate: CLLocationCoordinate2D

    init(_ heat: HeatResponse) {
        let max = Swift.max(heat.maxSeconds, 1)
        cells = heat.cells
            .map { Cell(point: MKMapPoint(CLLocationCoordinate2D(latitude: $0.lat, longitude: $0.lon)), weight: $0.seconds / max) }
            .sorted { $0.point.x < $1.point.x }
        coordinate = heat.cells.first.map { CLLocationCoordinate2D(latitude: $0.lat, longitude: $0.lon) } ?? CLLocationCoordinate2D()
        super.init()
    }
}

nonisolated final class HeatRenderer: MKOverlayRenderer {
    /// The colour ramp of the web app's heat layer, from no time to the most time.
    private static let ramp: [(Double, (Double, Double, Double, Double))] = [
        (0.0, (1.0, 45 / 255, 85 / 255, 0)),
        (0.2, (1.0, 45 / 255, 85 / 255, 0.35)),
        (0.5, (1.0, 90 / 255, 31 / 255, 1)),
        (0.8, (1.0, 194 / 255, 51 / 255, 1)),
        (1.0, (1.0, 246 / 255, 194 / 255, 1)),
    ]

    private static let lookup: [UInt32] = (0..<256).map { i in
        let v = Double(i) / 255
        var lower = ramp[0], upper = ramp[ramp.count - 1]
        for k in 0..<(ramp.count - 1) where v >= ramp[k].0 && v <= ramp[k + 1].0 {
            lower = ramp[k]
            upper = ramp[k + 1]
        }
        let t = upper.0 > lower.0 ? (v - lower.0) / (upper.0 - lower.0) : 0
        func mix(_ a: Double, _ b: Double) -> Double { a + (b - a) * t }
        let a = mix(lower.1.3, upper.1.3) * 0.85
        let r = UInt32(mix(lower.1.0, upper.1.0) * a * 255)
        let g = UInt32(mix(lower.1.1, upper.1.1) * a * 255)
        let b = UInt32(mix(lower.1.2, upper.1.2) * a * 255)
        // Premultiplied RGBA, little-endian: the bytes in memory are r, g, b, a.
        return r | (g << 8) | (b << 16) | (UInt32(a * 255) << 24)
    }

    override func draw(_ mapRect: MKMapRect, zoomScale: MKZoomScale, in context: CGContext) {
        guard let overlay = overlay as? HeatOverlay, !overlay.cells.isEmpty else { return }
        let zoom = max(0, log2(Double(zoomScale) * 1_048_576))
        // The web app's radius (6 px at z0, 16 at z8, 44 at z14) and intensity (0.6 at z0 to 2.4 at z14).
        let radiusPx = zoom < 8 ? 6 + (16 - 6) * zoom / 8 : 16 + (44 - 16) * min(1, (zoom - 8) / 6)
        let intensity = 0.6 + 1.8 * min(1, zoom / 14)
        let width = max(1, Int((mapRect.size.width * Double(zoomScale)).rounded()))
        let height = max(1, Int((mapRect.size.height * Double(zoomScale)).rounded()))
        let pad = radiusPx / Double(zoomScale)
        let area = mapRect.insetBy(dx: -pad, dy: -pad)

        var lo = 0, hi = overlay.cells.count
        while lo < hi {
            let mid = (lo + hi) / 2
            if overlay.cells[mid].point.x < area.minX { lo = mid + 1 } else { hi = mid }
        }
        var relevant: [HeatOverlay.Cell] = []
        var i = lo
        while i < overlay.cells.count, overlay.cells[i].point.x <= area.maxX {
            let c = overlay.cells[i]
            if c.point.y >= area.minY, c.point.y <= area.maxY { relevant.append(c) }
            i += 1
        }
        guard !relevant.isEmpty else { return }

        // Add up the glow of every cell into a grey intensity image, then colour it through the ramp.
        guard let gray = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width,
                                   space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue)
        else { return }
        gray.setBlendMode(.plusLighter)
        let space = CGColorSpaceCreateDeviceGray()
        for cell in relevant {
            let x = (cell.point.x - mapRect.minX) * Double(zoomScale)
            let y = (cell.point.y - mapRect.minY) * Double(zoomScale)
            let alpha = min(1, cell.weight * intensity) * 0.5
            guard alpha > 0.004,
                  let gradient = CGGradient(colorSpace: space, colorComponents: [1, alpha, 1, 0], locations: [0, 1], count: 2)
            else { continue }
            let center = CGPoint(x: x, y: Double(height) - y)
            gray.drawRadialGradient(gradient, startCenter: center, startRadius: 0, endCenter: center, endRadius: radiusPx, options: [])
        }
        guard let source = gray.data?.bindMemory(to: UInt8.self, capacity: width * height) else { return }
        var pixels = [UInt32](repeating: 0, count: width * height)
        for p in 0..<(width * height) { pixels[p] = Self.lookup[Int(source[p])] }
        let image: CGImage? = pixels.withUnsafeMutableBytes { buffer in
            CGContext(data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)?.makeImage()
        }
        guard let image else { return }
        // The map's context is flipped like UIKit's, and an image is drawn upright in an unflipped one.
        let target = rect(for: mapRect)
        context.saveGState()
        context.translateBy(x: target.minX, y: target.maxY)
        context.scaleBy(x: 1, y: -1)
        context.draw(image, in: CGRect(origin: .zero, size: target.size))
        context.restoreGState()
    }
}
