import Foundation
import Testing
@testable import Sporer

private let theDay = LocalDate("2026-11-24")!

/// Every answer of the local server, captured in Fixtures/, decodes through the service's own methods.
@Suite("HTTPService: the server's answers decode")
struct FixtureDecodingTests {
    @Test func day() async throws {
        let rig = Rig()
        try rig.server.respond(fixture: "day")
        let response = try await rig.service.day(theDay)
        #expect(response.date == theDay)
        #expect(response.state == .done)
        #expect(!response.segments.isEmpty)
        #expect(rig.server.requests.first?.path == "/api/day/2026-11-24")
    }

    /// day.json as a server with trains and buses writes it: modeEdited on every move, the morning drive a train, the evening drive
    /// a bus the owner set, and a move in a mode of a newer server (Fixtures/day-transit.json, made from day.json).
    @Test func dayWithTrainsAndBuses() async throws {
        let rig = Rig()
        try rig.server.respond(fixture: "day-transit")
        let response = try await rig.service.day(theDay)
        let moves = Dictionary(uniqueKeysWithValues: response.moves.map { ($0.id, $0) })
        #expect(moves[7839]?.mode == .train && moves[7839]?.modeEdited == false)
        #expect(moves[7845]?.mode == .bus && moves[7845]?.modeEdited == true)
        #expect(moves[7847]?.mode == nil, "a mode the app does not know is no mode")
        #expect(moves[7849]?.mode == .walk)
        #expect(response.segments.count == 13)
    }

    @Test func dayPoints() async throws {
        let rig = Rig()
        try rig.server.respond(fixture: "day-points")
        let response = try await rig.service.dayPoints(theDay)
        #expect(response.devices == ["synthetic-phone"])
        #expect(response.points.count == 300)
        #expect(response.points[0].t == 1_795_501_421_000_000)
        #expect(rig.server.requests.first?.path == "/api/day/2026-11-24/points")
    }

    @Test func pointDetail() async throws {
        let rig = Rig()
        try rig.server.respond(fixture: "point-detail")
        let response = try await rig.service.pointDetail(device: "synthetic-phone", t: 1_795_501_421_000_000)
        #expect(response.device == "synthetic-phone")
        #expect(response.status == .used)
        #expect(response.zone == "Europe/Oslo")
        #expect(response.previous != nil || response.next != nil)
        #expect(rig.server.requests.first?.absolute.hasSuffix("/api/points/detail?device=synthetic-phone&t=1795501421000000") == true)
    }

    @Test func range() async throws {
        let rig = Rig()
        try rig.server.respond(fixture: "range")
        let response = try await rig.service.range(from: LocalDate("2026-11-01")!, to: LocalDate("2026-11-30")!)
        #expect(response.from == LocalDate("2026-11-01") && response.to == LocalDate("2026-11-30"))
        #expect(!response.moves.isEmpty && !response.places.isEmpty && !response.days.isEmpty)
        #expect(rig.server.requests.first?.absolute.hasSuffix("/api/range?from=2026-11-01&to=2026-11-30") == true)
    }

    @Test func heat() async throws {
        let rig = Rig()
        try rig.server.respond(fixture: "heat")
        let response = try await rig.service.heat(from: LocalDate("2026-11-01")!, to: LocalDate("2026-11-30")!)
        #expect(!response.cells.isEmpty)
        #expect(response.maxSeconds == response.cells.first?.seconds)
        #expect(rig.server.requests.first?.absolute.hasSuffix("/api/heat?from=2026-11-01&to=2026-11-30") == true)
    }

    @Test func place() async throws {
        let rig = Rig()
        try rig.server.respond(fixture: "place")
        let response = try await rig.service.place(1)
        #expect(response.id == 1)
        #expect(response.visits > 0 && response.totalSeconds > 0)
        #expect(!response.recentVisits.isEmpty)
        #expect(rig.server.requests.first?.path == "/api/places/1")
    }

    @Test func searchPlaces() async throws {
        let rig = Rig()
        try rig.server.respond(fixture: "places-search")
        let response = try await rig.service.searchPlaces("")
        #expect(response.first?.id == 1)
        #expect(response.count > 1)
        #expect(rig.server.requests.first?.absolute.hasSuffix("/api/places/search") == true)
    }

    @Test func mergeCandidates() async throws {
        let rig = Rig()
        try rig.server.respond(fixture: "place-candidates")
        let response = try await rig.service.mergeCandidates(for: 1, query: "")
        #expect(!response.isEmpty)
        #expect(response.allSatisfy { $0.id != 1 })
        #expect(rig.server.requests.first?.path == "/api/places/1/candidates")
    }

