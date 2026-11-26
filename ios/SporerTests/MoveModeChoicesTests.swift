import Foundation
import Testing
@testable import Sporer

/// What a move's row offers for setting its mode by hand: the Mode menu of its context menu and its VoiceOver actions.
@MainActor
@Suite("A move's mode choices")
struct MoveModeChoicesTests {
    private func move(_ id: Int, _ mode: Mode?, edited: Bool = false) -> DaySegment.Move {
        let start = Date(timeIntervalSince1970: 1_790_000_000)
        return DaySegment.Move(id: id, start: start, end: start.addingTimeInterval(1_800), startTimeZone: "Europe/Oslo",
                               endTimeZone: "Europe/Oslo", mode: mode, distanceMeters: 12_000,
                               geometry: [LonLat(lon: 10.75, lat: 59.91), LonLat(lon: 10.9, lat: 59.95)], modeEdited: edited)
    }

    @Test func theCheckedModeOfADetectedMoveIsOfferedSoThatItIsKept() {
        let detected = MoveModeChoices(move: move(1, .drive), changing: nil)
        #expect(detected.actions.contains(.init(title: "Keep Mode as Drive", mode: .drive)),
                "the owner keeps a detected drive, so that the railway data arriving later does not make it a train")
    }

    @Test func theModeTheOwnerSetIsOfferedAgain() {
        // After Use Detected Mode the row shows the owner's mode until the stretch is rebuilt, while the edit is gone: choosing it
        // again must store it again.
        let edited = MoveModeChoices(move: move(1, .bus, edited: true), changing: nil)
        #expect(edited.actions.contains(.init(title: "Keep Mode as Bus", mode: .bus)))
        #expect(edited.actions.compactMap(\.mode) == Mode.allCases)
    }

    @Test func voiceOverOffersWhatTheMenuDoes() {
        let detected = MoveModeChoices(move: move(1, .drive), changing: nil)
        #expect(detected.actions.map(\.title) == ["Set Mode to Walk", "Set Mode to Cycle", "Keep Mode as Drive", "Set Mode to Bus",
                                                  "Set Mode to Train", "Set Mode to Flight"])
        #expect(detected.actions.map(\.mode) == Mode.allCases)

        let edited = MoveModeChoices(move: move(1, .train, edited: true), changing: nil)
        #expect(edited.actions.map(\.title) == ["Set Mode to Walk", "Set Mode to Cycle", "Set Mode to Drive", "Set Mode to Bus",
                                                "Keep Mode as Train", "Set Mode to Flight", "Use Detected Mode"])
        #expect(edited.actions.last?.mode == nil)

        let unknown = MoveModeChoices(move: move(1, nil), changing: nil)
        #expect(unknown.actions.map(\.mode) == Mode.allCases, "a mode the app does not know is none of the six")
        #expect(unknown.actions.allSatisfy { $0.title.hasPrefix("Set Mode to ") })
    }

    @Test func whileOneMoveIsSavedNoRowOffersAChoice() {
        let saving = move(1, .drive), other = move(2, .walk, edited: true)
        let savingRow = MoveModeChoices(move: saving, changing: saving.id)
        let otherRow = MoveModeChoices(move: other, changing: saving.id)

        #expect(savingRow.isChanging && !otherRow.isChanging, "only the move being saved shows the spinner")
        #expect(!savingRow.isEnabled && !otherRow.isEnabled, "every row's Mode menu waits, not only the one being saved")
        #expect(savingRow.actions.isEmpty && otherRow.actions.isEmpty, "no VoiceOver action is offered only to be dropped")
    }

    @Test func onceNothingIsSavedEveryRowOffersItsChoicesAgain() {
        let row = MoveModeChoices(move: move(2, .walk), changing: nil)
        #expect(row.isEnabled && !row.isChanging)
        #expect(row.actions.count == Mode.allCases.count)
    }
}
