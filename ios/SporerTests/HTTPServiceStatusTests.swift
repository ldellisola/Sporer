import Foundation
import Testing
@testable import Sporer

@Suite("HTTPService: what each status means")
struct StatusMappingTests {
    private let apiError = #"{"statusCode":404,"message":"One or more errors occurred!","errors":{"id":["There is no such place."]}}"#

    /// Reads a place from a server that answers `status` with `body`.
    private func read(status: Int, headers: [String: String] = [:], body: String = "") async -> ServiceError? {
        let rig = Rig()
        rig.server.respond(status: status, headers: headers, text: body)
        return await serviceError { try await rig.service.place(1) }
    }

    @Test func aRedirectIsSignedOutAndIsNotFollowed() async {
        let rig = Rig()
        rig.server.answer { request in
            request.path == "/login" ? .response(status: 200, headers: [:], body: Data("<html>log in</html>".utf8))
                : .redirect(status: 302, location: "\(rig.server.address)/login")
        }
        let error = await serviceError { try await rig.service.place(1) }
        guard case .signedOut? = error else { Issue.record("expected signedOut, got \(String(describing: error))"); return }
        #expect(rig.server.requests.map(\.path) == ["/api/places/1"], "the Location was not asked for")
    }

    @Test func aRedirectOnAWriteIsSignedOutToo() async {
        let rig = Rig()
        rig.server.answer { _ in .redirect(status: 302, location: "https://login.example.test/") }
        let error = await serviceError { try await rig.service.deleteTrip("2026-03-20") }
        guard case .signedOut? = error else { Issue.record("expected signedOut, got \(String(describing: error))"); return }
        #expect(rig.server.requests.count == 1)
    }

    @Test func a401IsSignedOut() async {
        let error = await read(status: 401)
        guard case .signedOut? = error else { Issue.record("expected signedOut, got \(String(describing: error))"); return }
    }

    @Test func a404CarriesTheAPIsMessage() async {
        let error = await read(status: 404, body: apiError)
        guard case .notFound(let message)? = error else { Issue.record("expected notFound, got \(String(describing: error))"); return }
        #expect(message == "There is no such place.")
    }

    @Test func a404WithoutAMessageSaysItIsGone() async {
        for body in ["", "not json", #"{"errors":{}}"#, #"{"errors":{"id":[]}}"#] {
            let error = await read(status: 404, body: body)
            guard case .notFound(let message)? = error else { Issue.record("expected notFound, got \(String(describing: error))"); return }
            #expect(message == "It's not there any more.", "body: \(body)")
        }
    }

    @Test func a409IsAConflictWithTheMessage() async {
        let error = await read(status: 409, body: #"{"errors":{"place":["Those are the same place."]}}"#)
        guard case .conflict(let message)? = error else { Issue.record("expected conflict, got \(String(describing: error))"); return }
        #expect(message == "Those are the same place.")
    }

    @Test func a409WithoutAMessageHasAnExplanation() async {
        let error = await read(status: 409)
        guard case .conflict(let message)? = error else { Issue.record("expected conflict, got \(String(describing: error))"); return }
        #expect(!message.isEmpty)
    }

    @Test func a400WithTheFixtureBodyIsRefusedWithTheFirstMessage() async throws {
        let rig = Rig()
        try rig.server.respond(fixture: "error-400", status: 400)
        let error = await serviceError { try await rig.service.renamePlace(1, name: String(repeating: "x", count: 101)) }
        guard case .refused(let message)? = error else { Issue.record("expected refused, got \(String(describing: error))"); return }
        #expect(message == "The name can be at most 100 characters.")
    }

    @Test func theFirstMessageIsOfTheFirstFieldByName() {
        let body = Data(#"{"errors":{"to":["b1","b2"],"from":["a1"]}}"#.utf8)
        #expect(HTTPService.detail(body) == "a1")
    }

    @Test func aRefusalWithoutAMessageNamesTheStatus() async {
        let error = await read(status: 415)
        guard case .refused(let message)? = error else { Issue.record("expected refused, got \(String(describing: error))"); return }
        #expect(message.contains("415"))
    }

    @Test(arguments: [500, 502, 503, 408, 429])
    func serverStatusesAreServerErrors(status: Int) async {
        let error = await read(status: status)
        guard case .server(let code)? = error else { Issue.record("expected server, got \(String(describing: error))"); return }
        #expect(code == status)
    }

    @Test func aHTMLPageWithA200IsUnreadable() async {
        let error = await read(status: 200, headers: ["Content-Type": "text/html"], body: "<!doctype html><html><body>Sign in</body></html>")
        guard case .unreadable? = error else { Issue.record("expected unreadable, got \(String(describing: error))"); return }
    }

    @Test func aWriteThatAnswersJSONOfAnotherShapeIsUnreadable() async {
        let rig = Rig()
        rig.server.respond(text: "<html></html>")
        let error = await serviceError { try await rig.service.retryFailed() }
        guard case .unreadable? = error else { Issue.record("expected unreadable, got \(String(describing: error))"); return }
    }

    @Test func aTimeThatIsNotISO8601IsUnreadable() async {
        let rig = Rig()
        rig.server.respond(text: #"[{"key":"2026-03-20","label":"x","deletedAt":"yesterday"}]"#)
        let error = await serviceError { try await rig.service.deletedTrips() }
        guard case .unreadable? = error else { Issue.record("expected unreadable, got \(String(describing: error))"); return }
    }

    @Test func retryability() {
        #expect(ServiceError.offline.isRetryable && ServiceError.server(500).isRetryable && ServiceError.signedOut.isRetryable)
        #expect(!ServiceError.notFound("").isRetryable && !ServiceError.refused("").isRetryable && !ServiceError.unreadable.isRetryable)
    }

    @Test func percentEncodingKeepsOnlyUnreservedCharacters() {
        #expect(HTTPService.query("a b&c/d?é~-._") == "a%20b%26c%2Fd%3F%C3%A9~-._")
        #expect(HTTPService.segment("x y/z") == "x%20y%2Fz")
    }
}