    @Test func trips() async throws {
        let rig = Rig()
        try rig.server.respond(fixture: "trips")
        let response = try await rig.service.trips()
        #expect(response.count == 3)
        #expect(response.first?.id == "2026-03-20")
        #expect(rig.server.requests.first?.path == "/api/trips")
    }

    @Test func trip() async throws {
        let rig = Rig()
        try rig.server.respond(fixture: "trip")
        let response = try await rig.service.trip("2026-03-20")
        #expect(response.id == "2026-03-20")
        #expect(!response.days.isEmpty && !response.moves.isEmpty)
        #expect(rig.server.requests.first?.path == "/api/trips/2026-03-20")
    }

    @Test func homes() async throws {
        let rig = Rig()
        try rig.server.respond(fixture: "homes")
        let response = try await rig.service.homes()
        #expect(response.count == 2)
        #expect(response.last?.to == nil)
        #expect(response.allSatisfy { $0.source == .detected })
    }

    @Test func settings() async throws {
        let rig = Rig()
        try rig.server.respond(fixture: "settings")
        let response = try await rig.service.settings()
        #expect(response.tripMinDistanceKm == 50 && response.tripMinDistanceKmDefault == 50)
    }

    @Test func status() async throws {
        let rig = Rig()
        try rig.server.respond(fixture: "status")
        let response = try await rig.service.status()
        #expect(response.backfill.percent == 100)
        #expect(response.failedRanges.isEmpty)
        #expect(response.places.total == 86)
        #expect(response.lastRunAt != nil, "microsecond timestamps are read")
        #expect(response.warnings.count == 1)
    }

    @Test func deletedTrips() async throws {
        let rig = Rig()
        try rig.server.respond(fixture: "trips-deleted")
        let response = try await rig.service.deletedTrips()
        #expect(response.map(\.key) == ["2026-03-20"])
        #expect(response.first?.label.hasPrefix("Tokyo") == true)
    }

    @Test func removedPoints() async throws {
        let rig = Rig()
        try rig.server.respond(fixture: "points-removed")
        let response = try await rig.service.removedPoints()
        #expect(response.count == 1)
        #expect(response.first?.count == 2)
        #expect(response.first?.localDates == [theDay])
    }

    @Test func emptyListsDecode() async throws {
        let rig = Rig()
        rig.server.respond(text: "[]")
        #expect(try await rig.service.deletedTrips().isEmpty)
        #expect(try await rig.service.removedPoints().isEmpty)
    }
}

@Suite("HTTPService: ETag, offline and cache-only reads")
struct CachedReadTests {
    private nonisolated static let etag = "\"v1\""

    /// Serves the fixture with an ETag, and a 304 to a request that names it.
    private func etagServer(_ rig: Rig, fixture: String) throws {
        let body = try Fixtures.data(fixture)
        rig.server.answer { request in
            if request.header("If-None-Match") == Self.etag { return .response(status: 304, headers: [:], body: Data()) }
            return .response(status: 200, headers: ["ETag": Self.etag], body: body)
        }
    }

    @Test func aSecondReadSendsTheETagAndTakesA304AsTheSavedAnswer() async throws {
        let rig = Rig()
        try etagServer(rig, fixture: "day")
        let first = try await rig.service.day(theDay)
        let second = try await rig.service.day(theDay)

        #expect(first == second)
        let requests = rig.server.requests
        #expect(requests.count == 2)
        #expect(requests[0].header("If-None-Match") == nil)
        #expect(requests[1].header("If-None-Match") == Self.etag)
        #expect(requests[1].header("Accept") == "application/json")
        let saved = try #require(rig.store.read(rig.key("/api/day/2026-11-24")))
        #expect(saved.etag == Self.etag)
        #expect(saved.body == (try Fixtures.data("day")))
    }

    @Test func aReadWithoutAnETagIsSavedWithoutOne() async throws {
        let rig = Rig()
        try rig.server.respond(fixture: "settings")
        _ = try await rig.service.settings()
        _ = try await rig.service.settings()
        let saved = try #require(rig.store.read(rig.key("/api/settings")))
        #expect(saved.etag == nil)
        #expect(rig.server.requests.allSatisfy { $0.header("If-None-Match") == nil })
    }

