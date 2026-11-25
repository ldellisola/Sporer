import SwiftUI

/// Rows in one rounded card, the way the Day screen groups them: inset dividers, a chevron on what opens.
private struct RowCard<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) { content }
            .background(.background.secondary, in: .rect(cornerRadius: 20))
            .clipShape(.rect(cornerRadius: 20))
    }
}

/// "Where Your Time Went": the places of the period ranked by the time spent, ten at first.
struct TopPlaces: View {
    @Environment(\.appModel) private var app
    let period: ExplorePeriod
    let places: [RangePlace]
    @State private var showsAll = false
    @AccessibilityFocusState private var focusedID: Int?

    private static let limit = 10

    var body: some View {
        let ranked = places.sorted { $0.seconds > $1.seconds }
        let top = ranked.first?.seconds ?? 1
        let shown = showsAll ? ranked : Array(ranked.prefix(Self.limit))
        VStack(alignment: .leading, spacing: 8) {
            PanelSectionHeader(title: "Where Your Time Went", trailing: Format.count(ranked.count, "place"))
            RowCard {
                ForEach(shown) { place in
                    let name = Format.placeName(place.name, city: place.city)
                    Button {
                        app.open(.place(place.id))
                    } label: {
                        VStack(alignment: .leading, spacing: 6) {
                            HStack(alignment: .firstTextBaseline, spacing: 8) {
                                Text(name).font(.body).lineLimit(2)
                                Spacer(minLength: 8)
                                Text(ExploreFormat.duration(place.seconds))
                                    .font(.subheadline)
                                    .monospacedDigit()
                                    .foregroundStyle(.secondary)
                                Image(systemName: "chevron.right")
                                    .font(.footnote.weight(.semibold))
                                    .foregroundStyle(.tertiary)
                            }
                            ShareBar(fraction: place.seconds / max(top, 1))
                        }
                        .padding(.vertical, 10)
                        .padding(.horizontal, 16)
                        .contentShape(.rect)
                    }
                    .buttonStyle(RowButtonStyle())
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("\(name)\(suffix(for: place, name: name, in: ranked)), \(ExploreFormat.duration(place.seconds))")
                    .accessibilityHint("Opens the place")
                    .accessibilityFocused($focusedID, equals: place.id)
                    if place.id != shown.last?.id { Divider().padding(.leading, 16) }
                }
            }
            if ranked.count > Self.limit {
                Button(showsAll ? "Show Fewer Places" : "Show All \(ranked.count) Places") {
                    withAnimation(.snappy) { showsAll.toggle() }
                    if showsAll { focusedID = ranked[Self.limit].id }
                }
                .buttonStyle(.glass)
                .frame(maxWidth: .infinity)
                .padding(.top, 4)
            }
        }
        .animation(.snappy, value: showsAll)
        .onChange(of: period) { showsAll = false }
    }

    /// ", number 2" for a place whose name another place in the list shares.
    private func suffix(for place: RangePlace, name: String, in ranked: [RangePlace]) -> String {
        let same = ranked.filter { Format.placeName($0.name, city: $0.city) == name }
        guard same.count > 1, let index = same.firstIndex(where: { $0.id == place.id }) else { return "" }
        return ", number \(index + 1)"
    }
}

/// "Days": one row per date of a short period (not the future), only the days with data in a long one.
struct DaysList: View {
    @Environment(\.appModel) private var app
    let period: ExplorePeriod
    let days: [RangeDay]

    private struct Row: Identifiable {
        var date: LocalDate
        var day: RangeDay?
        var id: LocalDate { date }
    }

    private var rows: [Row] {
        let byDate = Dictionary(days.map { ($0.date, $0) }, uniquingKeysWith: { a, _ in a })
        if period.dayCount > 31 {
            return days.sorted { $0.date < $1.date }.map { Row(date: $0.date, day: $0) }
        }
        return (0..<period.dayCount).compactMap { offset in
            let date = period.from.adding(days: offset)
            let day = byDate[date]
            return date <= .today || day != nil ? Row(date: date, day: day) : nil
        }
    }

    var body: some View {
        let rows = rows
        VStack(alignment: .leading, spacing: 8) {
            PanelSectionHeader(title: "Days", trailing: Format.count(rows.count, "day"))
            RowCard {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(rows) { row in
                        Button {
                            app.open(.day(row.date))
                        } label: {
                            HStack(spacing: 8) {
                                Text(Format.shortDay(row.date)).font(.body)
                                Spacer(minLength: 8)
                                Text(detail(row.day))
                                    .font(.subheadline)
                                    .monospacedDigit()
                                    .foregroundStyle(row.day == nil ? .tertiary : .secondary)
                                    .multilineTextAlignment(.trailing)
                                Image(systemName: "chevron.right")
                                    .font(.footnote.weight(.semibold))
                                    .foregroundStyle(.tertiary)
                            }
                            .padding(.vertical, 11)
                            .padding(.horizontal, 16)
                            .contentShape(.rect)
                        }
                        .buttonStyle(RowButtonStyle())
                        .accessibilityElement(children: .combine)
                        .accessibilityLabel("\(Format.shortDay(row.date)), \(detail(row.day))")
                        .accessibilityHint("Opens the day")
                        if row.id != rows.last?.id { Divider().padding(.leading, 16) }
                    }
                }
            }
        }
    }

    private func detail(_ day: RangeDay?) -> String {
        guard let day else { return "No movement" }
        return "\(Format.distance(day.distanceMeters)) · \(Format.count(day.places, "place"))"
    }
}

/// The four figures of a period: in one row while they fit, in two rows of two when the column is narrow or the type is large.
struct ExploreStats: View {
    let stats: [Stat]

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .top, spacing: 0) {
                ForEach(Array(stats.enumerated()), id: \.element.id) { index, stat in
                    if index > 0 { Divider().frame(height: 34).padding(.top, 4) }
                    cell(stat)
                }
            }
            Grid(horizontalSpacing: 0, verticalSpacing: 10) {
                GridRow { cell(stats[0]); cell(stats[1]) }
                GridRow { cell(stats[2]); cell(stats[3]) }
            }
        }
        .padding(.vertical, 12)
        .background(.background.secondary, in: .rect(cornerRadius: 20))
    }

    private func cell(_ stat: Stat) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Label {
                Text(stat.label).lineLimit(1).fixedSize(horizontal: true, vertical: false)
            } icon: {
                Image(systemName: stat.symbol).foregroundStyle(stat.tint)
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            Text(stat.value)
                .font(.title3.weight(.semibold))
                .monospacedDigit()
                .lineLimit(1)
                .fixedSize(horizontal: true, vertical: false)
                .contentTransition(.numericText())
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
        .accessibilityElement(children: .combine)
    }
}
