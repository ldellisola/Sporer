import SwiftUI

/// A day's stays, moves and gaps on one rail, as in Replay: a stay is a disc on the rail (the same disc as its pin on the map),
/// a move is the rail drawn in its mode's colour, and a gap is the rail broken.
/// Tapping a row brings it into view on the map; a stay's ⓘ opens its place; a move's context menu (and its VoiceOver actions)
/// sets its mode by hand.
struct TimelineList: View {
    @Environment(\.appModel) private var app
    let day: DayResponse

    // Kept here rather than in the row: a move gets another id when the server rebuilds it after the change.
    @State private var changingMove: Int?
    @State private var modeFailure: ModeFailure?

    struct ModeFailure: Identifiable {
        let id = UUID()
        let move: DaySegment.Move
        /// The mode it was to get; nil to go back to the detected one.
        let mode: Mode?
        let message: String
        let retryable: Bool
    }

    var body: some View {
        let numbers = stopNumbers
        VStack(spacing: 0) {
            ForEach(Array(day.segments.enumerated()), id: \.element.id) { index, segment in
                let isFirst = index == 0
                let isLast = index == day.segments.count - 1
                switch segment {
                case .stay(let stay):
                    StayRow(stay: stay, number: numbers[segment.id], day: day.date,
                            ongoing: isLast && day.date == .today, isFirst: isFirst, isLast: isLast,
                            isFocused: app.map.focus == .segment(segment.id)) {
                        focus(segment)
                    } openPlace: {
                        if let id = stay.place?.id { app.open(.place(id)) }
                    }
                case .move(let move):
                    MoveRow(choices: MoveModeChoices(move: move, changing: changingMove), isFocused: app.map.focus == .segment(segment.id)) {
                        focus(segment)
                    } setMode: { mode in
                        change(move, to: mode)
                    }
                case .gap(let gap):
                    GapRow(gap: gap)
                }
            }
        }
        .alert("Couldn't Change Mode", isPresented: Binding(get: { modeFailure != nil }, set: { if !$0 { modeFailure = nil } }),
               presenting: modeFailure) { failure in
            if failure.retryable {
                Button("Retry") { change(failure.move, to: failure.mode) }
            }
            Button(failure.retryable ? "Cancel" : "OK", role: .cancel) {}
        } message: { failure in
            Text(failure.message)
        }
    }

    /// Sets the move's mode (nil: back to the detected one). The service says the data changed, so the day loads again; it is
    /// then asked for every few seconds while the server rebuilds it, as after an edit of its points.
    private func change(_ move: DaySegment.Move, to mode: Mode?) {
        // One at a time; the rows offer no choice meanwhile (MoveModeChoices).
        guard changingMove == nil else { return }
        let app = self.app, date = day.date
        changingMove = move.id
        Task {
            defer { changingMove = nil }
            do {
                if let mode {
                    _ = try await app.service.setMode(mode, ofMove: move.id)
                } else {
                    try await app.service.clearMode(ofMove: move.id)
                }
                app.noteDayEdited(date)
                AccessibilityNotification.Announcement(mode.map { "Mode set to \($0.title)" } ?? "Mode set back to the detected one").post()
            } catch is CancellationError {
            } catch ServiceError.notFound {
                // The server rebuilt the move under another id meanwhile, and the day is loading again: the change is to be made there.
                app.toasts.show(Toast(message: "The day had changed. Try again.", symbol: "info.circle.fill"))
            } catch {
                let message = "Could not change the mode: \(error.localizedDescription)"
                AccessibilityNotification.Announcement(message).post()
                modeFailure = ModeFailure(move: move, mode: mode, message: message, retryable: (error as? ServiceError)?.isRetryable ?? true)
            }
        }
    }

    /// Stays with a place that is not home are numbered from 1 in the order of the day, as their pins are.
    private var stopNumbers: [String: String] {
        var n = 0
        var out: [String: String] = [:]
        for segment in day.segments {
            if case .stay(let s) = segment, s.place != nil, !s.home {
                n += 1
                out[segment.id] = "\(n)"
            }
        }
        return out
    }

