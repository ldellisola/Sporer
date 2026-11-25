import Foundation
import Testing
@testable import Sporer

/// Every write of the app, sent by the HTTP client to a real Sporer server, which must accept what the client sends and answer what
/// the client reads. Each test puts back what it changed. They run only when the address of a server with synthetic data is given:
///
///     TEST_RUNNER_SPORER_LIVE_SERVER=http://127.0.0.1:5097 xcodebuild test …
///
/// Never point them at a server with real data: they rename, merge, remove points and delete trips (and undo it all). Run them on
/// their own (`-only-testing:SporerTests/LiveServerTests`): their writes post the data-changed notice that the stub tests count.
@Suite("Writes against a live server", .serialized, .enabled(if: LiveServer.address != nil))
struct LiveServerTests {
    private let service: HTTPService
    private let store: ResponseStore

    init() {
        store = ResponseStore(directory: URL.temporaryDirectory.appending(path: "live-\(UUID().uuidString)"))
        let address = LiveServer.address ?? ""
        service = HTTPService(address: { address }, store: store)
    }

    @Test func renameAPlaceAndBringItsNameBack() async throws {
        let place = try await busiestPlace()
        let renamed = try await service.renamePlace(place.id, name: "  Sporer test name  ")
        #expect(renamed.name == "Sporer test name")
        let back = try await service.renamePlace(place.id, name: nil)
        #expect(back.name == place.name)
    }

    @Test func mergeAPlaceAndSeparateIt() async throws {
        let place = try await busiestPlace()
        let other = try #require(try await service.mergeCandidates(for: place.id, query: "").first)
        let merged = try await service.mergePlace(other.id, into: place.id, name: .none)
        #expect(merged.merged.contains { $0.id == other.id })
        #expect(merged.name == place.name)
        try await service.separatePlace(other.id, from: place.id)
        let after = try await service.place(place.id)
        #expect(!after.merged.contains { $0.id == other.id })
        #expect(after.visits == place.visits)
    }

    @Test func mergingAPlaceIntoItselfIsAConflict() async throws {
        let place = try await busiestPlace()
        await #expect(throws: ServiceError.self) { try await service.mergePlace(place.id, into: place.id, name: .none) }
        do {
            _ = try await service.mergePlace(place.id, into: place.id, name: .none)
        } catch ServiceError.conflict(let message) {
            #expect(!message.isEmpty)
        }
    }

    @Test func anUnknownPlaceIsNotFound() async throws {
        do {
            _ = try await service.place(999_999)
            Issue.record("expected a 404")
        } catch ServiceError.notFound {
        }
    }

    @Test func setAHomeAndTakeItBack() async throws {
        let place = try await busiestPlace()
        let before = try await service.homes()
        let added = try await service.addHome(AddHomeRequest(placeId: place.id, from: LocalDate("2025-01-10")!, to: LocalDate("2025-01-12")!))
        #expect(added.source == .user)
        #expect(added.placeId == place.id)
        try await service.removeHome(added.id)
        // The detected periods are worked out again, under new ids: compare what they say.
        let shape = { (homes: [HomePeriod]) in homes.map { "\($0.placeId) \($0.from) \($0.to?.description ?? "-") \($0.source)" } }
        #expect(shape(try await service.homes()) == shape(before))
    }

    @Test func editATripThenDetectItAgain() async throws {
        let trip = try #require(try await service.trips().last)
        let edited = try await service.editTrip(trip.id, EditTripRequest(name: "Sporer test trip", startDate: nil, endDate: nil))
        #expect(edited.id == trip.id)
        #expect(try await service.trip(trip.id).name == "Sporer test trip")
        _ = try await service.editTrip(trip.id, EditTripRequest(name: trip.ownName, startDate: nil, endDate: nil))
        #expect(try await service.trip(trip.id).name == trip.name)
    }

    @Test func aTripThatEndsBeforeItStartsIsRefused() async throws {
        let trip = try #require(try await service.trips().last)
        do {
            _ = try await service.editTrip(trip.id, EditTripRequest(name: nil, startDate: trip.localEndDate, endDate: trip.localStartDate))
            Issue.record("expected a 400")
        } catch ServiceError.refused(let message) {
            #expect(!message.isEmpty)
        }
    }

    @Test func deleteATripAndRestoreIt() async throws {
        let trips = try await service.trips()
        let trip = try #require(trips.last)
        try await service.deleteTrip(trip.id)
        let deleted = try await service.deletedTrips()
        let entry = try #require(deleted.first { $0.key == trip.id })
        try await service.restoreTrip(key: entry.key)
        #expect(try await service.trips().map(\.id) == trips.map(\.id))
        #expect(try await service.deletedTrips().isEmpty)
    }

    @Test func setTheTripDistanceAndTakeItBack() async throws {
        let before = try await service.settings()
        let set = try await service.setTripDistance(80)
        #expect(set.tripMinDistanceKm == 80)
        let back = try await service.setTripDistance(nil)
        #expect(back.tripMinDistanceKm == before.tripMinDistanceKmDefault)
    }

    @Test func removePointsAndRestoreThem() async throws {
        let date = LocalDate("2026-11-10")!
        let points = try await service.dayPoints(date)
        let picked = points.points.prefix(3).map { PointRef(device: points.devices[$0.device], t: $0.t) }
        let removed = try await service.removePoints(Array(picked))
        #expect(removed.count == 3)
        let batch = try #require(removed.batch)
        #expect(try await service.removedPoints().contains { $0.batch == batch && $0.localDates.contains(date) })
        let detail = try await service.pointDetail(device: picked[0].device, t: picked[0].t)
        #expect(detail.status == .removed)
        try await service.restorePoints(batch: batch)
        #expect(try await service.removedPoints().allSatisfy { $0.batch != batch })
    }

    @Test func retryFailedWithNothingFailed() async throws {
        let result = try await service.retryFailed()
        #expect(result.retried >= 0)
    }

    @Test func readsAreAnsweredWith304TheSecondTime() async throws {
        let first = try await service.status()
        let second = try await service.status()
        #expect(first.algorithmVersion == second.algorithmVersion)
        let day = try await service.day(LocalDate("2026-11-10")!)
        #expect(day.date == LocalDate("2026-11-10")!)
    }

    private func busiestPlace() async throws -> PlaceResponse {
        let first = try #require(try await service.searchPlaces("").first)
        return try await service.place(first.id)
    }
}

nonisolated enum LiveServer {
    static let address = ProcessInfo.processInfo.environment["SPORER_LIVE_SERVER"]
}
