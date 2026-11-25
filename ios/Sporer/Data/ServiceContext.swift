import Foundation
import Synchronization

/// What a load asks of the service besides its answer, carried by the task that loads (task-locals), so that the service's
/// methods stay one per endpoint.
nonisolated enum ServiceContext {
    enum Mode: Sendable {
        /// Ask the server. When it can't be reached and a `note` is listening, a saved answer is given instead, and noted.
        case network
        /// Give the saved answer at once, or throw `ServiceError.notCached`: never asks the server.
        case cacheOnly
    }

    @TaskLocal static var mode: Mode = .network
    @TaskLocal static var note: CacheNote?
}

/// Listens to a load for the saved answers it was given in place of the server's: `savedAt` is when the oldest of them was saved,
/// nil when every answer was the server's.
nonisolated final class CacheNote: Sendable {
    private let oldest = Mutex<Date?>(nil)

    init() {}

    func served(savedAt: Date) {
        oldest.withLock { $0 = min($0 ?? savedAt, savedAt) }
    }

    var savedAt: Date? { oldest.withLock { $0 } }
}