    @Test func aChangedAnswerReplacesTheSavedOne() async throws {
        let rig = Rig()
        rig.server.respond(headers: ["ETag": "\"a\""], text: #"{"tripMinDistanceKm":50,"tripMinDistanceKmDefault":50}"#)
        _ = try await rig.service.settings()
        rig.server.respond(headers: ["ETag": "\"b\""], text: #"{"tripMinDistanceKm":80,"tripMinDistanceKmDefault":50}"#)
        let second = try await rig.service.settings()
        #expect(second.tripMinDistanceKm == 80)
        #expect(rig.store.read(rig.key("/api/settings"))?.etag == "\"b\"")
    }

    @Test func aSavedAnswerThatCanNoLongerBeReadIsAskedForAgainInFull() async throws {
        let rig = Rig()
        rig.store.write(rig.key("/api/settings"), body: Data("not json".utf8), etag: Self.etag)
        // The first request names the ETag and gets a 304 for a body that no longer decodes; the answer is then asked for whole.
        rig.server.answer { request in
            if request.header("If-None-Match") != nil { return .response(status: 304, headers: [:], body: Data()) }
            return .response(status: 200, headers: ["ETag": "\"v2\""], body: (try? Fixtures.data("settings")) ?? Data())
        }
        let value = try await rig.service.settings()
        #expect(value.tripMinDistanceKm == 50)
        let requests = rig.server.requests
        #expect(requests.count == 2)
        #expect(requests[1].header("If-None-Match") == nil)
        #expect(rig.store.read(rig.key("/api/settings"))?.etag == "\"v2\"")
    }

    // MARK: Offline

    @Test func offlineWithANoteGivesTheSavedAnswerAndSaysWhen() async throws {
        let rig = Rig()
        try etagServer(rig, fixture: "day")
        let online = try await rig.service.day(theDay)
        rig.server.fail(.notConnectedToInternet)

        let note = CacheNote()
        let offline = try await ServiceContext.$note.withValue(note) { try await rig.service.day(theDay) }
        #expect(offline == online)
        let savedAt = try #require(note.savedAt)
        #expect(abs(savedAt.timeIntervalSinceNow) < 60)
    }

    @Test func theNoteHoldsTheOldestOfTheSavedAnswers() async throws {
        let rig = Rig()
        try rig.server.respond(fixture: "settings")
        _ = try await rig.service.settings()
        try rig.server.respond(fixture: "status")
        _ = try await rig.service.status()
        // Age the settings by a day.
        let old = Date(timeIntervalSinceNow: -86_400)
        for file in rig.savedFiles where file.hasSuffix(".json") {
            let url = rig.directory.appending(path: file)
            if (try? Data(contentsOf: url)) == (try Fixtures.data("settings")) {
                try FileManager.default.setAttributes([.modificationDate: old], ofItemAtPath: url.path)
            }
        }
        rig.server.fail()
        let note = CacheNote()
        try await ServiceContext.$note.withValue(note) {
            _ = try await rig.service.status()
            _ = try await rig.service.settings()
        }
        #expect(abs(try #require(note.savedAt).timeIntervalSince(old)) < 2)
    }

    @Test func offlineWithNoNoteThrowsOffline() async throws {
        let rig = Rig()
        try rig.server.respond(fixture: "day")
        _ = try await rig.service.day(theDay)
        rig.server.fail(.notConnectedToInternet)
        let error = await serviceError { try await rig.service.day(theDay) }
        guard case .offline? = error else { Issue.record("expected offline, got \(String(describing: error))"); return }
    }

    @Test func offlineWithNothingSavedThrowsOfflineEvenWithANote() async throws {
        let rig = Rig()
        rig.server.fail(.notConnectedToInternet)
        let note = CacheNote()
        let error = await ServiceContext.$note.withValue(note) { await serviceError { try await rig.service.day(theDay) } }
        guard case .offline? = error else { Issue.record("expected offline, got \(String(describing: error))"); return }
        #expect(note.savedAt == nil)
    }

    @Test(arguments: [URLError.Code.timedOut, .cannotConnectToHost, .networkConnectionLost, .dnsLookupFailed])
    func anyFailureToGetAnAnswerIsOffline(code: URLError.Code) async {
        let rig = Rig()
        rig.server.fail(code)
        let error = await serviceError { try await rig.service.status() }
        guard case .offline? = error else { Issue.record("expected offline, got \(String(describing: error))"); return }
    }

    @Test func aSecureConnectionRequirementIsABadAddress() async {
        let rig = Rig()
        rig.server.fail(.appTransportSecurityRequiresSecureConnection)
        let error = await serviceError { try await rig.service.status() }
        guard case .badAddress? = error else { Issue.record("expected badAddress, got \(String(describing: error))"); return }
    }

    @Test func anAddressThatIsNotAWebAddressIsABadAddress() async {
        let service = HTTPService(address: { "ftp://nowhere" }, store: ResponseStore(directory: FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)))
        let error = await serviceError { try await service.status() }
        guard case .badAddress? = error else { Issue.record("expected badAddress, got \(String(describing: error))"); return }
    }

    // MARK: Cache-only

    @Test func cacheOnlyGivesTheSavedAnswerWithoutAskingTheServer() async throws {
        let rig = Rig()
        try rig.server.respond(fixture: "day")
        let online = try await rig.service.day(theDay)
        let before = rig.server.requests.count

        let note = CacheNote()
        let cached = try await ServiceContext.$mode.withValue(.cacheOnly) {
            try await ServiceContext.$note.withValue(note) { try await rig.service.day(theDay) }
        }
        #expect(cached == online)
        #expect(rig.server.requests.count == before)
        #expect(note.savedAt != nil)
    }

    @Test func cacheOnlyWithNothingSavedThrowsNotCachedAndAsksNothing() async {
        let rig = Rig()
        rig.server.respond(text: "{}")
        let error = await ServiceContext.$mode.withValue(.cacheOnly) { await serviceError { try await rig.service.day(theDay) } }
        guard case .notCached? = error else { Issue.record("expected notCached, got \(String(describing: error))"); return }
        #expect(rig.server.requests.isEmpty)
    }

    @Test func cacheOnlyWithASavedAnswerThatCannotBeReadIsNotCached() async {
        let rig = Rig()
        rig.store.write(rig.key("/api/day/2026-11-24"), body: Data("not json".utf8), etag: nil)
        let error = await ServiceContext.$mode.withValue(.cacheOnly) { await serviceError { try await rig.service.day(theDay) } }
        guard case .notCached? = error else { Issue.record("expected notCached, got \(String(describing: error))"); return }
        #expect(rig.server.requests.isEmpty)
    }

    @Test func cacheOnlyNeverGivesAnswersThatAreNotKept() async throws {
        let rig = Rig()
        try rig.server.respond(fixture: "day-points")
        _ = try await rig.service.dayPoints(theDay)
        let before = rig.server.requests.count
        let error = await ServiceContext.$mode.withValue(.cacheOnly) { await serviceError { try await rig.service.dayPoints(theDay) } }
        guard case .notCached? = error else { Issue.record("expected notCached, got \(String(describing: error))"); return }
        #expect(rig.server.requests.count == before)
    }

    // MARK: What is kept

    @Test func dayPointsAreNeverSaved() async throws {
        let rig = Rig()
        try rig.server.respond(fixture: "day-points")
        _ = try await rig.service.dayPoints(theDay)
        #expect(rig.savedFiles.isEmpty)
        rig.server.fail()
        let note = CacheNote()
        let error = await ServiceContext.$note.withValue(note) { await serviceError { try await rig.service.dayPoints(theDay) } }
        guard case .offline? = error else { Issue.record("expected offline, got \(String(describing: error))"); return }
    }

    @Test func aPointDetailIsNeverSaved() async throws {
        let rig = Rig()
        try rig.server.respond(fixture: "point-detail")
        _ = try await rig.service.pointDetail(device: "synthetic-phone", t: 1_795_501_421_000_000)
        #expect(rig.savedFiles.isEmpty)
    }

    @Test func mergeCandidatesAreNeverSaved() async throws {
        let rig = Rig()
        try rig.server.respond(fixture: "place-candidates")
        _ = try await rig.service.mergeCandidates(for: 1, query: "")
        _ = try await rig.service.mergeCandidates(for: 1, query: "str")
        #expect(rig.savedFiles.isEmpty)
        #expect(rig.server.requests.last?.absolute.hasSuffix("/api/places/1/candidates?q=str") == true)
    }

    @Test func aSearchWithAQueryIsNotSavedButTheMostVisitedIs() async throws {
        let rig = Rig()
        try rig.server.respond(fixture: "places-search")
        _ = try await rig.service.searchPlaces("street 1")
        #expect(rig.savedFiles.isEmpty)
        #expect(rig.server.requests.last?.absolute.hasSuffix("/api/places/search?q=street%201") == true)
        _ = try await rig.service.searchPlaces("")
        #expect(!rig.savedFiles.isEmpty)
        #expect(rig.store.read(rig.key("/api/places/search")) != nil)
    }

    @Test func theOtherReadsAreSaved() async throws {
        let rig = Rig()
        try rig.server.respond(fixture: "day")
        _ = try await rig.service.day(theDay)
        try rig.server.respond(fixture: "range")
        _ = try await rig.service.range(from: LocalDate("2026-11-01")!, to: LocalDate("2026-11-30")!)
        try rig.server.respond(fixture: "trips")
        _ = try await rig.service.trips()
        #expect(rig.store.read(rig.key("/api/day/2026-11-24")) != nil)
        #expect(rig.store.read(rig.key("/api/range?from=2026-11-01&to=2026-11-30")) != nil)
        #expect(rig.store.read(rig.key("/api/trips")) != nil)
        #expect(rig.service.keepsResponses)
    }

    @Test func aFailedReadSavesNothing() async {
        let rig = Rig()
        rig.server.respond(status: 500, text: "boom")
        _ = await serviceError { try await rig.service.status() }
        rig.server.respond(text: "<html></html>")
        _ = await serviceError { try await rig.service.status() }
        #expect(rig.savedFiles.isEmpty)
    }
}
