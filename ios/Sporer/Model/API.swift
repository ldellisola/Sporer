import CoreLocation
import Foundation

// The JSON of the Sporer API, as web/src/api/types.ts and the C# records under src/Sporer.Api/Features/ write it:
// camelCase, null written out, times as ISO-8601 UTC strings with a Z, dates as plain yyyy-MM-dd.

nonisolated enum LoadState: String, Codable, Sendable {
    case done, pending
}

/// A position as GeoJSON writes it, longitude first: `[lon, lat]`.
nonisolated struct LonLat: Codable, Hashable, Sendable {
    var lon: Double
    var lat: Double

    init(lon: Double, lat: Double) {
        self.lon = lon
        self.lat = lat
    }

    init(from decoder: any Decoder) throws {
        var c = try decoder.unkeyedContainer()
        lon = try c.decode(Double.self)
        lat = try c.decode(Double.self)
    }

    func encode(to encoder: any Encoder) throws {
        var c = encoder.unkeyedContainer()
        try c.encode(lon)
        try c.encode(lat)
    }

    var coordinate: CLLocationCoordinate2D { .init(latitude: lat, longitude: lon) }
}

nonisolated struct LatLon: Codable, Hashable, Sendable {
    var lat: Double
    var lon: Double
    var coordinate: CLLocationCoordinate2D { .init(latitude: lat, longitude: lon) }
}

// MARK: - GET /api/day/{date}

nonisolated struct DayResponse: Codable, Hashable, Sendable {
    var date: LocalDate
    var timeZone: String
    var state: LoadState
    var summary: DaySummary
    var segments: [DaySegment]
}

nonisolated struct DaySummary: Codable, Hashable, Sendable {
    var places: Int
    var distanceMeters: Double
    var movingSeconds: Double
}

/// The place of a stay: the id is the one that survives a merge.
nonisolated struct PlaceRef: Codable, Hashable, Sendable {
    var id: Int
    var name: String?
    var city: String?
    var country: String?
    var lat: Double
    var lon: Double
    var coordinate: CLLocationCoordinate2D { .init(latitude: lat, longitude: lon) }
}

nonisolated enum DaySegment: Codable, Hashable, Sendable, Identifiable {
    case stay(Stay)
    case move(Move)
    case gap(Gap)

    struct Stay: Codable, Hashable, Sendable {
        var id: Int
        var start: Date
        var end: Date
        var startTimeZone: String
        var endTimeZone: String
        var place: PlaceRef?
        var home: Bool
    }

    struct Move: Codable, Hashable, Sendable {
        var id: Int
        var start: Date
        var end: Date
        var startTimeZone: String
        var endTimeZone: String
        var mode: Mode?
        var distanceMeters: Double
        var geometry: [LonLat]
        /// The owner set the mode by hand. A server older than the mode edits leaves it out: false.
        var modeEdited = false
    }

    struct Gap: Codable, Hashable, Sendable {
        var id: Int
        var start: Date
        var end: Date
        var startTimeZone: String
        var endTimeZone: String
        var from: LatLon?
        var to: LatLon?
    }

    private enum Kind: String, Codable { case stay, move, gap }
    private enum CodingKeys: String, CodingKey { case kind }

    init(from decoder: any Decoder) throws {
        let kind = try decoder.container(keyedBy: CodingKeys.self).decode(Kind.self, forKey: .kind)
        switch kind {
        case .stay: self = .stay(try Stay(from: decoder))
        case .move: self = .move(try Move(from: decoder))
        case .gap: self = .gap(try Gap(from: decoder))
        }
    }

    func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .stay(let s): try c.encode(Kind.stay, forKey: .kind); try s.encode(to: encoder)
        case .move(let m): try c.encode(Kind.move, forKey: .kind); try m.encode(to: encoder)
        case .gap(let g): try c.encode(Kind.gap, forKey: .kind); try g.encode(to: encoder)
        }
    }

    var id: String {
        switch self {
        case .stay(let s): "stay-\(s.id)"
        case .move(let m): "move-\(m.id)"
        case .gap(let g): "gap-\(g.id)"
        }
    }

    var start: Date {
        switch self {
        case .stay(let s): s.start
        case .move(let m): m.start
        case .gap(let g): g.start
        }
    }

    var end: Date {
        switch self {
        case .stay(let s): s.end
        case .move(let m): m.end
        case .gap(let g): g.end
        }
    }

    var duration: TimeInterval { end.timeIntervalSince(start) }
}