    private func focus(_ segment: DaySegment) {
        withAnimation(.snappy) {
            app.map.focus = app.map.focus == .segment(segment.id) ? nil : .segment(segment.id)
        }
        app.revealMap()
    }
}

/// The column the rail runs down, to the left of every row.
private struct Rail: View {
    var top: Color?
    var bottom: Color?
    var width: CGFloat = 3
    var dashed = false
    /// Where the node sits, from the top of the row.
    var nodeY: CGFloat = 22

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .top) {
                if let top {
                    segment(top, from: 0, to: nodeY)
                }
                if let bottom {
                    segment(bottom, from: nodeY, to: geo.size.height)
                }
            }
            .frame(width: geo.size.width)
        }
        .frame(width: 44)
        .accessibilityHidden(true)
    }

    private func segment(_ color: Color, from: CGFloat, to: CGFloat) -> some View {
        Path { p in
            p.move(to: CGPoint(x: 22, y: from))
            p.addLine(to: CGPoint(x: 22, y: to))
        }
        .stroke(color, style: StrokeStyle(lineWidth: width, lineCap: .round, dash: dashed ? [2, 5] : []))
    }
}

private let railGray = Color(uiColor: .systemGray4)

private struct StayRow: View {
    let stay: DaySegment.Stay
    let number: String?
    let day: LocalDate
    let ongoing: Bool
    let isFirst: Bool
    let isLast: Bool
    let isFocused: Bool
    var focus: () -> Void
    var openPlace: () -> Void

    var body: some View {
        let name = stay.place.map { Format.placeName($0.name) } ?? "Unnamed place"
        let times = Format.timeRange(start: stay.start, startZone: stay.startTimeZone, end: stay.end, endZone: stay.endTimeZone, on: day, ongoing: ongoing)
        Button(action: focus) {
            HStack(alignment: .top, spacing: 10) {
                ZStack(alignment: .top) {
                    Rail(top: isFirst ? nil : railGray, bottom: isLast ? nil : railGray)
                    StopBadge(label: stay.place == nil ? nil : number, isHome: stay.home && stay.place != nil)
                        .scaleEffect(isFocused ? 1.15 : 1)
                        .padding(.top, 7)
                }
                .frame(width: 44)
                VStack(alignment: .leading, spacing: 3) {
                    Text(name)
                        .font(.headline)
                        .foregroundStyle(stay.place == nil ? .secondary : .primary)
                        .multilineTextAlignment(.leading)
                    HStack(spacing: 6) {
                        Text(times)
                        Text("·")
                        Text(Format.duration(stay.end.timeIntervalSince(stay.start)))
                        if ongoing {
                            Text("Now")
                                .font(.caption2.weight(.bold))
                                .foregroundStyle(.white)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(Color.pin, in: .capsule)
                        }
                    }
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
                }
                .padding(.vertical, 10)
                Spacer(minLength: 0)
                if stay.place != nil {
                    Button(action: openPlace) {
                        Image(systemName: "info.circle")
                            .font(.title3)
                            .foregroundStyle(.tint)
                            .frame(width: 44, height: 44)
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Open \(name)")
                    .padding(.top, 2)
                }
            }
            .contentShape(.rect)
        }
        .buttonStyle(RowButtonStyle(isFocused: isFocused))
        .accessibilityLabel(stay.home ? "Home, \(name), \(times)" : "Stop \(number ?? ""), \(name), \(times)")
        .accessibilityHint("Shows it on the map")
        .contextMenu {
            Button("Show on Map", systemImage: "map", action: focus)
            if stay.place != nil {
                Button("Open Place", systemImage: "mappin.circle", action: openPlace)
            }
        }
    }
}

private struct MoveRow: View {
    /// The move, and what it offers for setting its mode.
    let choices: MoveModeChoices
    let isFocused: Bool
    var focus: () -> Void
    /// Sets the mode by hand; nil goes back to the detected one.
    var setMode: (Mode?) -> Void

