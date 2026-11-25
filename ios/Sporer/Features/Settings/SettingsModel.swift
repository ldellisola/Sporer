import SwiftUI


/// The writes of Settings; each names its failure wording.
enum SettingsAction {
    case removeHome, setHome, setTripDistance, restoreTrip, restorePoints, retryFailed

    var title: String {
        switch self {
        case .removeHome: "Couldn't Remove Home"
        case .setHome: "Couldn't Set Home"
        case .setTripDistance: "Couldn't Save Trip Distance"
        case .restoreTrip: "Couldn't Restore Trip"
        case .restorePoints: "Couldn't Restore Points"
        case .retryFailed: "Couldn't Retry"
        }
    }

    /// What the web app says when the server answers 404.
    var goneMessage: String {
        switch self {
        case .removeHome: "That home is not there any more."
        case .setHome: "That place no longer exists."
        case .setTripDistance: "The settings no longer exist."
        case .restoreTrip: "That trip is not deleted any more."
        case .restorePoints: "These points are not removed any more."
        case .retryFailed: "Nothing is waiting to be retried."
        }
    }
}

/// An error that stopped a write, shown as an alert; Retry only when asking again can help.
struct SettingsFailure: Identifiable {
    let id = UUID()
    var title: String
    var message: String
    var isGone = false
    var retry: (@MainActor () -> Void)?

    init(_ action: SettingsAction, _ error: any Error, retry: (@MainActor () -> Void)? = nil) {
        title = action.title
        if case ServiceError.notFound = error {
            message = action.goneMessage
            isGone = true
        } else {
            message = error.localizedDescription
        }
        if (error as? ServiceError)?.isRetryable == true { self.retry = retry }
    }
}

/// What Settings holds: each part loads and fails on its own, keeps its last value while it reloads,
/// and the status is fetched once for Server and Processing (and again every 30 s while Settings is open).
@Observable
final class SettingsModel {
    struct Loaded<T> {
        var value: T?
        var error: (any Error)?
        var isLoading = false
    }

    private var app: AppModel?
    var status = Loaded<StatusResponse>()
    var homes = Loaded<[HomePeriod]>()
    var settings = Loaded<SettingsResponse>()
    var deleted = Loaded<[DeletedTrip]>()
    var removed = Loaded<[RemovedBatch]>()

    var failure: SettingsFailure?
    var removingHomes: Set<Int> = []
    var restoring: Set<String> = []
    var isRetrying = false
    var pendingRemoval: HomePeriod?

    /// The trip distance field's draft; unsaved while it differs from the server's value.
    var tripText = ""
    private var tripSynced = false

    var service: any SporerService { app?.service ?? MockService.shared }

    func bind(_ app: AppModel) { self.app = app }

    // MARK: Loading

    func loadAll() async {
        async let a: Void = loadStatus()
        async let b: Void = loadHomes()
        async let c: Void = loadSettings()
        async let d: Void = loadDeleted()
        async let e: Void = loadRemoved()
        _ = await (a, b, c, d, e)
    }

    func loadStatus() async { await load(\.status, "server") { try await self.service.status() } }
    func loadHomes() async { await load(\.homes, "home") { try await self.service.homes().sorted { $0.from < $1.from } } }
    func loadDeleted() async { await load(\.deleted, "deleted") { try await self.service.deletedTrips() } }
    func loadRemoved() async { await load(\.removed, "removed") { try await self.service.removedPoints() } }
    func loadSettings() async {
        await load(\.settings, "trips") { try await self.service.settings() }
        if let value = settings.value, !tripIsChanged || !tripSynced {
            tripText = TripDistance.plain(value.tripMinDistanceKm)
            tripSynced = true
        }
    }

    private func load<T>(_ key: ReferenceWritableKeyPath<SettingsModel, Loaded<T>>, _ name: String, _ fetch: () async throws -> T) async {
        self[keyPath: key].isLoading = true
        defer { self[keyPath: key].isLoading = false }
        do {
            if SettingsDebug.fails(name) { try await Task.sleep(for: .milliseconds(300)); throw ServiceError.offline }
            let value = try await fetch()
            guard !Task.isCancelled else { return }
            self[keyPath: key].value = value
            self[keyPath: key].error = nil
        } catch is CancellationError {
        } catch {
            guard !Task.isCancelled else { return }
            self[keyPath: key].error = error
        }
    }

    /// Nothing loaded and the status can't be had either: the server is out of reach, so one banner says it.
    var isUnreachable: Bool {
        status.value == nil && status.error != nil && homes.value == nil && settings.value == nil
    }

