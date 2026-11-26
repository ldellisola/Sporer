import Foundation
import Testing
@testable import Sporer

extension WriteTests {
    /// The made-up world of `-mock` has trains and buses, and keeps a mode set by hand as the server does. Inside the serialized suite
    /// of the writes, because the mock's writes post the data-changed notice that those tests count.
    @Suite("MockService: modes")
    struct MockModeTests {
        private let porto = LocalDate("2026-09-15")!
        /// A Saturday: Sognsvann, Frognerparken, and the bus home.
        private let saturday = LocalDate("2026-11-21")!

        @Test func lisbonToPortoIsATrainAndSaturdaysEndWithABus() async throws {
            let mock = MockService()
            let train = try #require(try await mock.day(porto).moves.first { $0.mode == .train })
            #expect(train.distanceMeters > 300_000)
            #expect(!train.modeEdited)
            let bus = try #require(try await mock.day(saturday).moves.last)
            #expect(bus.mode == .bus && !bus.modeEdited)
        }

        @Test func aModeSetByHandIsKeptUntilItIsTakenBack() async throws {
            let mock = MockService()
            let bus = try #require(try await mock.day(saturday).moves.last)
            let answer = try await mock.setMode(.train, ofMove: bus.id)
            #expect(answer == MoveModeResponse(id: bus.id, mode: .train, modeEdited: true))

            let edited = try #require(try await mock.day(saturday).moves.first { $0.id == bus.id })
            #expect(edited.mode == .train && edited.modeEdited)
            #expect(edited.start == bus.start && edited.end == bus.end, "the mode changes what the move is called, not when it was")
            let period = try await mock.range(from: saturday, to: saturday)
            #expect(period.moves.first { $0.id == bus.id }?.mode == .train)

            try await mock.clearMode(ofMove: bus.id)
            let back = try #require(try await mock.day(saturday).moves.first { $0.id == bus.id })
            #expect(back.mode == .bus && !back.modeEdited)
        }

        @Test func aMoveThatIsNotThereIsNotFound() async {
            let mock = MockService()
            let set = await serviceError { try await mock.setMode(.walk, ofMove: 1) }
            let cleared = await serviceError { try await mock.clearMode(ofMove: 2026_11_21_99) }
            guard case .notFound? = set, case .notFound? = cleared else {
                Issue.record("expected notFound, got \(String(describing: set)) and \(String(describing: cleared))")
                return
            }
        }
    }
}