    private var move: DaySegment.Move { choices.move }
    private var isChanging: Bool { choices.isChanging }

    var body: some View {
        let style = ModeStyle(mode: move.mode)
        Button(action: focus) {
            HStack(spacing: 10) {
                Rail(top: style.color, bottom: style.color, width: 5, nodeY: 0)
                    .frame(width: 44)
                ZStack {
                    ModeBadge(mode: move.mode, size: 30)
                        .opacity(isChanging ? 0 : 1)
                    if isChanging {
                        ProgressView().controlSize(.small)
                    }
                }
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text("\(style.title) · \(Format.distance(move.distanceMeters))")
                            .font(.subheadline.weight(.semibold))
                        if move.modeEdited {
                            Text("Set by You")
                                .font(.caption2.weight(.medium))
                                .foregroundStyle(.secondary)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(.fill.tertiary, in: .capsule)
                        }
                    }
                    Text("\(Format.time(move.start, zone: move.startTimeZone)) – \(Format.time(move.end, zone: move.endTimeZone)) · \(Format.duration(move.end.timeIntervalSince(move.start)))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }
                .padding(.vertical, 9)
                Spacer(minLength: 0)
            }
            .contentShape(.rect)
        }
        .buttonStyle(RowButtonStyle(isFocused: isFocused))
        .disabled(move.geometry.count < 2)
        .accessibilityLabel("\(style.title)\(move.modeEdited ? ", set by you" : ""), \(Format.distance(move.distanceMeters)), \(Format.duration(move.end.timeIntervalSince(move.start)))")
        .accessibilityHint("Shows it on the map")
        .accessibilityActions {
            ForEach(choices.actions, id: \.self) { action in
                Button(action.title) { setMode(action.mode) }
            }
        }
        .contextMenu {
            Button("Show on Map", systemImage: "map", action: focus)
                .disabled(move.geometry.count < 2)
            Menu {
                // Toggles, so that the current mode is checked. Choosing the checked one turns its toggle off, and still saves it
                // (MoveModeChoices): a detected mode is kept that way.
                ForEach(Mode.allCases, id: \.self) { mode in
                    Toggle(isOn: Binding(get: { move.mode == mode }, set: { _ in setMode(mode) })) {
                        Label(mode.title, systemImage: mode.symbol)
                    }
                }
                if move.modeEdited {
                    Divider()
                    Button("Use Detected Mode", systemImage: "arrow.uturn.backward") { setMode(nil) }
                }
            } label: {
                Label("Mode", systemImage: style.symbol)
            }
            .disabled(!choices.isEnabled)
        }
    }
}

private struct GapRow: View {
    let gap: DaySegment.Gap

    var body: some View {
        HStack(spacing: 10) {
            Rail(top: railGray, bottom: railGray, dashed: true, nodeY: 0)
                .frame(width: 44)
            Image(systemName: "antenna.radiowaves.left.and.right.slash")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.secondary)
                .frame(width: 30, height: 30)
                .background(.fill.tertiary, in: .circle)
            VStack(alignment: .leading, spacing: 2) {
                Text("No Data")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.secondary)
                Text("\(Format.time(gap.start, zone: gap.startTimeZone)) – \(Format.time(gap.end, zone: gap.endTimeZone)) · \(Format.duration(gap.end.timeIntervalSince(gap.start)))")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .monospacedDigit()
            }
            .padding(.vertical, 9)
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
    }
}

/// A row that highlights while pressed and while it is the one shown on the map.
struct RowButtonStyle: ButtonStyle {
    var isFocused = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background {
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(Color.primary.opacity(configuration.isPressed ? 0.08 : (isFocused ? 0.05 : 0)))
                    .padding(.horizontal, -6)
            }
            .animation(.easeOut(duration: 0.15), value: configuration.isPressed)
    }
}