    private func fail(_ action: SettingsAction, _ error: any Error, retry: (@MainActor () -> Void)?, reload: () async -> Void) async {
        let f = SettingsFailure(action, error, retry: retry)
        failure = f
        if f.isGone { await reload() } // the service has told the other screens
    }

    // MARK: Trip distance

    var tripValue: Double? {
        guard let parsed = TripDistance.parse(tripText), TripDistance.range.contains(parsed) else { return nil }
        return parsed
    }
    var tripIsInvalid: Bool { tripValue == nil }
    var tripIsChanged: Bool {
        guard let saved = settings.value?.tripMinDistanceKm else { return false }
        guard let v = tripValue else { return true }
        return abs(v - saved) > 0.0001
    }
    var tripIsDefault: Bool { settings.value.map { $0.tripMinDistanceKm == $0.tripMinDistanceKmDefault } ?? true }

    /// `nil` goes back to the default.
    func saveTrip(_ km: Double?) async {
        do {
            let result = try await service.setTripDistance(km)
            settings.value = result
            settings.error = nil
            tripText = TripDistance.plain(result.tripMinDistanceKm)
            let message = km == nil
                ? "Trip distance back to the default, \(Format.km(result.tripMinDistanceKmDefault))"
                : "Trip distance set to \(Format.km(result.tripMinDistanceKm))"
            app?.toasts.show(Toast(message: message, symbol: "suitcase.fill"))
        } catch {
            await fail(.setTripDistance, error, retry: { Task { await self.saveTrip(km) } }, reload: loadSettings)
        }
    }

    // MARK: Homes

    func homeAdded(_ name: String) async {
        app?.toasts.show(Toast(message: "Home set to \(name)", symbol: "house.fill"))
        await loadHomes()
    }

    func removeHome(_ period: HomePeriod) async {
        removingHomes.insert(period.id)
        defer { removingHomes.remove(period.id) }
        do {
            try await service.removeHome(period.id)
            app?.toasts.show(Toast(message: "Removed the home at \(Format.placeName(period.placeName))", symbol: "trash.circle.fill"))
            await loadHomes()
        } catch {
            await fail(.removeHome, error, retry: { Task { await self.removeHome(period) } }, reload: loadHomes)
        }
    }

    // MARK: Restoring

    func restore(_ trip: DeletedTrip) async {
        guard !restoring.contains(trip.key) else { return }
        restoring.insert(trip.key)
        defer { restoring.remove(trip.key) }
        do {
            try await service.restoreTrip(key: trip.key)
            app?.toasts.show(Toast(message: "Restored \(trip.label)", symbol: "arrow.uturn.backward.circle.fill"))
            await loadDeleted()
        } catch {
            await fail(.restoreTrip, error, retry: { Task { await self.restore(trip) } }, reload: loadDeleted)
        }
    }

    func restore(_ batch: RemovedBatch) async {
        guard !restoring.contains(batch.batch) else { return }
        restoring.insert(batch.batch)
        defer { restoring.remove(batch.batch) }
        do {
            try await service.restorePoints(batch: batch.batch)
            app?.toasts.show(Toast(message: "Restored \(Format.count(batch.count, "point"))", symbol: "arrow.uturn.backward.circle.fill"))
            for date in batch.localDates { app?.noteDayEdited(date) }
            await loadRemoved()
        } catch {
            await fail(.restorePoints, error, retry: { Task { await self.restore(batch) } }, reload: loadRemoved)
        }
    }

    // MARK: Processing

    func retryFailed() async {
        isRetrying = true
        defer { isRetrying = false }
        do {
            let result = try await service.retryFailed()
            let message = result.retried > 0 ? "Retrying \(Format.count(result.retried, "period"))" : "Nothing was waiting to be retried"
            app?.toasts.show(Toast(message: message, symbol: result.retried > 0 ? "arrow.clockwise.circle.fill" : "checkmark.circle.fill"))
            await loadStatus()
        } catch {
            await fail(.retryFailed, error, retry: { Task { await self.retryFailed() } }, reload: loadStatus)
        }
    }
}

/// The trip distance field's text and its rules.
enum TripDistance {
    static let range = 5.0...1000.0

    /// "50", "7.5", "1000": no grouping, so what the field shows parses back.
    static func plain(_ value: Double) -> String {
        value == value.rounded() ? String(format: "%.0f", value) : String(format: "%g", value)
    }

    /// A comma is a decimal separator only when there is no point and exactly one comma.
    static func parse(_ text: String) -> Double? {
        var s = text.filter { !$0.isWhitespace }
        let commas = s.filter { $0 == "," }.count
        if !s.contains("."), commas == 1 {
            s = s.replacingOccurrences(of: ",", with: ".")
        } else {
            s = s.replacingOccurrences(of: ",", with: "")
        }
        return Double(s)
    }
}
