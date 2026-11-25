import Foundation
import Testing
@testable import Sporer

/// What the map draws when a screen hands it a drawing: a newer answer for the same drawing is redrawn where it is, and the heat
/// layer stays for as long as the days it covers do.
@MainActor
@Suite("The map's drawing")
struct MapModelTests {
    private func day(_ date: String, distance: Double = 1000, state: LoadState = .done) -> DayResponse {
        DayResponse(date: LocalDate(date)!, timeZone: "Europe/Oslo", state: state,
                    summary: DaySummary(places: 1, distanceMeters: distance, movingSeconds: 60), segments: [])
    }

    private let heat = HeatResponse(maxSeconds: 60, cells: [HeatCell(lon: 10.7, lat: 59.9, seconds: 60)])

    @Test func aNewerAnswerForTheSameDrawingIsRedrawnWithoutRefitting() {
        let map = MapModel()
        map.show(.day(day("2026-11-24")))
        let version = map.contentVersion
        let fits = map.fitRequest
        map.show(.day(day("2026-11-24", distance: 2000)))
        #expect(map.contentVersion == version + 1)
        #expect(map.scene.key == MapScene.day(day("2026-11-24")).key) // the map refits only when the key changes
        #expect(map.fitRequest == fits)
    }

    @Test func theSameAnswerAgainChangesNothing() {
        let map = MapModel()
        map.show(.day(day("2026-11-24")))
        let version = map.contentVersion
        map.show(.day(day("2026-11-24")))
        #expect(map.contentVersion == version)
    }

    @Test func theHeatStaysForTheSameDaysAndGoesForOthers() {
        let map = MapModel()
        map.show(.day(day("2026-11-24")))
        map.heat = heat
        map.show(.day(day("2026-11-24", distance: 5000)))
        #expect(map.heat != nil)
        map.show(.day(day("2026-11-23")))
        #expect(map.heat == nil)
    }

    @Test func aDrawingWithNoDaysDropsTheHeat() {
        let map = MapModel()
        map.show(.day(day("2026-11-24")))
        map.heat = heat
        map.show(.trips([]))
        #expect(map.heat == nil)
    }
}
