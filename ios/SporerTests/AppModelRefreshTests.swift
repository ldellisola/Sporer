import Foundation
import Testing
@testable import Sporer

@MainActor
@Suite("AppModel: when to ask for a day again")
struct AppModelRefreshTests {
    private let model = AppModel(service: MockService.shared)
    private let past = LocalDate("2026-11-24")!
    private var today: LocalDate { LocalDate.today }

    @Test func aPendingDayIsAskedForEvery30Seconds() {
        #expect(model.refreshInterval(from: past, to: past, state: .pending) == .seconds(30))
        #expect(model.refreshInterval(from: today, to: today, state: .pending) == .seconds(30))
    }

    @Test func aPendingDayJustEditedIsAskedForEvery3Seconds() {
        model.noteDayEdited(past)
        #expect(model.refreshInterval(from: past, to: past, state: .pending) == .seconds(3))
        #expect(model.refreshInterval(from: past.adding(days: -1), to: past.adding(days: -1), state: .pending) == .seconds(3))
        #expect(model.refreshInterval(from: past.adding(days: 1), to: past.adding(days: 1), state: .pending) == .seconds(3))
        #expect(model.refreshInterval(from: past.adding(days: 2), to: past.adding(days: 2), state: .pending) == .seconds(30))
        #expect(model.refreshInterval(from: past.adding(days: -2), to: past.adding(days: -2), state: .pending) == .seconds(30))
    }

    @Test func anEditedDayThatIsDoneIsLeftAlone() {
        model.noteDayEdited(past)
        #expect(model.refreshInterval(from: past, to: past, state: .done) == nil)
    }

    @Test func aPeriodIsNotAskedForFastAfterAnEdit() {
        model.noteDayEdited(past)
        #expect(model.refreshInterval(from: past.adding(days: -3), to: past.adding(days: 3), state: .pending) == .seconds(30))
    }

    @Test func aDoneDayThatIsTodayIsAskedForEveryMinute() {
        #expect(model.refreshInterval(from: today, to: today, state: .done) == .seconds(60))
    }

    @Test func aDoneDayInThePastIsNeverAskedForAgain() {
        #expect(model.refreshInterval(from: past, to: past, state: .done) == nil)
        #expect(model.refreshInterval(from: today.adding(days: 1), to: today.adding(days: 1), state: .done) == nil)
    }

    @Test func aPeriodContainingTodayIsAskedForEveryMinute() {
        #expect(model.refreshInterval(from: today.adding(days: -13), to: today, state: .done) == .seconds(60))
        #expect(model.refreshInterval(from: today, to: today.adding(days: 5), state: .done) == .seconds(60))
        #expect(model.refreshInterval(from: today.adding(days: -5), to: today.adding(days: 5), state: .done) == .seconds(60))
    }

    @Test func aPeriodInThePastIsNeverAskedForAgain() {
        #expect(model.refreshInterval(from: past.adding(days: -30), to: past, state: .done) == nil)
    }

    @Test func aDayResponseUsesItsOwnDateAndState() throws {
        var response = try Fixtures.decode(DayResponse.self, "day")
        response.state = .done
        response.date = past
        #expect(model.refreshInterval(for: response) == nil)
        response.date = today
        #expect(model.refreshInterval(for: response) == .seconds(60))
        response.state = .pending
        #expect(model.refreshInterval(for: response) == .seconds(30))
        model.noteDayEdited(today)
        #expect(model.refreshInterval(for: response) == .seconds(3))
    }

    @Test func dataChangedBumpsTheVersion() async throws {
        let before = model.dataVersion
        AppModel.dataChanged()
        for _ in 0..<100 where model.dataVersion == before { try await Task.sleep(for: .milliseconds(10)) }
        #expect(model.dataVersion > before)
    }

    @Test func rollOverKeepsADayThatIsNotToday() {
        model.day = past
        model.rollOver()
        #expect(model.day == past)
    }
}
