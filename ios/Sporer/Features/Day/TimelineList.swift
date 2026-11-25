import SwiftUI

/// A day's stays, moves and gaps on one rail, as in Replay: a stay is a disc on the rail (the same disc as its pin on the map),
/// a move is the rail drawn in its mode's colour, and a gap is the rail broken.
/// Tapping a row brings it into view on the map; a stay's ⓘ opens its place.
struct TimelineList: View {
    @Environment(\.appModel) private var app
    let day: DayResponse

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
                    MoveRow(move: move, isFocused: app.map.focus == .segment(segment.id)) {
                        focus(segment)
                    }
                case .gap(let gap):
                    GapRow(gap: gap)
                }
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
    let move: DaySegment.Move
    let isFocused: Bool
    var focus: () -> Void

    var body: some View {
        let style = ModeStyle(mode: move.mode)
        Button(action: focus) {
            HStack(spacing: 10) {
                Rail(top: style.color, bottom: style.color, width: 5, nodeY: 0)
                    .frame(width: 44)
                ModeBadge(mode: move.mode, size: 30)
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(style.title) · \(Format.distance(move.distanceMeters))")
                        .font(.subheadline.weight(.semibold))
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
        .accessibilityLabel("\(style.title), \(Format.distance(move.distanceMeters)), \(Format.duration(move.end.timeIntervalSince(move.start)))")
        .accessibilityHint("Shows it on the map")
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
