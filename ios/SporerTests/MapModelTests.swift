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

    private func place(_ id: Int, name: String? = "Café") -> PlaceResponse {
        PlaceResponse(id: id, name: name, address: nil, city: nil, country: nil, lat: 59.91, lon: 10.75, totalSeconds: 3600, visits: 1,
                      firstVisit: Date(timeIntervalSince1970: 0), lastVisit: Date(timeIntervalSince1970: 0), recentVisits: [], merged: [])
    }

    private func dot(_ id: Int) -> MapPlace { MapPlace(id: id, name: "Place \(id)", lat: 59.91, lon: 10.75, seconds: 60, visits: 1) }

    @Test func thePlacesRoundAPlaceComingOrGoingRedrawItWithoutRefitting() {
        let map = MapModel()
        map.show(.place(place(2), around: []))
        let version = map.contentVersion
        map.show(.place(place(2), around: [dot(2), dot(7)])) // the places come after the place
        #expect(map.contentVersion == version + 1)
        map.show(.place(place(2), around: [dot(2)])) // and a merge takes one away
        #expect(map.contentVersion == version + 2)
        #expect(map.scene.key == MapScene.place(place(2), around: []).key)
    }

    @Test func everyPlaceIsOneDrawingWhateverIsInIt() {
        #expect(MapScene.places([dot(1)]).key == MapScene.places([dot(1), dot(2)]).key) // a merge takes places off without moving the map
        #expect(MapScene.places([]).key != MapScene.place(place(1), around: []).key)
    }

    @Test func mergeModePicksAndTakesOffPlacesButNeverThePlaceTheyGoInto() {
        let merging = PlaceMergeModel(into: 2)
        merging.toggle(7)
        merging.toggle(9)
        merging.toggle(2) // a tap on the place's own pin
        #expect(merging.picked == [7, 9])
        merging.toggle(7)
        #expect(merging.picked == [9])
    }

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