// In an extension, so that the memberwise initializer stays.
extension DaySegment.Move {
    nonisolated init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int.self, forKey: .id)
        start = try c.decode(Date.self, forKey: .start)
        end = try c.decode(Date.self, forKey: .end)
        startTimeZone = try c.decode(String.self, forKey: .startTimeZone)
        endTimeZone = try c.decode(String.self, forKey: .endTimeZone)
        mode = try c.decodeIfPresent(Mode.self, forKey: .mode)
        distanceMeters = try c.decode(Double.self, forKey: .distanceMeters)
        geometry = try c.decode([LonLat].self, forKey: .geometry)
        modeEdited = try c.decodeIfPresent(Bool.self, forKey: .modeEdited) ?? false
    }
}

// MARK: - Moves (PUT and DELETE /api/moves/{id}/mode)

/// What setting a move's mode answers: the stored move, with the mode the owner chose.
nonisolated struct MoveModeResponse: Codable, Hashable, Sendable {
    var id: Int
    var mode: Mode?
    var modeEdited: Bool
}

// MARK: - GET /api/range

nonisolated struct RangeResponse: Codable, Hashable, Sendable {
    var from: LocalDate
    var to: LocalDate
    var state: LoadState
    var summary: RangeSummary
    var moves: [RangeMove]
    var places: [RangePlace]
    var days: [RangeDay]
}

nonisolated struct RangeSummary: Codable, Hashable, Sendable {
    var places: Int
    var distanceMeters: Double
    var movingSeconds: Double
    var moves: Int
}

nonisolated struct RangeMove: Codable, Hashable, Sendable, Identifiable {
    var id: Int
    var mode: Mode?
    var start: Date
    var end: Date
    var geometry: [LonLat]
}

nonisolated struct RangePlace: Codable, Hashable, Sendable, Identifiable {
    var id: Int
    var name: String?
    var city: String?
    var country: String?
    var lat: Double
    var lon: Double
    var seconds: Double
    var visits: Int
    var coordinate: CLLocationCoordinate2D { .init(latitude: lat, longitude: lon) }
}

nonisolated struct RangeDay: Codable, Hashable, Sendable, Identifiable {
    var date: LocalDate
    var distanceMeters: Double
    var movingSeconds: Double
    var places: Int
    var id: LocalDate { date }
}

// MARK: - GET /api/heat

nonisolated struct HeatCell: Codable, Hashable, Sendable {
    var lon: Double
    var lat: Double
    var seconds: Double

    init(lon: Double, lat: Double, seconds: Double) {
        self.lon = lon
        self.lat = lat
        self.seconds = seconds
    }

    init(from decoder: any Decoder) throws {
        var c = try decoder.unkeyedContainer()
        lon = try c.decode(Double.self)
        lat = try c.decode(Double.self)
        seconds = try c.decode(Double.self)
    }

    func encode(to encoder: any Encoder) throws {
        var c = encoder.unkeyedContainer()
        try c.encode(lon)
        try c.encode(lat)
        try c.encode(seconds)
    }
}

nonisolated struct HeatResponse: Codable, Hashable, Sendable {
    var maxSeconds: Double
    var cells: [HeatCell]
}

// MARK: - Points (edit mode)

/// What the server made of a point: 0 used, 1 poor accuracy, 2 glitch, 3 a repeat. The last three are ignored by the timeline.
nonisolated enum PointStatus: Int, Codable, Sendable {
    case used = 0, poorAccuracy = 1, glitch = 2, duplicate = 3
    var isIgnored: Bool { self != .used }
}

