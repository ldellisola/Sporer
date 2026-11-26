import CoreLocation
import Foundation

/// Made-up data for previews and the design prototype: a person living in Oslo, with a weekday commute, weekends out,
/// and a trip to Lisbon and Porto. Routes are real street routes (MockRoutes.json, computed once with MapKit directions).
/// Edits (renames, merges, removed points, modes, trip edits, homes) are kept in memory, so the prototype behaves like the app.
actor MockService: SporerService {
    static let shared = MockService()

    private let world = MockWorld.load()
    private var ownNames: [Int: String] = [:]
    private var mergedInto: [Int: Int] = [:]
    private var removed: [String: (date: Date, refs: [PointRef], dates: [LocalDate])] = [:]
    private var deleted: [String: DeletedTrip] = [
        "2026-01-03": DeletedTrip(key: "2026-01-03", label: "Drammen · 3 – 4 Jan 2026", deletedAt: Date(timeIntervalSince1970: 1_767_700_000)),
    ]
    private var tripDistance: Double?
    private var userHomes: [HomePeriod] = []
    private var tripEdits: [String: EditTripRequest] = [:]
    /// The modes the owner set, by move id (the made-up ids never change).
    private var modeEdits: [Int: Mode] = [:]
    private var failedRetried = false

    /// A short pause so that loading states can be seen.
    private func pause(_ ms: Int = 250) async {
        try? await Task.sleep(for: .milliseconds(ms))
    }

    // MARK: Timeline

    /// Every write says the data changed, as the HTTP client does, so that what is on screen is asked for again.
    private nonisolated static func didChange() {
        Task { @MainActor in AppModel.dataChanged() }
    }

    func day(_ date: LocalDate) async throws -> DayResponse {
        await pause()
        return buildDay(date)
    }

    func range(from: LocalDate, to: LocalDate) async throws -> RangeResponse {
        await pause(400)
        var moves: [RangeMove] = []
        var seenRoutes = Set<String>()
        var places: [Int: RangePlace] = [:]
        var days: [RangeDay] = []
        let total = from.days(to: to) + 1
        let dedupe = total > 31
        for offset in 0..<min(total, 400) {
            let date = from.adding(days: offset)
            if date > .today { break }
            let built = buildDayDetailed(date)
            var dayPlaces = Set<Int>()
            var distance = 0.0, moving = 0.0
            for item in built {
                switch item.segment {
                case .move(let m):
                    distance += m.distanceMeters
                    moving += m.end.timeIntervalSince(m.start)
                    if !dedupe || seenRoutes.insert(item.routeKey ?? "\(m.id)").inserted {
                        moves.append(RangeMove(id: m.id, mode: m.mode, start: m.start, end: m.end, geometry: m.geometry))
                    }
                case .stay(let s):
                    guard let p = s.place else { continue }
                    dayPlaces.insert(p.id)
                    let dayStart = date.start(in: Format.zone(s.startTimeZone))
                    let dayEnd = date.adding(days: 1).start(in: Format.zone(s.endTimeZone))
                    let seconds = min(s.end, dayEnd).timeIntervalSince(max(s.start, dayStart))
                    var rp = places[p.id] ?? RangePlace(id: p.id, name: p.name, city: p.city, country: p.country, lat: p.lat, lon: p.lon, seconds: 0, visits: 0)
                    rp.seconds += max(0, seconds)
                    if s.start >= dayStart { rp.visits += 1 }
                    places[p.id] = rp
                case .gap:
                    break
                }
            }
            if !built.isEmpty {
                days.append(RangeDay(date: date, distanceMeters: distance, movingSeconds: moving, places: dayPlaces.count))
            }
        }
        let ranked = places.values.sorted { $0.seconds > $1.seconds }
        return RangeResponse(
            from: from, to: to, state: to >= .today ? .pending : .done,
            summary: RangeSummary(places: ranked.count, distanceMeters: days.reduce(0) { $0 + $1.distanceMeters },
                                  movingSeconds: days.reduce(0) { $0 + $1.movingSeconds }, moves: moves.count),
            moves: moves, places: ranked, days: days
        )
    }

    func heat(from: LocalDate, to: LocalDate) async throws -> HeatResponse {
        await pause(300)
        var cells: [String: HeatCell] = [:]
        func add(_ c: CLLocationCoordinate2D, _ seconds: Double) {
            let lat = (c.latitude * 1000).rounded() / 1000, lon = (c.longitude * 1000).rounded() / 1000
            let key = "\(lat),\(lon)"
            cells[key, default: HeatCell(lon: lon, lat: lat, seconds: 0)].seconds += seconds
        }
        let total = min(from.days(to: to) + 1, 400)
        for offset in 0..<total {
            let date = from.adding(days: offset)
            if date > .today { break }
            for item in buildDayDetailed(date) {
                switch item.segment {
                case .stay(let s):
                    guard let p = s.place else { continue }
                    var rng = SplitMix(seed: UInt64(p.id * 7919 + offset))
                    let seconds = s.end.timeIntervalSince(s.start)
                    for _ in 0..<4 {
                        add(CLLocationCoordinate2D(latitude: p.lat + rng.jitter(0.0012), longitude: p.lon + rng.jitter(0.002)), seconds / 4)
                    }
                case .move(let m) where m.mode != .flight:
                    let per = m.end.timeIntervalSince(m.start) / Double(max(1, m.geometry.count))
                    for p in m.geometry { add(p.coordinate, per) }
                default:
                    break
                }
            }
        }
        let sorted = cells.values.sorted { $0.seconds > $1.seconds }
        return HeatResponse(maxSeconds: sorted.first?.seconds ?? 0, cells: sorted)
    }

    // MARK: Points

    func dayPoints(_ date: LocalDate) async throws -> DayPointsResponse {
        await pause(500)
        let removedRefs = Set(removed.values.flatMap(\.refs))
        let points = buildPoints(date).filter { !removedRefs.contains(PointRef(device: "iPhone", t: $0.t)) }
        return DayPointsResponse(date: date, devices: ["iPhone"], points: points)
    }

    func pointDetail(device: String, t: Int64) async throws -> PointDetailResponse {
        await pause(200)
        let time = Date(timeIntervalSince1970: Double(t) / 1_000_000)
        let date = LocalDate(time, in: Format.zone("Europe/Oslo"))
        let all = buildPoints(date)
        guard let index = all.firstIndex(where: { $0.t == t }) else { throw ServiceError.notFound("This point no longer exists") }
        let p = all[index]
        let zone = zoneOf(p.coordinate)
        let local = DateFormatter()
        local.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
        local.timeZone = Format.zone(zone)
        func neighbour(_ i: Int) -> PointNeighbour? {
            guard all.indices.contains(i) else { return nil }
            let n = all[i]
            let gap = abs(Double(n.t - p.t)) / 1_000_000
            let d = Geo.distance(n.coordinate, p.coordinate)
            return PointNeighbour(t: n.t, gapSeconds: gap, distanceM: d, speedKmh: gap > 0 ? d / gap * 3.6 : 0)
        }
        let status: PointDetailStatus = switch p.status {
        case .used: .used
        case .poorAccuracy: .poorAccuracy
        case .glitch: .glitch
        case .duplicate: .duplicate
        }
        let segment = buildDay(date).segments.first { $0.start <= time && $0.end >= time }
        let pointSegment: PointSegment? = segment.map {
            switch $0 {
            case .stay(let s): PointSegment(kind: "stay", startUtc: s.start, endUtc: s.end, place: s.place.map { .init(id: $0.id, name: $0.name) }, mode: nil)
            case .move(let m): PointSegment(kind: "move", startUtc: m.start, endUtc: m.end, place: nil, mode: m.mode?.rawValue)
            case .gap(let g): PointSegment(kind: "gap", startUtc: g.start, endUtc: g.end, place: nil, mode: nil)
            }
        }
        var rng = SplitMix(seed: UInt64(truncatingIfNeeded: t))
        return PointDetailResponse(
            device: device, t: t, timeUtc: time, localTime: local.string(from: time), zone: zone,
            lat: p.lat, lon: p.lon,
            accuracyM: p.status == .poorAccuracy ? 140 + rng.jitter(40) : 6 + abs(rng.jitter(10)),
            speedMps: segment.flatMap { if case .move = $0 { 1.4 + abs(rng.jitter(3)) } else { 0 } },
            altitudeM: 12 + abs(rng.jitter(30)),
            motion: segment.flatMap { if case .move(let m) = $0 { [Self.isMotorised(m.mode) ? "driving" : "walking"] } else { ["stationary"] } },
            status: status, maxAccuracyM: 100,
            previous: neighbour(index - 1), next: neighbour(index + 1), segment: pointSegment
        )
    }

    func removePoints(_ points: [PointRef]) async throws -> RemovePointsResponse {
        defer { Self.didChange() }
        await pause(400)
        guard !points.isEmpty else { return RemovePointsResponse(batch: nil, count: 0) }
        let batch = UUID().uuidString.lowercased()
        let dates = Set(points.map { LocalDate(Date(timeIntervalSince1970: Double($0.t) / 1_000_000), in: Format.zone("Europe/Oslo")) })
        removed[batch] = (Date(), points, dates.sorted())
        return RemovePointsResponse(batch: batch, count: points.count)
    }

    func removedPoints() async throws -> [RemovedBatch] {
        await pause()
        var batches = removed.map { key, value in
            let times = value.refs.map { Date(timeIntervalSince1970: Double($0.t) / 1_000_000) }
            return RemovedBatch(batch: key, removedAt: value.date, count: value.refs.count,
                                from: times.min() ?? value.date, to: times.max() ?? value.date, localDates: value.dates)
        }
        let oct = LocalDate(year: 2026, month: 10, day: 22)
        batches.append(RemovedBatch(batch: "seed-1", removedAt: oct.adding(days: 2).noonUTC, count: 3,
                                    from: oct.noonUTC, to: oct.noonUTC.addingTimeInterval(240), localDates: [oct]))
        return batches.sorted { $0.removedAt > $1.removedAt }
    }

    func restorePoints(batch: String) async throws {
        defer { Self.didChange() }
        await pause()
        guard removed.removeValue(forKey: batch) != nil else { throw ServiceError.notFound("These points are not removed any more.") }
    }

    // MARK: Moves

    func setMode(_ mode: Mode, ofMove id: Int) async throws -> MoveModeResponse {
        defer { Self.didChange() }
        await pause(300)
        guard hasMove(id) else { throw ServiceError.notFound("This move no longer exists.") }
        modeEdits[id] = mode
        return MoveModeResponse(id: id, mode: mode, modeEdited: true)
    }

    func clearMode(ofMove id: Int) async throws {
        defer { Self.didChange() }
        await pause(300)
        guard hasMove(id) else { throw ServiceError.notFound("This move no longer exists.") }
        modeEdits[id] = nil
    }

    /// Whether a day of the made-up world has a move with this id: a day's ids are its date and the step's number, `yyyyMMddnn`.
    private func hasMove(_ id: Int) -> Bool {
        let d = id / 100, month = d / 100 % 100, day = d % 100
        guard (1...12).contains(month), (1...31).contains(day) else { return false }
        return buildDayDetailed(LocalDate(year: d / 10_000, month: month, day: day)).contains { if case .move(let m) = $0.segment { m.id == id } else { false } }
    }

    // MARK: Places

    func place(_ id: Int) async throws -> PlaceResponse {
        await pause()
        let survivor = resolve(id)
        guard let info = world.places.first(where: { $0.value.id == survivor })?.value else { throw ServiceError.notFound("This place no longer exists") }
        var visits: [PlaceVisit] = []
        var total = 0.0
        var count = 0
        var first = Date.distantFuture
        for offset in 0..<120 {
            let date = LocalDate.today.adding(days: -offset)
            for item in buildDayDetailed(date) {
                guard case .stay(let s) = item.segment, s.place?.id == survivor else { continue }
                let begunToday = LocalDate(s.start, in: Format.zone(s.startTimeZone)) == date
                guard begunToday || offset == 119 else { continue }
                total += s.end.timeIntervalSince(s.start)
                count += 1
                first = min(first, s.start)
                if visits.count < 50 {
                    visits.append(PlaceVisit(start: s.start, end: s.end, date: date, timeZone: s.startTimeZone))
                }
            }
        }
        let mergedHere = mergedInto.filter { $0.value == survivor }.keys.compactMap { other in
            world.places.values.first { $0.id == other }.map { MergedPlace(id: $0.id, name: name(of: $0)) }
        }
        return PlaceResponse(
            id: survivor, name: name(of: info), address: info.address, city: info.city, country: info.country,
            lat: info.lat, lon: info.lon, totalSeconds: total, visits: count,
            firstVisit: first == .distantFuture ? Date() : first, lastVisit: visits.first?.start ?? Date(),
            recentVisits: visits, merged: mergedHere.sorted { ($0.name ?? "~") < ($1.name ?? "~") }
        )
    }

    func searchPlaces(_ query: String) async throws -> [PlaceSearchResult] {
        await pause(200)
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        return world.places.values
            .filter { mergedInto[$0.id] == nil }
            .filter { q.isEmpty || (name(of: $0) ?? "").lowercased().contains(q) || ($0.address ?? "").lowercased().contains(q) }
            .sorted { $0.visits > $1.visits }
            .prefix(20)
            .map { PlaceSearchResult(id: $0.id, name: name(of: $0), address: $0.address, visits: $0.visits) }
    }

    func mergeCandidates(for id: Int, query: String) async throws -> [PlaceCandidate] {
        await pause(200)
        guard let here = world.places.values.first(where: { $0.id == resolve(id) }) else { throw ServiceError.notFound("This place no longer exists") }
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        return world.places.values
            .filter { $0.id != here.id && mergedInto[$0.id] == nil }
            .filter { q.isEmpty || (name(of: $0) ?? "").lowercased().contains(q) || ($0.address ?? "").lowercased().contains(q) }
            .map { PlaceCandidate(id: $0.id, name: name(of: $0), address: $0.address, distanceM: Geo.distance($0.coordinate, here.coordinate), visits: $0.visits) }
            .sorted { $0.distanceM < $1.distanceM }
            .prefix(20)
            .map { $0 }
    }

    func renamePlace(_ id: Int, name: String?) async throws -> PlaceResponse {
        defer { Self.didChange() }
        await pause()
        let survivor = resolve(id)
        let trimmed = name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if trimmed.count > 100 { throw ServiceError.refused("A name is at most 100 characters.") }
        ownNames[survivor] = trimmed.isEmpty ? nil : trimmed
        return try await place(survivor)
    }

    func mergePlace(_ other: Int, into id: Int, name: String??) async throws -> PlaceResponse {
        defer { Self.didChange() }
        await pause(500)
        let survivor = resolve(id), absorbed = resolve(other)
        guard survivor != absorbed else { throw ServiceError.conflict("These are the same place.") }
        mergedInto[absorbed] = survivor
        if case .some(let new) = name {
            let trimmed = new?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            ownNames[survivor] = trimmed.isEmpty ? nil : trimmed
        }
        return try await place(survivor)
    }

    func separatePlace(_ other: Int, from id: Int) async throws {
        defer { Self.didChange() }
        await pause(400)
        guard mergedInto[other] == id else { throw ServiceError.notFound("It is not merged into this place any more.") }
        mergedInto[other] = nil
    }

    // MARK: Trips

    func trips() async throws -> [TripListItem] {
        await pause()
        return world.trips.filter { deleted[$0.id] == nil }.map(applyEdit)
    }

    func trip(_ id: String) async throws -> TripResponse {
        await pause()
        guard deleted[id] == nil, let item = world.trips.first(where: { $0.id == id }).map(applyEdit) else {
            throw ServiceError.notFound("This trip no longer exists")
        }
        var moves: [TripMove] = []
        var days: [TripDay] = []
        var date = item.localStartDate
        while date <= item.localEndDate {
            let built = buildDayDetailed(date)
            var ground = 0.0, flights = 0
            var stays: [(String, TimeInterval)] = []
            for entry in built {
                switch entry.segment {
                case .move(let m):
                    moves.append(TripMove(id: m.id, mode: m.mode, distanceMeters: m.distanceMeters, geometry: m.geometry))
                    if m.mode == .flight { flights += 1 } else { ground += m.distanceMeters }
                case .stay(let s):
                    if let n = s.place?.name { stays.append((n, s.end.timeIntervalSince(s.start))) }
                case .gap:
                    break
                }
            }
            let description = world.tripDayDescriptions[date] ?? "Lisbon"
            let highlights = stays.dropFirst().dropLast().sorted { $0.1 > $1.1 }.prefix(3).map(\.0)
            days.append(TripDay(date: date, description: description, highlights: Array(highlights), groundDistanceMeters: ground, flights: flights))
            date = date.adding(days: 1)
        }
        if moves.isEmpty {
            // Trips with no detailed days in the mock: the flights between home and the cities.
            let home = world.places["home"]!.coordinate
            var previous = home
            for (i, c) in (item.cities.map(\.coordinate) + [home]).enumerated() {
                moves.append(TripMove(id: 90_000 + i, mode: .flight, distanceMeters: Geo.distance(previous, c),
                                      geometry: [LonLat(lon: previous.longitude, lat: previous.latitude), LonLat(lon: c.longitude, lat: c.latitude)]))
                previous = c
            }
        }
        let flights = moves.filter { $0.mode == .flight }.count
        return TripResponse(
            id: item.id, name: item.name, firstNight: item.firstNight, lastNight: item.lastNight, nights: item.nights,
            start: item.start, end: item.end, startTimeZone: item.startTimeZone, endTimeZone: item.endTimeZone,
            localStartDate: item.localStartDate, localEndDate: item.localEndDate, ongoing: item.ongoing, cities: item.cities,
            edited: item.edited, ownName: item.ownName, startEdited: item.startEdited, endEdited: item.endEdited,
            stats: TripStats(flights: flights, cities: item.cities.count, places: days.isEmpty ? item.cities.count : 14,
                             groundDistanceMeters: moves.filter { $0.mode != .flight }.reduce(0) { $0 + $1.distanceMeters }),
            moves: moves, days: days
        )
    }

    func editTrip(_ id: String, _ edit: EditTripRequest) async throws -> EditTripResponse {
        defer { Self.didChange() }
        await pause(400)
        if let name = edit.name, name.count > 100 { throw ServiceError.refused("A name is at most 100 characters.") }
        if let s = edit.startDate, let e = edit.endDate, s >= e { throw ServiceError.refused("The start date must be before the end date.") }
        tripEdits[id] = edit
        return EditTripResponse(id: id)
    }

    func deleteTrip(_ id: String) async throws {
        defer { Self.didChange() }
        await pause(300)
        guard let item = world.trips.first(where: { $0.id == id }) else { throw ServiceError.notFound("This trip no longer exists.") }
        deleted[id] = DeletedTrip(key: id, label: "\(item.name) · \(Format.span(item.localStartDate, item.localEndDate))", deletedAt: Date())
    }

    func deletedTrips() async throws -> [DeletedTrip] {
        await pause()
        return deleted.values.sorted { $0.deletedAt > $1.deletedAt }
    }

    func restoreTrip(key: String) async throws {
        defer { Self.didChange() }
        await pause(300)
        guard deleted.removeValue(forKey: key) != nil else { throw ServiceError.notFound("That trip is not deleted any more.") }
    }

    // MARK: Homes, settings, status

    func homes() async throws -> [HomePeriod] {
        await pause()
        let detected = [
            HomePeriod(id: 1, placeId: 41, placeName: "Thereses gate 12", from: LocalDate(year: 2022, month: 1, day: 3), to: LocalDate(year: 2023, month: 8, day: 13), source: .detected),
            HomePeriod(id: 2, placeId: 1, placeName: name(of: world.places["home"]!), from: LocalDate(year: 2023, month: 8, day: 14), to: nil, source: .detected),
        ]
        return (detected + userHomes).sorted { $0.from < $1.from }
    }

    func addHome(_ request: AddHomeRequest) async throws -> HomePeriod {
        defer { Self.didChange() }
        await pause(400)
        let place = world.places.values.first { $0.id == resolve(request.placeId) }
        let period = HomePeriod(id: 100 + userHomes.count, placeId: request.placeId, placeName: place.flatMap(name(of:)), from: request.from, to: request.to, source: .user)
        userHomes.append(period)
        return period
    }

    func removeHome(_ id: Int) async throws {
        defer { Self.didChange() }
        await pause(300)
        guard let index = userHomes.firstIndex(where: { $0.id == id }) else { throw ServiceError.notFound("That home is not there any more.") }
        userHomes.remove(at: index)
    }

    func settings() async throws -> SettingsResponse {
        await pause()
        return SettingsResponse(tripMinDistanceKm: tripDistance ?? 50, tripMinDistanceKmDefault: 50)
    }

    func setTripDistance(_ km: Double?) async throws -> SettingsResponse {
        defer { Self.didChange() }
        await pause(300)
        if let km, !(5...1000).contains(km) { throw ServiceError.refused("Enter a distance from 5 to 1000 km.") }
        tripDistance = km
        return SettingsResponse(tripMinDistanceKm: km ?? 50, tripMinDistanceKmDefault: 50)
    }

    func status() async throws -> StatusResponse {
        await pause()
        let failed = failedRetried ? [] : [
            FailedRange(from: LocalDate(year: 2024, month: 3, day: 2).noonUTC, to: LocalDate(year: 2024, month: 3, day: 9).noonUTC,
                        attempts: 3, lastError: "Npgsql.NpgsqlException: Exception while reading from stream (timeout)"),
        ]
        return StatusResponse(
            algorithmVersion: "2026.11.3", backfill: BackfillStatus(from: nil, to: nil, cursor: nil, percent: 100, paused: false),
            pendingRanges: failed.count, failedRanges: failed, lastRunAt: Date().addingTimeInterval(-42), lastError: nil,
            places: PlaceStatus(total: 1_284, unnamed: 3, failed: 0), warnings: []
        )
    }

    func retryFailed() async throws -> RetryFailedResponse {
        defer { Self.didChange() }
        await pause(300)
        let n = failedRetried ? 0 : 1
        failedRetried = true
        return RetryFailedResponse(retried: n)
    }

    // MARK: Building days

    private func resolve(_ id: Int) -> Int {
        var current = id
        var hops = 0
        while let next = mergedInto[current], hops < 32 { current = next; hops += 1 }
        return current
    }

    private func name(of place: MockWorld.Place) -> String? {
        ownNames[place.id] ?? place.name
    }

    private func applyEdit(_ trip: TripListItem) -> TripListItem {
        guard let edit = tripEdits[trip.id] else { return trip }
        var t = trip
        if let n = edit.name { t.name = n; t.ownName = n }
        if let s = edit.startDate { t.localStartDate = s; t.startEdited = true }
        if let e = edit.endDate { t.localEndDate = e; t.endEdited = true }
        t.edited = true
        return t
    }

    private func zoneOf(_ c: CLLocationCoordinate2D) -> String {
        c.longitude < -5 ? "Europe/Lisbon" : "Europe/Oslo"
    }

    private func buildDay(_ date: LocalDate) -> DayResponse {
        let segments = buildDayDetailed(date).map(\.segment)
        var places = Set<Int>()
        var distance = 0.0, moving = 0.0
        for s in segments {
            switch s {
            case .stay(let stay): if let p = stay.place { places.insert(p.id) }
            case .move(let m): distance += m.distanceMeters; moving += m.end.timeIntervalSince(m.start)
            case .gap: break
            }
        }
        let zone = segments.last.map { seg -> String in
            if case .stay(let s) = seg { return s.endTimeZone }
            return "Europe/Oslo"
        } ?? "Europe/Oslo"
        return DayResponse(date: date, timeZone: zone, state: date == .today ? .pending : .done,
                           summary: DaySummary(places: places.count, distanceMeters: distance, movingSeconds: moving),
                           segments: segments)
    }

    struct Built {
        var segment: DaySegment
        var routeKey: String?
    }

    private func buildDayDetailed(_ date: LocalDate) -> [Built] {
        guard date <= .today, date >= LocalDate(year: 2022, month: 1, day: 3) else { return [] }
        let plan = world.plan(for: date)
        var out: [Built] = []
        var cursor: Date? = nil
        var id = (date.year * 10_000 + date.month * 100 + date.day) * 100
        let now = Date()

        func at(_ hhmm: String, _ zone: String) -> Date {
            let parts = hhmm.split(separator: ":").compactMap { Int($0) }
            return date.start(in: Format.zone(zone)).addingTimeInterval(Double(parts[0] * 3600 + parts[1] * 60))
        }

        for (index, step) in plan.enumerated() {
            id += 1
            switch step {
            case .stay(let key, let until, let zone):
                let info = world.places[key]!
                let start = cursor ?? date.start(in: Format.zone(zone)).addingTimeInterval(-(2 * 3600 + 20 * 60))
                var end = until.map { at($0, zone) } ?? date.adding(days: 1).start(in: Format.zone(zone)).addingTimeInterval(7 * 3600)
                if index == plan.count - 1, date == .today { end = max(end, now) }
                let survivor = world.places.values.first { $0.id == resolve(info.id) } ?? info
                let ref = PlaceRef(id: survivor.id, name: name(of: survivor), city: survivor.city, country: survivor.country, lat: info.lat, lon: info.lon)
                out.append(Built(segment: .stay(.init(id: id, start: start, end: end, startTimeZone: zone, endTimeZone: zone, place: ref, home: survivor.id == 1)), routeKey: nil))
                cursor = end
            case .move(let key, let mode, let zone, let endZone):
                let geometry = world.route(key)
                let distance = Geo.length(geometry)
                let start = cursor!
                // The owner's mode changes what the move is called, not when it happened.
                let end = start.addingTimeInterval(Self.travelTime(distance, mode))
                out.append(Built(segment: .move(.init(id: id, start: start, end: end, startTimeZone: zone, endTimeZone: endZone ?? zone, mode: modeEdits[id] ?? mode,
                                                      distanceMeters: distance, geometry: geometry, modeEdited: modeEdits[id] != nil)), routeKey: key))
                cursor = end
            case .gap(let until, let zone, let toKey):
                let start = cursor!
                let end = at(until, zone)
                let fromCoord: LatLon? = out.last.flatMap {
                    if case .stay(let s) = $0.segment, let p = s.place { return LatLon(lat: p.lat, lon: p.lon) }
                    return nil
                }
                let to = world.places[toKey]!
                out.append(Built(segment: .gap(.init(id: id, start: start, end: end, startTimeZone: zone, endTimeZone: zone, from: fromCoord, to: LatLon(lat: to.lat, lon: to.lon))), routeKey: nil))
                cursor = end
            }
        }
        guard date == .today else { return out }
        // Today stops at now: what has not happened yet is not there, and the last stay goes on.
        var cut: [Built] = []
        for var item in out {
            guard item.segment.start < now else { break }
            if item.segment.end > now, case .stay(var s) = item.segment {
                s.end = now
                item.segment = .stay(s)
            }
            cut.append(item)
        }
        if let last = cut.last, case .move(let m) = last.segment, m.end > now {
            cut.removeLast()
            let info = world.places.values.first { $0.id == 1 }!
            let ref = PlaceRef(id: 1, name: name(of: info), city: info.city, country: info.country, lat: info.lat, lon: info.lon)
            cut.append(Built(segment: .stay(.init(id: m.id, start: m.start, end: now, startTimeZone: m.startTimeZone, endTimeZone: m.startTimeZone, place: ref, home: true)), routeKey: nil))
        }
        return cut
    }

    private nonisolated static func travelTime(_ meters: Double, _ mode: Mode) -> TimeInterval {
        let kmh: Double = switch mode {
        case .walk: 4.6
        case .cycle: 15
        case .drive: meters > 20_000 ? 85 : 32
        case .bus: meters > 20_000 ? 70 : 20
        case .train: meters > 20_000 ? 100 : 35
        case .flight: 690
        }
        let base = meters / 1000 / kmh * 3600
        return mode == .flight ? base + 1800 : base
    }

    private nonisolated static func isMotorised(_ mode: Mode?) -> Bool {
        switch mode {
        case .drive, .bus, .train: true
        default: false
        }
    }

    private func buildPoints(_ date: LocalDate) -> [RawPoint] {
        var rng = SplitMix(seed: UInt64(date.year * 400 + date.month * 32 + date.day))
        var points: [RawPoint] = []
        func micros(_ d: Date) -> Int64 { Int64((d.timeIntervalSince1970 * 1_000_000).rounded()) }
        let dayStart = date.start(in: Format.zone("Europe/Oslo"))
        let dayEnd = date.adding(days: 1).start(in: Format.zone("Europe/Oslo"))
        for item in buildDayDetailed(date) {
            switch item.segment {
            case .stay(let s):
                guard let p = s.place else { continue }
                var t = max(s.start, dayStart)
                let end = min(s.end, dayEnd)
                while t < end {
                    let poor = rng.next() % 23 == 0
                    let spread = poor ? 0.0025 : 0.00018
                    points.append(RawPoint(t: micros(t), lon: p.lon + rng.jitter(spread * 1.8), lat: p.lat + rng.jitter(spread), device: 0, status: poor ? .poorAccuracy : .used))
                    t = t.addingTimeInterval(240 + Double(rng.next() % 240))
                }
            case .move(let m):
                guard m.mode != .flight, m.geometry.count > 1 else { continue }
                let duration = m.end.timeIntervalSince(m.start)
                for (i, p) in m.geometry.enumerated() {
                    let t = m.start.addingTimeInterval(duration * Double(i) / Double(m.geometry.count - 1))
                    points.append(RawPoint(t: micros(t), lon: p.lon + rng.jitter(0.00005), lat: p.lat + rng.jitter(0.00003), device: 0, status: .used))
                }
            case .gap:
                break
            }
        }
        points.sort { $0.t < $1.t }
        // Two out-and-back spikes and a repeat, so that edit mode has something to remove.
        for k in [points.count / 3, (points.count * 2) / 3] where points.indices.contains(k) {
            points[k].lat += 0.006
            points[k].lon -= 0.009
            points[k].status = .glitch
        }
        if points.count > 10 {
            var dup = points[10]
            dup.status = .duplicate
            points.insert(dup, at: 11)
        }
        return points
    }
}

