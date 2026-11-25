import Foundation
import Synchronization
@testable import Sporer

/// What the stub saw of one request.
nonisolated struct RecordedRequest: Sendable {
    var method: String
    var url: URL
    var headers: [String: String]
    var body: Data

    var path: String { url.path(percentEncoded: true) }
    var absolute: String { url.absoluteString }
    func header(_ name: String) -> String? { headers.first { $0.key.lowercased() == name.lowercased() }?.value }
    var bodyText: String { String(decoding: body, as: UTF8.self) }
    /// The body's JSON, for comparing without caring for the order of the keys.
    var bodyJSON: NSDictionary? { (try? JSONSerialization.jsonObject(with: body)) as? NSDictionary }
}

nonisolated enum StubReply: Sendable {
    case response(status: Int, headers: [String: String], body: Data)
    /// A redirect: sent to the session as one, so that its delegate decides whether to follow it.
    case redirect(status: Int, location: String)
    case failure(URLError.Code)
}

/// One fake server, found by its host: each test makes its own, so that tests can run in parallel.
nonisolated final class StubServer: Sendable {
    let host = "h" + UUID().uuidString.replacing("-", with: "").lowercased() + ".test"
    var address: String { "http://\(host)" }

    private let handler = Mutex<@Sendable (RecordedRequest) -> StubReply>({ _ in .failure(.cannotConnectToHost) })
    private let log = Mutex<[RecordedRequest]>([])

    var requests: [RecordedRequest] { log.withLock { $0 } }

    init() {
        StubProtocol.servers.withLock { $0[host] = self }
    }

    deinit {
        let host = host
        StubProtocol.servers.withLock { $0[host] = nil }
    }

    /// Answers every request with `handler`.
    func answer(_ handler: @escaping @Sendable (RecordedRequest) -> StubReply) {
        self.handler.withLock { $0 = handler }
    }

    func respond(status: Int = 200, headers: [String: String] = [:], body: Data = Data()) {
        answer { _ in .response(status: status, headers: headers, body: body) }
    }

    func respond(status: Int = 200, headers: [String: String] = [:], text: String) {
        respond(status: status, headers: headers, body: Data(text.utf8))
    }

    func respond(fixture name: String, status: Int = 200, headers: [String: String] = [:]) throws {
        respond(status: status, headers: headers, body: try Fixtures.data(name))
    }

    func fail(_ code: URLError.Code = .notConnectedToInternet) {
        answer { _ in .failure(code) }
    }

    fileprivate func serve(_ request: RecordedRequest) -> StubReply {
        log.withLock { $0.append(request) }
        let handler = handler.withLock { $0 }
        return handler(request)
    }
}

nonisolated final class StubProtocol: URLProtocol {
    static let servers = Mutex<[String: StubServer]>([:])

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url, let host = url.host, let server = Self.servers.withLock({ $0[host] }) else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotFindHost))
            return
        }
        var headers: [String: String] = [:]
        for (key, value) in request.allHTTPHeaderFields ?? [:] { headers[key] = value }
        let recorded = RecordedRequest(method: request.httpMethod ?? "GET", url: url, headers: headers, body: Self.body(of: request))

        switch server.serve(recorded) {
        case .failure(let code):
            client?.urlProtocol(self, didFailWithError: URLError(code))
        case .redirect(let status, let location):
            let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Location": location])!
            client?.urlProtocol(self, wasRedirectedTo: URLRequest(url: URL(string: location)!), redirectResponse: response)
            // A session that does not follow it goes on with the redirect as the answer; one that does has stopped this load.
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocolDidFinishLoading(self)
        case .response(let status, let headers, let body):
            let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            if !body.isEmpty { client?.urlProtocol(self, didLoad: body) }
            client?.urlProtocolDidFinishLoading(self)
        }
    }

    override func stopLoading() {}

    private static func body(of request: URLRequest) -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let n = stream.read(&buffer, maxLength: buffer.count)
            if n <= 0 { break }
            data.append(buffer, count: n)
        }
        return data
    }
}

/// The answers captured from a local server with made-up data (Fixtures/).
nonisolated enum Fixtures {
    private final class BundleToken {}

    struct Missing: Error { var name: String }

    static func data(_ name: String) throws -> Data {
        let bundle = Bundle(for: BundleToken.self)
        guard let url = bundle.url(forResource: name, withExtension: "json", subdirectory: "Fixtures")
            ?? bundle.url(forResource: name, withExtension: "json")
        else { throw Missing(name: name) }
        return try Data(contentsOf: url)
    }

    static func decode<T: Decodable>(_ type: T.Type, _ name: String) throws -> T {
        try JSONCoding.decoder().decode(T.self, from: data(name))
    }
}

/// A service on a stub server, with a store in a directory of its own.
final class Rig {
    let server = StubServer()
    let store: ResponseStore
    let service: HTTPService
    let directory: URL

    init(storeLimit: Int = 96 * 1024 * 1024) {
        directory = FileManager.default.temporaryDirectory.appending(path: "SporerTests-\(UUID().uuidString)", directoryHint: .isDirectory)
        store = ResponseStore(directory: directory, limit: storeLimit)
        let configuration = HTTPService.configuration()
        configuration.protocolClasses = [StubProtocol.self]
        let address = server.address
        service = HTTPService(address: { address }, store: store, configuration: configuration)
    }

    deinit { try? FileManager.default.removeItem(at: directory) }

    /// The files in the store's directory (none when it was never written to).
    var savedFiles: [String] { (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? [] }

    func key(_ path: String) -> String { server.address + path }
}

/// What the operation threw, as a `ServiceError`; nil when it threw nothing (or something else).
func serviceError(_ operation: () async throws -> some Any) async -> ServiceError? {
    do { _ = try await operation() } catch let error as ServiceError { return error } catch {}
    return nil
}