/// One raw point: `[t, lon, lat, deviceIndex, status]`, `t` in epoch microseconds, exact.
nonisolated struct RawPoint: Codable, Hashable, Sendable {
    var t: Int64
    var lon: Double
    var lat: Double
    var device: Int
    var status: PointStatus

    init(t: Int64, lon: Double, lat: Double, device: Int, status: PointStatus) {
        self.t = t
        self.lon = lon
        self.lat = lat
        self.device = device
        self.status = status
    }

    init(from decoder: any Decoder) throws {
        var c = try decoder.unkeyedContainer()
        t = try c.decode(Int64.self)
        lon = try c.decode(Double.self)
        lat = try c.decode(Double.self)
        device = try c.decode(Int.self)
        status = try c.decode(PointStatus.self)
    }

    func encode(to encoder: any Encoder) throws {
        var c = encoder.unkeyedContainer()
        try c.encode(t)
        try c.encode(lon)
        try c.encode(lat)
        try c.encode(device)
        try c.encode(status)
    }

    var coordinate: CLLocationCoordinate2D { .init(latitude: lat, longitude: lon) }
}

nonisolated struct DayPointsResponse: Codable, Hashable, Sendable {
    var date: LocalDate
    var devices: [String]
    var points: [RawPoint]
}

/// A point as a removal names it: its device and exact time.
nonisolated struct PointRef: Codable, Hashable, Sendable {
    var device: String
    var t: Int64
}

nonisolated enum PointDetailStatus: String, Codable, Sendable {
    case used, poorAccuracy, glitch, duplicate, removed
}

nonisolated struct PointNeighbour: Codable, Hashable, Sendable {
    var t: Int64
    var gapSeconds: Double
    var distanceM: Double
    var speedKmh: Double
}

nonisolated struct PointSegment: Codable, Hashable, Sendable {
    struct Place: Codable, Hashable, Sendable {
        var id: Int
        var name: String?
    }
    var kind: String
    var startUtc: Date
    var endUtc: Date
    var place: Place?
    var mode: String?
}

nonisolated struct PointDetailResponse: Codable, Hashable, Sendable {
    var device: String
    var t: Int64
    var timeUtc: Date
    var localTime: String
    var zone: String
    var lat: Double
    var lon: Double
    var accuracyM: Double?
    var speedMps: Double?
    var altitudeM: Double
    var motion: [String]?
    var status: PointDetailStatus
    var maxAccuracyM: Double
    var previous: PointNeighbour?
    var next: PointNeighbour?
    var segment: PointSegment?
}

nonisolated struct RemovePointsResponse: Codable, Hashable, Sendable {
    var batch: String?
    var count: Int
}

nonisolated struct RemovedBatch: Codable, Hashable, Sendable, Identifiable {
    var batch: String
    var removedAt: Date
    var count: Int
    var from: Date
    var to: Date
    var localDates: [LocalDate]
    var id: String { batch }
}

// MARK: - Places

nonisolated struct PlaceResponse: Codable, Hashable, Sendable {
    var id: Int
    var name: String?
    var address: String?
    var city: String?
    var country: String?
    var lat: Double
    var lon: Double
    var totalSeconds: Double
    var visits: Int
    var firstVisit: Date
    var lastVisit: Date
    var recentVisits: [PlaceVisit]
    var merged: [MergedPlace]
    var coordinate: CLLocationCoordinate2D { .init(latitude: lat, longitude: lon) }
}

nonisolated struct PlaceVisit: Codable, Hashable, Sendable {
    var start: Date
    var end: Date
    var date: LocalDate
    var timeZone: String
}

nonisolated struct MergedPlace: Codable, Hashable, Sendable, Identifiable {
    var id: Int
    var name: String?
}

nonisolated struct PlaceCandidate: Codable, Hashable, Sendable, Identifiable {
    var id: Int
    var name: String?
    var address: String?
    var distanceM: Double
    var visits: Int
}

nonisolated struct PlaceSearchResult: Codable, Hashable, Sendable, Identifiable {
    var id: Int
    var name: String?
    var address: String?
    var visits: Int
}

// MARK: - Trips

nonisolated struct TripCity: Codable, Hashable, Sendable {
    var name: String
    var country: String?
    var nights: Int
    var lat: Double
    var lon: Double
    var coordinate: CLLocationCoordinate2D { .init(latitude: lat, longitude: lon) }
}

