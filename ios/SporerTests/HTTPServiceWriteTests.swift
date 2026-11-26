import Foundation
import Synchronization
import Testing
@testable import Sporer

/// Counts the notifications that say the data changed. Writes post it from a task on the main actor, so a test that counts them
/// is in this serialized suite, with every test that writes: no other test of the app posts it meanwhile.
private nonisolated final class DataChangedCounter: Sendable {
    private final class Box: Sendable {
        let count = Mutex(0)
    }
    private let box = Box()
    private nonisolated(unsafe) var token: (any NSObjectProtocol)?

    @MainActor init() {
        let box = box
        token = NotificationCenter.default.addObserver(forName: .sporerDataChanged, object: nil, queue: nil) { _ in
            box.count.withLock { $0 += 1 }
        }
    }

    deinit {
        if let token { NotificationCenter.default.removeObserver(token) }
    }

    var value: Int { box.count.withLock { $0 } }

    /// Waits for `expected` notifications (the posting is asynchronous), and a little longer for ones that should not come.
    func settle(expected: Int) async -> Int {
        for _ in 0..<200 where value < expected { try? await Task.sleep(for: .milliseconds(10)) }
        try? await Task.sleep(for: .milliseconds(50))
        return value
    }
}

@Suite("HTTPService: writes", .serialized)
struct WriteTests {
    private func place(_ rig: Rig) throws { try rig.server.respond(fixture: "place") }

    // MARK: What is sent

    @Test func aWriteWithNoBodySendsAnEmptyJSONObject() async throws {
        let rig = Rig()
        rig.server.respond(status: 204)
        try await rig.service.restoreTrip(key: "2026-03-20")
        let request = try #require(rig.server.requests.first)
        #expect(request.method == "POST")
        #expect(request.path == "/api/trips/deleted/2026-03-20/restore")
        #expect(request.header("Content-Type") == "application/json")
        #expect(request.bodyText == "{}")
    }

