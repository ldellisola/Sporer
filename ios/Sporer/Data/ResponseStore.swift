import CryptoKit
import Foundation

/// The last answer of every read, kept on disk, so that a screen opens at once on what it showed last time and still has
/// something to show when the server can't be reached. Keyed by the full URL, so two servers never mix. It is a cache: it lives in
/// Caches (the system may empty it), and past `limit` bytes the answers saved longest ago are dropped.
nonisolated final class ResponseStore: Sendable {
    struct Entry: Sendable {
        var body: Data
        var etag: String?
        /// When the server last said this was its answer (a 200, or a 304 for it).
        var savedAt: Date
    }

    static let shared = ResponseStore(
        directory: URL.cachesDirectory.appending(path: "Responses", directoryHint: .isDirectory)
    )

    let directory: URL
    let limit: Int

    init(directory: URL, limit: Int = 96 * 1024 * 1024) {
        self.directory = directory
        self.limit = limit
    }

    func read(_ key: String) -> Entry? {
        let body = bodyURL(key)
        guard let data = try? Data(contentsOf: body),
              let savedAt = (try? body.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate
        else { return nil }
        let etag = (try? String(contentsOf: etagURL(key), encoding: .utf8)).flatMap { $0.isEmpty ? nil : $0 }
        return Entry(body: data, etag: etag, savedAt: savedAt)
    }

    func write(_ key: String, body: Data, etag: String?) {
        let fm = FileManager.default
        try? fm.createDirectory(at: directory, withIntermediateDirectories: true)
        do {
            try (etag ?? "").write(to: etagURL(key), atomically: true, encoding: .utf8)
            try body.write(to: bodyURL(key), options: .atomic)
        } catch {
            remove(key)
            return
        }
        trimIfNeeded()
    }

    /// The server answered 304: what is saved is its answer as of now.
    func touch(_ key: String) {
        try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: bodyURL(key).path)
    }

    func remove(_ key: String) {
        try? FileManager.default.removeItem(at: bodyURL(key))
        try? FileManager.default.removeItem(at: etagURL(key))
    }

    func removeAll() {
        try? FileManager.default.removeItem(at: directory)
    }

    // MARK: Files

    private func name(_ key: String) -> String {
        SHA256.hash(data: Data(key.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private func bodyURL(_ key: String) -> URL { directory.appending(path: name(key) + ".json") }
    private func etagURL(_ key: String) -> URL { directory.appending(path: name(key) + ".etag") }

    /// Drops the bodies saved longest ago until the store is back under three quarters of its limit.
    private func trimIfNeeded() {
        let keys: Set<URLResourceKey> = [.fileSizeKey, .contentModificationDateKey]
        guard let files = try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: Array(keys)) else { return }
        let bodies = files.filter { $0.pathExtension == "json" }.compactMap { url -> (URL, Int, Date)? in
            guard let values = try? url.resourceValues(forKeys: keys) else { return nil }
            return (url, values.fileSize ?? 0, values.contentModificationDate ?? .distantPast)
        }
        var total = bodies.reduce(0) { $0 + $1.1 }
        guard total > limit else { return }
        for (url, size, _) in bodies.sorted(by: { $0.2 < $1.2 }) {
            try? FileManager.default.removeItem(at: url)
            try? FileManager.default.removeItem(at: url.deletingPathExtension().appendingPathExtension("etag"))
            total -= size
            if total <= limit * 3 / 4 { break }
        }
    }
}