nonisolated struct TripListItem: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var name: String
    var firstNight: LocalDate
    var lastNight: LocalDate
    var nights: Int
    var start: Date
    var end: Date?
    var startTimeZone: String
    var endTimeZone: String
    var localStartDate: LocalDate
    var localEndDate: LocalDate
    var ongoing: Bool
    var cities: [TripCity]
    var edited: Bool
    var ownName: String?
    var startEdited: Bool
    var endEdited: Bool
    var thumbnail: [LonLat]
}

nonisolated struct TripsResponse: Codable, Hashable, Sendable {
    var trips: [TripListItem]
}

nonisolated struct TripStats: Codable, Hashable, Sendable {
    var flights: Int
    var cities: Int
    var places: Int
    var groundDistanceMeters: Double
}

nonisolated struct TripMove: Codable, Hashable, Sendable, Identifiable {
    var id: Int
    var mode: Mode?
    var distanceMeters: Double
    var geometry: [LonLat]
}

nonisolated struct TripDay: Codable, Hashable, Sendable, Identifiable {
    var date: LocalDate
    var description: String
    var highlights: [String]
    var groundDistanceMeters: Double
    var flights: Int
    var id: LocalDate { date }
}

nonisolated struct TripResponse: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var name: String
    var firstNight: LocalDate
    var lastNight: LocalDate
    var nights: Int
    var start: Date
    var end: Date?
    var startTimeZone: String
    var endTimeZone: String
    var localStartDate: LocalDate
    var localEndDate: LocalDate
    var ongoing: Bool
    var cities: [TripCity]
    var edited: Bool
    var ownName: String?
    var startEdited: Bool
    var endEdited: Bool
    var stats: TripStats
    var moves: [TripMove]
    var days: [TripDay]
}

nonisolated struct EditTripRequest: Codable, Hashable, Sendable {
    var name: String?
    var startDate: LocalDate?
    var endDate: LocalDate?

    // All three must be written out, null included.
    func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(name, forKey: .name)
        try c.encode(startDate, forKey: .startDate)
        try c.encode(endDate, forKey: .endDate)
    }
}

nonisolated struct EditTripResponse: Codable, Hashable, Sendable {
    var id: String
}

nonisolated struct DeletedTrip: Codable, Hashable, Sendable, Identifiable {
    var key: String
    var label: String
    var deletedAt: Date
    var id: String { key }
}

// MARK: - Homes and settings

nonisolated enum HomeSource: String, Codable, Sendable {
    case detected, user
}

nonisolated struct HomePeriod: Codable, Hashable, Sendable, Identifiable {
    var id: Int
    var placeId: Int
    var placeName: String?
    var from: LocalDate
    var to: LocalDate?
    var source: HomeSource
}

nonisolated struct HomesResponse: Codable, Hashable, Sendable {
    var periods: [HomePeriod]
}

nonisolated struct AddHomeRequest: Codable, Hashable, Sendable {
    var placeId: Int
    var from: LocalDate
    var to: LocalDate?

    func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(placeId, forKey: .placeId)
        try c.encode(from, forKey: .from)
        try c.encode(to, forKey: .to)
    }
}

nonisolated struct SettingsResponse: Codable, Hashable, Sendable {
    var tripMinDistanceKm: Double
    var tripMinDistanceKmDefault: Double
}

// MARK: - Status

nonisolated struct StatusResponse: Codable, Hashable, Sendable {
    var algorithmVersion: String?
    var backfill: BackfillStatus
    var pendingRanges: Int
    var failedRanges: [FailedRange]
    var lastRunAt: Date?
    var lastError: String?
    var places: PlaceStatus
    var warnings: [String]
}

nonisolated struct BackfillStatus: Codable, Hashable, Sendable {
    var from: Date?
    var to: Date?
    var cursor: Date?
    var percent: Int
    var paused: Bool
}

nonisolated struct FailedRange: Codable, Hashable, Sendable {
    var from: Date
    var to: Date
    var attempts: Int
    var lastError: String?
}

nonisolated struct PlaceStatus: Codable, Hashable, Sendable {
    var total: Int
    var unnamed: Int
    var failed: Int
}

nonisolated struct RetryFailedResponse: Codable, Hashable, Sendable {
    var retried: Int
}
