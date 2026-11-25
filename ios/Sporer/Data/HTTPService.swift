import Foundation

/// The Sporer API over HTTP (README.md), at the address in Settings.
///
/// - Reads send the `ETag` of the answer saved last time and take a `304` as "it has not changed"; every answer is saved
///   (`ResponseStore`) so that a screen can open on it at once (`ServiceContext.Mode.cacheOnly`) and still show it when the
///   server can't be reached (when the load listens with a `CacheNote`).
/// - Writes send JSON, `{}` when there is no body (the API refuses a write that isn't JSON), and say that the data changed when
///   they go through, or when they find that what they were about is gone (a 404), so that what is on screen is asked for again.
/// - Redirects are not followed. The API never redirects; a login in front of it does when its session has ended, and following it
///   would hand the app a web page. A redirect is `ServiceError.signedOut`.
nonisolated final class HTTPService: SporerService {
    private let session: URLSession
    private let store: ResponseStore
    private let address: @Sendable () -> String

    init(
        address: @escaping @Sendable () -> String = { ServerDefaults.current },
        store: ResponseStore = .shared,
        configuration: URLSessionConfiguration = HTTPService.configuration()
    ) {
        self.address = address
        self.store = store
        session = URLSession(configuration: configuration, delegate: RedirectRefuser(), delegateQueue: nil)
    }

    static func configuration() -> URLSessionConfiguration {
        let c = URLSessionConfiguration.default
        c.urlCache = nil // the store keeps the answers, and sends their ETags itself
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        c.timeoutIntervalForRequest = 20
        c.waitsForConnectivity = false
        c.httpAdditionalHeaders = ["Accept": "application/json"]
        return c
    }

    var keepsResponses: Bool { true }

    // MARK: Timeline

    func day(_ date: LocalDate) async throws -> DayResponse { try await get("/api/day/\(date)") }

    func range(from: LocalDate, to: LocalDate) async throws -> RangeResponse {
        try await get("/api/range?from=\(from)&to=\(to)")
    }

    func heat(from: LocalDate, to: LocalDate) async throws -> HeatResponse {
        try await get("/api/heat?from=\(from)&to=\(to)")
    }

    // MARK: Points

    // Tens of thousands of points, and a day's points change with every removal: never saved.
    func dayPoints(_ date: LocalDate) async throws -> DayPointsResponse { try await get("/api/day/\(date)/points", keep: false) }

    func pointDetail(device: String, t: Int64) async throws -> PointDetailResponse {
        try await get("/api/points/detail?device=\(Self.query(device))&t=\(t)", keep: false)
    }

    func removePoints(_ points: [PointRef]) async throws -> RemovePointsResponse {
        try await send("POST", "/api/points/remove", body: RemovePointsRequest(points: points))
    }

    func removedPoints() async throws -> [RemovedBatch] { try await get("/api/points/removed") }

    func restorePoints(batch: String) async throws {
        try await send("DELETE", "/api/points/removed/\(Self.segment(batch))")
    }

    // MARK: Places

    func place(_ id: Int) async throws -> PlaceResponse { try await get("/api/places/\(id)") }

    func searchPlaces(_ query: String) async throws -> [PlaceSearchResult] {
        try await get(query.isEmpty ? "/api/places/search" : "/api/places/search?q=\(Self.query(query))", keep: query.isEmpty)
    }

    func mergeCandidates(for id: Int, query: String) async throws -> [PlaceCandidate] {
        try await get(query.isEmpty ? "/api/places/\(id)/candidates" : "/api/places/\(id)/candidates?q=\(Self.query(query))", keep: false)
    }

    func renamePlace(_ id: Int, name: String?) async throws -> PlaceResponse {
        try await send("PUT", "/api/places/\(id)/name", body: NameRequest(name: name))
    }

    func mergePlace(_ other: Int, into id: Int, name: String??) async throws -> PlaceResponse {
        try await send("POST", "/api/places/\(id)/merge", body: MergeRequest(place: other, name: name))
    }

    func separatePlace(_ other: Int, from id: Int) async throws {
        try await send("DELETE", "/api/places/\(id)/merged/\(other)")
    }

    // MARK: Trips

    func trips() async throws -> [TripListItem] {
        let response: TripsResponse = try await get("/api/trips")
        return response.trips
    }

    func trip(_ id: String) async throws -> TripResponse { try await get("/api/trips/\(Self.segment(id))") }

    func editTrip(_ id: String, _ edit: EditTripRequest) async throws -> EditTripResponse {
        try await send("PUT", "/api/trips/\(Self.segment(id))", body: edit)
    }

    func deleteTrip(_ id: String) async throws { try await send("DELETE", "/api/trips/\(Self.segment(id))") }

    func deletedTrips() async throws -> [DeletedTrip] { try await get("/api/trips/deleted") }

    func restoreTrip(key: String) async throws {
        try await send("POST", "/api/trips/deleted/\(Self.segment(key))/restore")
    }

    // MARK: Homes, settings, status

    func homes() async throws -> [HomePeriod] {
        let response: HomesResponse = try await get("/api/homes")
        return response.periods
    }

    func addHome(_ request: AddHomeRequest) async throws -> HomePeriod { try await send("POST", "/api/homes", body: request) }

    func removeHome(_ id: Int) async throws { try await send("DELETE", "/api/homes/\(id)") }

    func settings() async throws -> SettingsResponse { try await get("/api/settings") }

    func setTripDistance(_ km: Double?) async throws -> SettingsResponse {
        try await send("PUT", "/api/settings", body: TripDistanceRequest(tripMinDistanceKm: km))
    }

    func status() async throws -> StatusResponse { try await get("/api/status") }

    func retryFailed() async throws -> RetryFailedResponse { try await send("POST", "/api/status/retry") }

    // MARK: Reads

    /// GETs `path` and decodes its JSON, as `ServiceContext` asks: see the type's comment. `keep` false neither saves the answer
    /// nor gives a saved one.
    private func get<T: Decodable>(_ path: String, keep: Bool = true) async throws -> T {
        let url = try url(path)
        let key = url.absoluteString
        let saved = keep ? store.read(key) : nil

        if ServiceContext.mode == .cacheOnly {
            guard let saved, let value: T = try? decode(saved.body) else { throw ServiceError.notCached }
            ServiceContext.note?.served(savedAt: saved.savedAt)
            return value
        }

        var request = URLRequest(url: url)
        if let etag = saved?.etag { request.setValue(etag, forHTTPHeaderField: "If-None-Match") }

        let data: Data, response: HTTPURLResponse
        do {
            (data, response) = try await exchange(request)
        } catch ServiceError.offline {
            // Out of reach: the saved answer, for a load that says it can show one as such.
            if let note = ServiceContext.note, let saved, let value: T = try? decode(saved.body) {
                note.served(savedAt: saved.savedAt)
                return value
            }
            throw ServiceError.offline
        }

        if response.statusCode == 304, let saved {
            store.touch(key)
            if let value: T = try? decode(saved.body) { return value }
            store.remove(key) // unreadable now (the app changed): ask again for the whole answer
            return try await get(path, keep: keep)
        }
        try Self.check(response, data)
        let value: T = try decode(data)
        if keep { store.write(key, body: data, etag: response.value(forHTTPHeaderField: "ETag")) }
        return value
    }

    // MARK: Writes

    private func send<T: Decodable>(_ method: String, _ path: String, body: (any Encodable)? = nil) async throws -> T {
        let data = try await write(method, path, body: body)
        return try decode(data)
    }

    private func send(_ method: String, _ path: String, body: (any Encodable)? = nil) async throws {
        _ = try await write(method, path, body: body)
    }

    private func write(_ method: String, _ path: String, body: (any Encodable)?) async throws -> Data {
        var request = URLRequest(url: try url(path))
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try body.map { try JSONCoding.encoder().encode($0) } ?? Data("{}".utf8)
        let (data, response) = try await exchange(request)
        do {
            try Self.check(response, data)
        } catch ServiceError.notFound(let message) {
            Self.didChange() // what the write was about is gone: what is on screen is out of date
            throw ServiceError.notFound(message)
        }
        Self.didChange()
        return data
    }

    private static func didChange() {
        Task { @MainActor in AppModel.dataChanged() }
    }

    // MARK: The exchange

    private func url(_ path: String) throws -> URL {
        guard let base = ServerDefaults.normalised(address()), let url = URL(string: base + path) else { throw ServiceError.badAddress }
        return url
    }

    /// Sends the request. A request that gets no answer is `offline`; a cancelled one, `CancellationError`.
    private func exchange(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else { throw ServiceError.unreadable }
            return (data, http)
        } catch let error as URLError {
            if error.code == .cancelled { throw CancellationError() }
            if error.code == .appTransportSecurityRequiresSecureConnection { throw ServiceError.badAddress }
            throw ServiceError.offline
        }
    }

    private func decode<T: Decodable>(_ data: Data) throws -> T {
        do {
            return try JSONCoding.decoder().decode(T.self, from: data)
        } catch {
            throw ServiceError.unreadable
        }
    }

    /// Throws what an answer that isn't a success means. See README.md, "Writes", for the statuses.
    static func check(_ response: HTTPURLResponse, _ data: Data) throws {
        let code = response.statusCode
        switch code {
        case 200..<300: return
        case 300..<400: throw ServiceError.signedOut
        case 401: throw ServiceError.signedOut
        case 404: throw ServiceError.notFound(detail(data) ?? "It's not there any more.")
        case 409: throw ServiceError.conflict(detail(data) ?? "That conflicts with something already there.")
        case 408, 429: throw ServiceError.server(code)
        case 400..<500: throw ServiceError.refused(detail(data) ?? "The server refused the request (\(code)).")
        default: throw ServiceError.server(code)
        }
    }

    /// The first message of the API's error body, `{"errors": {"name": ["The name is …"]}}`: for showing as it is.
    static func detail(_ data: Data) -> String? {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let errors = object["errors"] as? [String: Any] else { return nil }
        for key in errors.keys.sorted() {
            if let messages = errors[key] as? [String], let first = messages.first, !first.isEmpty { return first }
        }
        return nil
    }

    // MARK: Encoding values into a URL

    private static let unreserved = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~")

    static func query(_ value: String) -> String { value.addingPercentEncoding(withAllowedCharacters: unreserved) ?? value }
    static func segment(_ value: String) -> String { value.addingPercentEncoding(withAllowedCharacters: unreserved) ?? value }
}

