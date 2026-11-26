import MapKit
import Testing
@testable import Sporer

/// How the map strokes routes: every mode on the ground in its own colour, flights dashed.
@MainActor
@Suite("The map's routes")
struct RouteDrawingTests {
    private let line = [LonLat(lon: 10.75, lat: 59.92), LonLat(lon: 10.76, lat: 59.91), LonLat(lon: 10.77, lat: 59.915)]
    private let modes: [Mode?] = Mode.allCases + [nil]

    @Test func everyModeOnTheGroundIsDrawnInItsColourOverAWhiteCasing() throws {
        let overlays = RouteDrawing.overlays(modes.map { ($0, line) }, bold: true, alpha: 1)
        let casing = try #require(overlays.first)
        #expect(casing.style.color == .white)
        #expect(casing.polylines.count == modes.count - 1, "the casing is under every route on the ground, not the flights")

        let strokes = overlays.dropFirst().filter { !$0.style.dashed }
        #expect(strokes.map(\.style.color) == [Mode.walk, .cycle, .drive, .bus, .train].map(\.uiColor) + [UIColor.systemGray])
        #expect(strokes.allSatisfy { $0.polylines.count == 1 && $0.style.width == 4.5 })

        let flights = try #require(overlays.last)
        #expect(flights.style.dashed && flights.style.color == Mode.flight.uiColor)
        #expect(flights.polylines.count == line.count - 1, "one great-circle arc per leg")
        #expect(overlays.count == 1 + 6 + 1)
    }

    @Test func busAndTrainAreSolidLikeDrive() {
        let overlays = RouteDrawing.overlays([(.bus, line), (.train, line), (.drive, line)], bold: false, alpha: 0.35)
        #expect(overlays.map(\.style.color) == [Mode.drive.uiColor, Mode.bus.uiColor, Mode.train.uiColor], "thin routes have no casing")
        #expect(overlays.allSatisfy { !$0.style.dashed && $0.style.alpha == 0.35 && $0.style.width == 2.4 })
    }

    @Test func movesOfOneModeShareOneOverlay() {
        let overlays = RouteDrawing.overlays([(.train, line), (.walk, line), (.train, line)], bold: false, alpha: 1)
        #expect(overlays.map(\.polylines.count) == [1, 2])
        #expect(overlays.map(\.style.color) == [Mode.walk.uiColor, Mode.train.uiColor])
    }
}