// MARK: - The made-up world

nonisolated struct MockWorld: Sendable {
    struct Place: Sendable {
        var id: Int
        var name: String?
        var address: String?
        var city: String?
        var country: String?
        var lat: Double
        var lon: Double
        var visits: Int
        var coordinate: CLLocationCoordinate2D { .init(latitude: lat, longitude: lon) }
    }

    enum Step: Sendable {
        case stay(String, until: String?, zone: String = "Europe/Oslo")
        case move(String, Mode, zone: String = "Europe/Oslo", endZone: String? = nil)
        case gap(until: String, zone: String = "Europe/Oslo", to: String)
    }

    var places: [String: Place]
    var routes: [String: [LonLat]]
    var trips: [TripListItem]
    var tripDayDescriptions: [LocalDate: String]

    func route(_ key: String) -> [LonLat] {
        if key.hasSuffix("~r") { return (routes[String(key.dropLast(2))] ?? []).reversed() }
        if key.hasPrefix("air:") {
            let ends = key.dropFirst(4).split(separator: ">").map(String.init)
            return ends.compactMap { places[$0] }.map { LonLat(lon: $0.lon, lat: $0.lat) }
        }
        return routes[key] ?? []
    }

    func plan(for date: LocalDate) -> [Step] {
        let lis = "Europe/Lisbon"
        let trip = LocalDate(year: 2026, month: 9, day: 12)...LocalDate(year: 2026, month: 9, day: 19)
        if trip.contains(date) {
            switch date.day {
            case 12:
                return [.stay("home", until: "06:05"), .move("home-osl", .drive), .stay("osl", until: "07:40"),
                        .move("air:osl>lis-airport", .flight, endZone: lis), .stay("lis-airport", until: "11:15", zone: lis),
                        .move("lisair-hotel", .drive, zone: lis), .stay("lis-hotel", until: "13:10", zone: lis),
                        .move("hotel-alfama", .walk, zone: lis), .stay("lis-alfama", until: "18:30", zone: lis),
                        .move("hotel-alfama~r", .walk, zone: lis), .stay("lis-hotel", until: nil, zone: lis)]
            case 13, 14:
                return [.stay("lis-hotel", until: "09:50", zone: lis), .move("hotel-alfama", .walk, zone: lis),
                        .stay("lis-alfama", until: "11:00", zone: lis), .move("alfama-belem", .drive, zone: lis),
                        .stay("lis-belem", until: "13:20", zone: lis), .move("belem-lxfactory", .walk, zone: lis),
                        .stay("lis-lxfactory", until: "16:40", zone: lis), .move("lxfactory-hotel", .drive, zone: lis),
                        .stay("lis-hotel", until: nil, zone: lis)]
            case 15:
                return [.stay("lis-hotel", until: "08:20", zone: lis), .move("hotel-station", .walk, zone: lis),
                        .stay("lis-station", until: "09:09", zone: lis), .move("lis-opo", .train, zone: lis),
                        .stay("opo-station", until: "13:00", zone: lis), .move("opostation-hotel", .drive, zone: lis),
                        .stay("opo-hotel", until: "15:30", zone: lis), .move("hotel-ribeira", .walk, zone: lis),
                        .stay("opo-ribeira", until: "20:10", zone: lis), .move("hotel-ribeira~r", .walk, zone: lis),
                        .stay("opo-hotel", until: nil, zone: lis)]
            case 19:
                return [.stay("opo-hotel", until: "07:45", zone: lis), .move("hotel-opoair", .drive, zone: lis),
                        .stay("opo-airport", until: "09:55", zone: lis), .move("air:opo-airport>osl", .flight, zone: lis, endZone: "Europe/Oslo"),
                        .stay("osl", until: "15:20"), .move("osl-home", .drive), .stay("home", until: nil)]
            default:
                return [.stay("opo-hotel", until: "10:05", zone: lis), .move("hotel-ribeira", .walk, zone: lis),
                        .stay("opo-ribeira", until: "11:20", zone: lis), .move("ribeira-lello", .walk, zone: lis),
                        .stay("opo-lello", until: "12:30", zone: lis), .move("lello-serralves", .drive, zone: lis),
                        .stay("opo-serralves", until: "16:15", zone: lis), .move("serralves-hotel", .drive, zone: lis),
                        .stay("opo-hotel", until: nil, zone: lis)]
            }
        }
        let weekday = LocalDate.calendar().component(.weekday, from: date.noonUTC) // 1 = Sunday
        switch weekday {
        case 7:
            return [.stay("home", until: "09:40"), .move("home-sognsvann", .drive), .stay("sognsvann", until: "10:25"),
                    .move("sognsvann-loop", .walk), .stay("frogner", until: "13:40"), .move("frogner-home", .bus),
                    .stay("home", until: nil)]
        case 1:
            return [.stay("home", until: "10:20"), .move("home-cafe", .walk), .stay("cafe", until: "11:35"),
                    .move("home-cafe~r", .walk), .stay("home", until: nil)]
        default:
            return [.stay("home", until: "07:55"), .move("home-cafe", .walk), .stay("cafe", until: "08:25"),
                    .move("cafe-work", .cycle), .stay("work", until: "11:55"), .move("work-lunch", .walk),
                    .stay("lunch", until: "12:40"), .move("lunch-work", .walk), .stay("work", until: "16:50"),
                    .move("work-gym", .cycle), .stay("gym", until: "18:15"), .move("gym-market", .walk),
                    .stay("market", until: "20:05"), .gap(until: "21:40", to: "home"), .stay("home", until: nil)]
        }
    }

    static func load() -> MockWorld {
        struct File: Decodable {
            var routes: [String: [LonLat]]
            var places: [String: LonLat]
        }
        let file: File = {
            guard let url = Bundle.main.url(forResource: "MockRoutes", withExtension: "json"),
                  let data = try? Data(contentsOf: url),
                  let decoded = try? JSONDecoder().decode(File.self, from: data)
            else { return File(routes: [:], places: [:]) }
            return decoded
        }()

        let meta: [(String, Int, String?, String?, String?, String?, Int)] = [
            ("home", 1, "Home", "Olaf Ryes plass 4", "Oslo", "Norway", 812),
            ("cafe", 2, "Tim Wendelboe", "Grüners gate 1", "Oslo", "Norway", 214),
            ("work", 3, "Barcode", "Dronning Eufemias gate 16", "Oslo", "Norway", 486),
            ("lunch", 4, "Operahuset", "Kirsten Flagstads plass 1", "Oslo", "Norway", 97),
            ("gym", 5, "SATS Torggata", "Torggata 16", "Oslo", "Norway", 152),
            ("market", 6, "Mathallen Oslo", "Vulkan 5", "Oslo", "Norway", 88),
            ("sognsvann", 7, "Sognsvann", nil, "Oslo", "Norway", 34),
            ("frogner", 8, "Frognerparken", "Kirkeveien", "Oslo", "Norway", 41),
            ("osl", 9, "Oslo Airport", "Edvard Munchs veg", "Gardermoen", "Norway", 18),
            ("lis-airport", 20, "Humberto Delgado Airport", "Alameda das Comunidades Portuguesas", "Lisbon", "Portugal", 2),
            ("lis-hotel", 21, nil, "Rua da Prata 112", "Lisbon", "Portugal", 4),
            ("lis-alfama", 22, "Miradouro de Santa Luzia", "Largo Santa Luzia", "Lisbon", "Portugal", 3),
            ("lis-belem", 23, "Torre de Belém", "Avenida Brasília", "Lisbon", "Portugal", 2),
            ("lis-lxfactory", 24, "LX Factory", "Rua Rodrigues de Faria 103", "Lisbon", "Portugal", 2),
            ("lis-station", 25, "Santa Apolónia", "Avenida Infante Dom Henrique", "Lisbon", "Portugal", 1),
            ("opo-station", 30, "Campanhã", "Largo da Estação", "Porto", "Portugal", 1),
            ("opo-hotel", 31, "Torel Avantgarde", "Rua da Restauração 336", "Porto", "Portugal", 4),
            ("opo-ribeira", 32, "Cais da Ribeira", nil, "Porto", "Portugal", 3),
            ("opo-lello", 33, "Livraria Lello", "Rua das Carmelitas 144", "Porto", "Portugal", 2),
            ("opo-serralves", 34, "Serralves", "Rua Dom João de Castro 210", "Porto", "Portugal", 2),
            ("opo-airport", 35, "Francisco Sá Carneiro Airport", nil, "Porto", "Portugal", 1),
        ]
        var places: [String: Place] = [:]
        for (key, id, name, address, city, country, visits) in meta {
            let p = file.places[key] ?? LonLat(lon: 10.75, lat: 59.92)
            places[key] = Place(id: id, name: name, address: address, city: city, country: country, lat: p.lat, lon: p.lon, visits: visits)
        }
        places["old-home"] = Place(id: 41, name: nil, address: "Thereses gate 12", city: "Oslo", country: "Norway", lat: 59.9275, lon: 10.7349, visits: 402)
        places["home-north"] = Place(id: 42, name: nil, address: "Olaf Ryes plass 6", city: "Oslo", country: "Norway", lat: 59.92301, lon: 10.75822, visits: 37)

        let oslo = places["home"]!
        func line(_ coords: [(Double, Double)]) -> [LonLat] { coords.map { LonLat(lon: $0.1, lat: $0.0) } }
        let homeLL = (oslo.lat, oslo.lon)
        func trip(_ id: String, _ name: String, first: LocalDate, nights: Int, cities: [TripCity], zone: String = "Europe/Oslo", far: String = "Europe/Oslo") -> TripListItem {
            let last = first.adding(days: nights - 1)
            return TripListItem(
                id: id, name: name, firstNight: first, lastNight: last, nights: nights,
                start: first.start(in: Format.zone(zone)).addingTimeInterval(6 * 3600),
                end: last.adding(days: 1).start(in: Format.zone(zone)).addingTimeInterval(16 * 3600),
                startTimeZone: zone, endTimeZone: zone, localStartDate: first, localEndDate: last.adding(days: 1),
                ongoing: false, cities: cities, edited: false, ownName: nil, startEdited: false, endEdited: false,
                thumbnail: line([homeLL] + cities.map { ($0.lat, $0.lon) } + [homeLL])
            )
        }
        let trips = [
            trip("2026-09-12", "Lisbon & Porto", first: LocalDate(year: 2026, month: 9, day: 12), nights: 7, cities: [
                TripCity(name: "Lisbon", country: "Portugal", nights: 3, lat: 38.7106, lon: -9.1366),
                TripCity(name: "Porto", country: "Portugal", nights: 4, lat: 41.1460, lon: -8.6110),
            ]),
            trip("2026-06-05", "Bergen", first: LocalDate(year: 2026, month: 6, day: 5), nights: 2, cities: [
                TripCity(name: "Bergen", country: "Norway", nights: 2, lat: 60.3913, lon: 5.3221),
            ]),
            trip("2026-04-17", "Copenhagen", first: LocalDate(year: 2026, month: 4, day: 17), nights: 3, cities: [
                TripCity(name: "Copenhagen", country: "Denmark", nights: 3, lat: 55.6761, lon: 12.5683),
            ]),
            trip("2025-12-20", "Buenos Aires", first: LocalDate(year: 2025, month: 12, day: 20), nights: 16, cities: [
                TripCity(name: "Buenos Aires", country: "Argentina", nights: 16, lat: -34.6037, lon: -58.3816),
            ]),
            trip("2025-10-03", "Japan", first: LocalDate(year: 2025, month: 10, day: 3), nights: 11, cities: [
                TripCity(name: "Tokyo", country: "Japan", nights: 6, lat: 35.6762, lon: 139.6503),
                TripCity(name: "Kyoto", country: "Japan", nights: 4, lat: 35.0116, lon: 135.7681),
                TripCity(name: "Osaka", country: "Japan", nights: 1, lat: 34.6937, lon: 135.5023),
            ]),
            trip("2025-05-29", "Stockholm", first: LocalDate(year: 2025, month: 5, day: 29), nights: 2, cities: [
                TripCity(name: "Stockholm", country: "Sweden", nights: 2, lat: 59.3293, lon: 18.0686),
            ]),
        ]
        let descriptions: [LocalDate: String] = [
            LocalDate(year: 2026, month: 9, day: 12): "Oslo → Lisbon",
            LocalDate(year: 2026, month: 9, day: 13): "Lisbon",
            LocalDate(year: 2026, month: 9, day: 14): "Lisbon",
            LocalDate(year: 2026, month: 9, day: 15): "Lisbon → Porto",
            LocalDate(year: 2026, month: 9, day: 16): "Porto",
            LocalDate(year: 2026, month: 9, day: 17): "Porto",
            LocalDate(year: 2026, month: 9, day: 18): "Porto",
            LocalDate(year: 2026, month: 9, day: 19): "Porto → Oslo",
        ]
        return MockWorld(places: places, routes: file.routes, trips: trips, tripDayDescriptions: descriptions)
    }
}

/// A small seeded generator, so the made-up points are the same every time.
nonisolated struct SplitMix: RandomNumberGenerator {
    private var state: UInt64
    init(seed: UInt64) { state = seed &+ 0x9E37_79B9_7F4A_7C15 }
    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
    mutating func jitter(_ amount: Double) -> Double {
        (Double(next() % 10_000) / 10_000 - 0.5) * 2 * amount
    }
}