/// Answers every redirect with "don't follow it": the redirect itself is then the response (see `HTTPService`).
private nonisolated final class RedirectRefuser: NSObject, URLSessionTaskDelegate, Sendable {
    // The completion-handler form: the async one crashes the Swift 6.4 compiler (SILGen of its Objective-C thunk).
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

// MARK: - Bodies of the writes

private nonisolated struct RemovePointsRequest: Encodable {
    var points: [PointRef]
}

/// `null` brings OpenStreetMap's name back; the key must be there either way.
private nonisolated struct NameRequest: Encodable {
    var name: String?
    func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(name, forKey: .name)
    }
    private enum CodingKeys: String, CodingKey { case name }
}

/// `name` left out leaves the survivor's name; `null` or "" clears it.
private nonisolated struct MergeRequest: Encodable {
    var place: Int
    var name: String??
    func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(place, forKey: .place)
        if let name { try c.encode(name, forKey: .name) }
    }
    private enum CodingKeys: String, CodingKey { case place, name }
}

/// `null` takes the owner's distance back; the key must be there either way.
private nonisolated struct TripDistanceRequest: Encodable {
    var tripMinDistanceKm: Double?
    func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(tripMinDistanceKm, forKey: .tripMinDistanceKm)
    }
    private enum CodingKeys: String, CodingKey { case tripMinDistanceKm }
}
