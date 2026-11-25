import Foundation
import Testing
@testable import Sporer

@Suite("ResponseStore")
struct ResponseStoreTests {
    private func makeStore(limit: Int = 96 * 1024 * 1024) -> ResponseStore {
        ResponseStore(directory: FileManager.default.temporaryDirectory.appending(path: "SporerTests-\(UUID().uuidString)", directoryHint: .isDirectory), limit: limit)
    }

    private func setDate(_ date: Date, ofBody body: Data, in store: ResponseStore) throws {
        let files = try FileManager.default.contentsOfDirectory(at: store.directory, includingPropertiesForKeys: nil)
        for url in files where url.pathExtension == "json" && (try? Data(contentsOf: url)) == body {
            try FileManager.default.setAttributes([.modificationDate: date], ofItemAtPath: url.path)
        }
    }

    @Test func writeThenRead() throws {
        let store = makeStore()
        defer { store.removeAll() }
        #expect(store.read("a") == nil)
        store.write("a", body: Data("one".utf8), etag: "\"e1\"")
        let entry = try #require(store.read("a"))
        #expect(String(decoding: entry.body, as: UTF8.self) == "one")
        #expect(entry.etag == "\"e1\"")
        #expect(abs(entry.savedAt.timeIntervalSinceNow) < 60)
    }

    @Test func noETagReadsAsNil() throws {
        let store = makeStore()
        defer { store.removeAll() }
        store.write("a", body: Data("one".utf8), etag: "\"e1\"")
        store.write("a", body: Data("two".utf8), etag: nil)
        let entry = try #require(store.read("a"))
        #expect(String(decoding: entry.body, as: UTF8.self) == "two")
        #expect(entry.etag == nil)
    }

    @Test func keysAreIndependentAndCaseSensitive() throws {
        let store = makeStore()
        defer { store.removeAll() }
        store.write("http://a.test/api/day/2026-11-24", body: Data("a".utf8), etag: nil)
        store.write("http://b.test/api/day/2026-11-24", body: Data("b".utf8), etag: nil)
        store.write("http://A.test/api/day/2026-11-24", body: Data("c".utf8), etag: nil)
        #expect(try #require(store.read("http://a.test/api/day/2026-11-24")).body == Data("a".utf8))
        #expect(try #require(store.read("http://b.test/api/day/2026-11-24")).body == Data("b".utf8))
        #expect(try #require(store.read("http://A.test/api/day/2026-11-24")).body == Data("c".utf8))
    }

    @Test func touchRefreshesTheSavedTime() throws {
        let store = makeStore()
        defer { store.removeAll() }
        store.write("a", body: Data("one".utf8), etag: "\"e\"")
        let old = Date(timeIntervalSinceNow: -86_400)
        try setDate(old, ofBody: Data("one".utf8), in: store)
        #expect(abs(try #require(store.read("a")).savedAt.timeIntervalSince(old)) < 2)
        store.touch("a")
        let touched = try #require(store.read("a"))
        #expect(abs(touched.savedAt.timeIntervalSinceNow) < 60)
        #expect(touched.etag == "\"e\"" && touched.body == Data("one".utf8))
    }

    @Test func touchingWhatIsNotThereMakesNothing() {
        let store = makeStore()
        store.touch("nope")
        #expect(store.read("nope") == nil)
    }

    @Test func removeDropsTheBodyAndTheETag() throws {
        let store = makeStore()
        defer { store.removeAll() }
        store.write("a", body: Data("one".utf8), etag: "\"e\"")
        store.write("b", body: Data("two".utf8), etag: nil)
        store.remove("a")
        #expect(store.read("a") == nil)
        #expect(store.read("b") != nil)
        let files = try FileManager.default.contentsOfDirectory(atPath: store.directory.path)
        #expect(files.count == 2, "only b's two files are left: \(files)")
    }

    @Test func removeAllEmptiesTheStore() {
        let store = makeStore()
        store.write("a", body: Data("one".utf8), etag: nil)
        store.removeAll()
        #expect(store.read("a") == nil)
        store.write("a", body: Data("again".utf8), etag: nil)
        #expect(store.read("a") != nil, "it can be written to again")
        store.removeAll()
    }

    @Test func overTheLimitTheOldestBodiesGo() throws {
        let store = makeStore(limit: 1000)
        defer { store.removeAll() }
        let a = Data(repeating: 97, count: 400), b = Data(repeating: 98, count: 400), c = Data(repeating: 99, count: 400)
        store.write("a", body: a, etag: "\"a\"")
        try setDate(Date(timeIntervalSinceNow: -300), ofBody: a, in: store)
        store.write("b", body: b, etag: nil)
        try setDate(Date(timeIntervalSinceNow: -200), ofBody: b, in: store)
        #expect(store.read("a") != nil && store.read("b") != nil, "800 bytes are under the limit")
        store.write("c", body: c, etag: nil) // 1200 bytes: over the limit, trimmed to 750 or less
        #expect(store.read("a") == nil)
        #expect(store.read("b") == nil)
        #expect(store.read("c")?.body == c)
        let files = try FileManager.default.contentsOfDirectory(atPath: store.directory.path)
        #expect(files.count == 2, "only c's body and etag are left: \(files)")
    }

    @Test func trimmingStopsAtThreeQuartersOfTheLimit() {
        let store = makeStore(limit: 1000)
        defer { store.removeAll() }
        var bodies: [Data] = []
        for i in 0..<5 { // 5 x 250 bytes = 1250, over by write 5
            let body = Data(repeating: UInt8(100 + i), count: 250)
            bodies.append(body)
            store.write("k\(i)", body: body, etag: nil)
            try? setDate(Date(timeIntervalSinceNow: Double(i - 10) * 100), ofBody: body, in: store)
        }
        // Writing the fifth made it 1250: the oldest go until 750 are left (the fifth's date is set after its write, so it was newest).
        let left = (0..<5).filter { store.read("k\($0)") != nil }
        #expect(left == [2, 3, 4], "left: \(left)")
    }

    @Test func aBodyOverTheLimitIsDroppedWhole() {
        let store = makeStore(limit: 100)
        defer { store.removeAll() }
        store.write("big", body: Data(repeating: 1, count: 500), etag: nil)
        #expect(store.read("big") == nil)
    }
}
