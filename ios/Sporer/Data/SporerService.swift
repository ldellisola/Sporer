import Foundation

/// Everything the app asks of the Sporer server, one method per endpoint of the API (see README.md).
/// `MockService` answers from made-up data for previews and the design prototype; the HTTP client answers from the server.
protocol SporerService: Sendable {
    /// Whether the service keeps its answers, so that a load can open on a saved one (`ServiceContext.Mode.cacheOnly`).
    var keepsResponses: Bool { get }

    // Timeline
    func day(_ date: LocalDate) async throws -> DayResponse
    func range(from: LocalDate, to: LocalDate) async throws -> RangeResponse
    func heat(from: LocalDate, to: LocalDate) async throws -> HeatResponse

    // Points
    func dayPoints(_ date: LocalDate) async throws -> DayPointsResponse
    func pointDetail(device: String, t: Int64) async throws -> PointDetailResponse
    func removePoints(_ points: [PointRef]) async throws -> RemovePointsResponse
    func removedPoints() async throws -> [RemovedBatch]
    func restorePoints(batch: String) async throws

    // Places
    func place(_ id: Int) async throws -> PlaceResponse
    func searchPlaces(_ query: String) async throws -> [PlaceSearchResult]
    func mergeCandidates(for id: Int, query: String) async throws -> [PlaceCandidate]
    func renamePlace(_ id: Int, name: String?) async throws -> PlaceResponse
    /// `name`: `.none` leaves the survivor's name as it is, `.some(nil)` or an empty string clears it.
    func mergePlace(_ other: Int, into id: Int, name: String??) async throws -> PlaceResponse
    func separatePlace(_ other: Int, from id: Int) async throws

    // Trips
    func trips() async throws -> [TripListItem]
    func trip(_ id: String) async throws -> TripResponse
    func editTrip(_ id: String, _ edit: EditTripRequest) async throws -> EditTripResponse
    func deleteTrip(_ id: String) async throws
    func deletedTrips() async throws -> [DeletedTrip]
    func restoreTrip(key: String) async throws

    // Homes, settings, status
    func homes() async throws -> [HomePeriod]
    func addHome(_ request: AddHomeRequest) async throws -> HomePeriod
    func removeHome(_ id: Int) async throws
    func settings() async throws -> SettingsResponse
    func setTripDistance(_ km: Double?) async throws -> SettingsResponse
    func status() async throws -> StatusResponse
    func retryFailed() async throws -> RetryFailedResponse
}

extension SporerService {
    nonisolated var keepsResponses: Bool { false }
}

/// What a request can end in, worded for the views.
nonisolated enum ServiceError: LocalizedError, Sendable {
    case offline
    case signedOut
    case notFound(String)
    case conflict(String)
    case refused(String)
    case server(Int)
    /// The answer isn't the JSON the app knows: a server of another version, or something else at the address.
    case unreadable
    /// The address in Settings isn't one the app can use.
    case badAddress
    /// A load that asked for a saved answer only, and there is none (`ServiceContext.Mode.cacheOnly`).
    case notCached

    var errorDescription: String? {
        switch self {
        case .offline: "The server can't be reached. Are you on the VPN?"
        case .signedOut: "The server asked to sign in, which the app can't do yet. Check the server's address in Settings."
        case .notFound(let m), .conflict(let m), .refused(let m): m
        case .server(let code): "The server had a problem (\(code))."
        case .unreadable: "The server's answer couldn't be read. Check the server's address in Settings, and that the server and the app are up to date."
        case .badAddress: "The server's address isn't valid. Check it in Settings."
        case .notCached: "Nothing saved on this device."
        }
    }

    /// Asking again can help after a network failure, a sign-in or a 5xx; a refusal stays refused.
    var isRetryable: Bool {
        switch self {
        case .offline, .server, .signedOut: true
        default: false
        }
    }
}