    @Test func retryFailedPostsAnEmptyObjectAndReadsTheCount() async throws {
        let rig = Rig()
        rig.server.respond(text: #"{"retried":3}"#)
        let response = try await rig.service.retryFailed()
        #expect(response.retried == 3)
        let request = try #require(rig.server.requests.first)
        #expect(request.method == "POST" && request.path == "/api/status/retry")
        #expect(request.header("Content-Type") == "application/json")
        #expect(request.bodyText == "{}")
    }

    @Test func deletesSendJSONToo() async throws {
        let rig = Rig()
        rig.server.respond(status: 204)
        try await rig.service.deleteTrip("2026-03-20")
        try await rig.service.removeHome(171)
        try await rig.service.restorePoints(batch: "96fa6072-e34d-46c2-8b3f-578f72f20218")
        try await rig.service.separatePlace(7, from: 1)
        let requests = rig.server.requests
        #expect(requests.map(\.method) == ["DELETE", "DELETE", "DELETE", "DELETE"])
        #expect(requests.map(\.path) == [
            "/api/trips/2026-03-20", "/api/homes/171", "/api/points/removed/96fa6072-e34d-46c2-8b3f-578f72f20218", "/api/places/1/merged/7",
        ])
        #expect(requests.allSatisfy { $0.header("Content-Type") == "application/json" && $0.bodyText == "{}" })
    }

    @Test func renameSendsTheName() async throws {
        let rig = Rig()
        try place(rig)
        _ = try await rig.service.renamePlace(1, name: "Gym")
        let request = try #require(rig.server.requests.first)
        #expect(request.method == "PUT" && request.path == "/api/places/1/name")
        #expect(request.header("Content-Type") == "application/json")
        #expect(request.bodyJSON == ["name": "Gym"] as NSDictionary)
    }

    @Test func renamingToNilSendsANull() async throws {
        let rig = Rig()
        try place(rig)
        _ = try await rig.service.renamePlace(1, name: nil)
        let request = try #require(rig.server.requests.first)
        #expect(request.bodyText == #"{"name":null}"#)
    }

    @Test func mergeWithNoNameLeavesTheKeyOut() async throws {
        let rig = Rig()
        try place(rig)
        _ = try await rig.service.mergePlace(7, into: 1, name: .none)
        let request = try #require(rig.server.requests.first)
        #expect(request.method == "POST" && request.path == "/api/places/1/merge")
        #expect(request.bodyJSON == ["places": [7]] as NSDictionary)
    }

    @Test func mergeWithANilNameSendsANull() async throws {
        let rig = Rig()
        try place(rig)
        _ = try await rig.service.mergePlace(7, into: 1, name: .some(nil))
        #expect(rig.server.requests.first?.bodyJSON == ["places": [7], "name": NSNull()] as NSDictionary)
    }

    @Test func mergeWithANameSendsIt() async throws {
        let rig = Rig()
        try place(rig)
        _ = try await rig.service.mergePlace(7, into: 1, name: "Office")
        #expect(rig.server.requests.first?.bodyJSON == ["places": [7], "name": "Office"] as NSDictionary)
    }

    @Test func mergeOfSeveralPlacesSendsThemAllInTheOrderTheyWerePicked() async throws {
        let rig = Rig()
        try place(rig)
        _ = try await rig.service.mergePlaces([9, 7, 12], into: 1, name: "Office")
        let request = try #require(rig.server.requests.first)
        #expect(request.method == "POST" && request.path == "/api/places/1/merge")
        #expect(request.bodyJSON == ["places": [9, 7, 12], "name": "Office"] as NSDictionary)
    }

    @Test func tripDistanceNilSendsANull() async throws {
        let rig = Rig()
        try rig.server.respond(fixture: "settings")
        _ = try await rig.service.setTripDistance(nil)
        let request = try #require(rig.server.requests.first)
        #expect(request.method == "PUT" && request.path == "/api/settings")
        #expect(request.bodyText == #"{"tripMinDistanceKm":null}"#)
    }

    @Test func tripDistanceSendsTheNumber() async throws {
        let rig = Rig()
        try rig.server.respond(fixture: "settings")
        _ = try await rig.service.setTripDistance(80)
        #expect(rig.server.requests.first?.bodyJSON == ["tripMinDistanceKm": 80] as NSDictionary)
    }

    @Test func editTripSendsAllThreeKeys() async throws {
        let rig = Rig()
        rig.server.respond(text: #"{"id":"2026-09-10"}"#)
        let edit = EditTripRequest(name: "Lisbon", startDate: LocalDate("2026-09-10")!, endDate: nil)
        let response = try await rig.service.editTrip("2026-09-09", edit)
        #expect(response.id == "2026-09-10")
        let request = try #require(rig.server.requests.first)
        #expect(request.method == "PUT" && request.path == "/api/trips/2026-09-09")
        #expect(request.bodyJSON == ["name": "Lisbon", "startDate": "2026-09-10", "endDate": NSNull()] as NSDictionary)
        _ = try await rig.service.editTrip("2026-09-10", EditTripRequest(name: nil, startDate: nil, endDate: nil))
        #expect(rig.server.requests.last?.bodyJSON == ["name": NSNull(), "startDate": NSNull(), "endDate": NSNull()] as NSDictionary)
    }

    @Test func addHomeSendsAnOpenEndAsNull() async throws {
        let rig = Rig()
        rig.server.respond(status: 201, text: #"{"id":173,"placeId":53,"placeName":null,"from":"2025-10-18","to":null,"source":"user"}"#)
        let period = try await rig.service.addHome(AddHomeRequest(placeId: 53, from: LocalDate("2025-10-18")!, to: nil))
        #expect(period.id == 173 && period.source == .user && period.to == nil)
        let request = try #require(rig.server.requests.first)
        #expect(request.method == "POST" && request.path == "/api/homes")
        #expect(request.bodyJSON == ["placeId": 53, "from": "2025-10-18", "to": NSNull()] as NSDictionary)
    }

    @Test func removePointsSendsEachByDeviceAndMicroseconds() async throws {
        let rig = Rig()
        rig.server.respond(text: #"{"batch":"abc","count":2}"#)
        let response = try await rig.service.removePoints([
            PointRef(device: "synthetic-phone", t: 1_795_501_421_000_000), PointRef(device: "synthetic-phone", t: 1_795_501_426_000_000),
        ])
        #expect(response.batch == "abc" && response.count == 2)
        let request = try #require(rig.server.requests.first)
        #expect(request.method == "POST" && request.path == "/api/points/remove")
        #expect(request.bodyText.contains("1795501421000000") && request.bodyText.contains("1795501426000000"))
        #expect(request.bodyJSON == ["points": [
            ["device": "synthetic-phone", "t": 1_795_501_421_000_000], ["device": "synthetic-phone", "t": 1_795_501_426_000_000],
        ]] as NSDictionary)
    }

    @Test func setModePutsTheModeAndReadsTheMove() async throws {
        let rig = Rig()
        rig.server.respond(text: #"{"id":7839,"mode":"train","modeEdited":true}"#)
        let response = try await rig.service.setMode(.train, ofMove: 7839)
        #expect(response == MoveModeResponse(id: 7839, mode: .train, modeEdited: true))
        let request = try #require(rig.server.requests.first)
        #expect(request.method == "PUT" && request.path == "/api/moves/7839/mode")
        #expect(request.header("Content-Type") == "application/json")
        #expect(request.bodyText == #"{"mode":"train"}"#)
        _ = try await rig.service.setMode(.bus, ofMove: 7845)
        #expect(rig.server.requests.last?.bodyJSON == ["mode": "bus"] as NSDictionary)
    }

    @Test func clearModeDeletesWithAnEmptyObject() async throws {
        let rig = Rig()
        rig.server.respond(status: 204)
        try await rig.service.clearMode(ofMove: 7845)
        let request = try #require(rig.server.requests.first)
        #expect(request.method == "DELETE" && request.path == "/api/moves/7845/mode")
        #expect(request.header("Content-Type") == "application/json")
        #expect(request.bodyText == "{}")
    }

    @Test func aModeForAMoveThatIsGoneIsNotFoundAndTheDataChanged() async {
        let counter = DataChangedCounter()
        let rig = Rig()
        rig.server.respond(status: 404, text: #"{"errors":{"id":["No such move."]}}"#)
        let set = await serviceError { try await rig.service.setMode(.train, ofMove: 7839) }
        let cleared = await serviceError { try await rig.service.clearMode(ofMove: 7839) }
        guard case .notFound(let message)? = set, case .notFound? = cleared else {
            Issue.record("expected notFound, got \(String(describing: set)) and \(String(describing: cleared))")
            return
        }
        #expect(message == "No such move.")
        // The ids change on every rebuild: what is on screen (the day) is asked for again.
        #expect(await counter.settle(expected: 2) == 2)
    }

    @Test func aModeTheServerRefusesIsRefused() async {
        let rig = Rig()
        rig.server.respond(status: 400, text: #"{"errors":{"mode":["The mode must be one of walk, cycle, drive, bus, train, flight."]}}"#)
        let error = await serviceError { try await rig.service.setMode(.train, ofMove: 7839) }
        guard case .refused(let message)? = error else { Issue.record("expected refused, got \(String(describing: error))"); return }
        #expect(message.hasPrefix("The mode must be"))
    }

    @Test func removingNothingAnswersANullBatch() async throws {
        let rig = Rig()
        rig.server.respond(text: #"{"batch":null,"count":0}"#)
        let response = try await rig.service.removePoints([])
        #expect(response.batch == nil && response.count == 0)
    }

    // MARK: Encoding in the URL

    @Test func pathSegmentsAndQueryValuesArePercentEncoded() async throws {
        let rig = Rig()
        try rig.server.respond(fixture: "point-detail")
        _ = try await rig.service.pointDetail(device: "my phone&co", t: 42)
        #expect(rig.server.requests.last?.absolute.hasSuffix("/api/points/detail?device=my%20phone%26co&t=42") == true)

        rig.server.respond(status: 204)
        try await rig.service.restorePoints(batch: "a b/c")
        #expect(rig.server.requests.last?.absolute.hasSuffix("/api/points/removed/a%20b%2Fc") == true)
        try await rig.service.restoreTrip(key: "x y")
        #expect(rig.server.requests.last?.absolute.hasSuffix("/api/trips/deleted/x%20y/restore") == true)

        try rig.server.respond(fixture: "places-search")
        _ = try await rig.service.searchPlaces("café & bar")
        #expect(rig.server.requests.last?.absolute.hasSuffix("/api/places/search?q=caf%C3%A9%20%26%20bar") == true)
    }

    // MARK: The data changed

    @Test func aSuccessfulWritePostsDataChanged() async throws {
        let counter = DataChangedCounter()
        let rig = Rig()
        rig.server.respond(status: 204)
        try await rig.service.deleteTrip("2026-03-20")
        #expect(await counter.settle(expected: 1) == 1)
    }

    @Test func aWriteThatFindsItsTargetGonePostsDataChangedAndThrows() async {
        let counter = DataChangedCounter()
        let rig = Rig()
        rig.server.respond(status: 404, text: #"{"errors":{"id":["No such trip."]}}"#)
        let error = await serviceError { try await rig.service.deleteTrip("2026-03-20") }
        guard case .notFound(let message)? = error else { Issue.record("expected notFound, got \(String(describing: error))"); return }
        #expect(message == "No such trip.")
        #expect(await counter.settle(expected: 1) == 1)
    }

    @Test func otherFailuresPostNothing() async throws {
        let counter = DataChangedCounter()
        let rig = Rig()
        for (status, body) in [(409, #"{"errors":{"x":["no"]}}"#), (400, #"{"errors":{"x":["no"]}}"#), (500, ""), (401, "")] {
            rig.server.respond(status: status, text: body)
            let error = await serviceError { try await rig.service.deleteTrip("2026-03-20") }
            #expect(error != nil)
        }
        rig.server.fail()
        #expect(await serviceError { try await rig.service.deleteTrip("2026-03-20") } != nil)
        // Notifications are delivered in the order they were posted: one successful write after the failures shows none came before.
        rig.server.respond(status: 204)
        try await rig.service.deleteTrip("2026-03-20")
        #expect(await counter.settle(expected: 1) == 1)
    }

    @Test func readsPostNothing() async throws {
        let counter = DataChangedCounter()
        let rig = Rig()
        try rig.server.respond(fixture: "status")
        _ = try await rig.service.status()
        #expect(await counter.settle(expected: 1) == 0)
    }

    @Test func aWriteDoesNotUseTheSavedAnswersOrAskForThem() async throws {
        let rig = Rig()
        try rig.server.respond(fixture: "settings")
        _ = try await rig.service.settings()
        _ = try await rig.service.setTripDistance(60)
        let write = try #require(rig.server.requests.last)
        #expect(write.header("If-None-Match") == nil)
    }
}
