/// What a move's row in the day's rail offers for setting its mode by hand: the *Mode* menu of its context menu, and its VoiceOver
/// actions, which offer the same (the transit design, §5).
///
/// Choosing a mode saves it as the owner's, whichever it is. That goes for the mode the move already has when it was detected: choosing
/// the checked mode is how the owner keeps it, so that a later change of detection (the railway data arriving, say) leaves the move
/// alone. It goes for the mode the owner set too: after Use Detected Mode the row shows that mode until the server has rebuilt the
/// stretch, while the edit itself is gone, so choosing it again must store it again (the server takes the same mode twice without harm).
/// The web app does the same.
///
/// One change at a time: while the mode of any move of the day is being saved, no row offers a choice, rather than take one and drop it.
struct MoveModeChoices {
    let move: DaySegment.Move
    /// The id of the move of the day whose mode is being saved, if any.
    let changing: Int?

    /// A VoiceOver action: its name, and the mode it saves (nil goes back to the detected one).
    struct Action: Hashable {
        let title: String
        let mode: Mode?
    }

    /// This move's mode is the one being saved: its badge shows a spinner.
    var isChanging: Bool { changing == move.id }

    /// Whether the *Mode* menu can be opened: not while the mode of any move of the day is being saved, this one or another.
    var isEnabled: Bool { changing == nil }

    /// The menu's choices, as VoiceOver actions; none while a mode is being saved.
    var actions: [Action] {
        guard isEnabled else { return [] }
        var actions = Mode.allCases.map { mode in
            Action(title: mode == move.mode ? "Keep Mode as \(mode.title)" : "Set Mode to \(mode.title)", mode: mode)
        }
        if move.modeEdited {
            actions.append(Action(title: "Use Detected Mode", mode: nil))
        }
        return actions
    }
}
