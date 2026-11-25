import Foundation

/// The stretch of the timeline the Explore tab shows: a week, a month, a year or a custom range.
nonisolated struct ExplorePeriod: Hashable, Sendable {
    var scale: PeriodScale
    var from: LocalDate
    var to: LocalDate

    init(scale: PeriodScale, anchor: LocalDate, range: ClosedRange<LocalDate>) {
        self.scale = scale
        switch scale {
        case .week: from = anchor.startOfWeek; to = anchor.startOfWeek.adding(days: 6)
        case .month: from = anchor.startOfMonth; to = anchor.endOfMonth
        case .year: from = anchor.startOfYear; to = anchor.endOfYear
        case .range: from = range.lowerBound; to = range.upperBound
        }
    }

    var dayCount: Int { from.days(to: to) + 1 }

    /// "November 2026", "16 – 22 Nov 2026", "2026", "12 Sep – 19 Sep 2026".
    var title: String {
        switch scale {
        case .week: Format.span(from, to)
        case .month: Format.month(from)
        case .year: String(from.year)
        case .range: Format.span(from, to, collapse: false)
        }
    }

    /// The period `steps` periods away (a range moves by its own length), as the date to anchor on and the range to keep.
    func moved(by steps: Int) -> (anchor: LocalDate, range: ClosedRange<LocalDate>) {
        switch scale {
        case .week: return (from.adding(days: 7 * steps), from.adding(days: 7 * steps)...to.adding(days: 7 * steps))
        case .month: return (from.adding(months: steps), from...to)
        case .year: return (from.adding(years: steps), from...to)
        case .range:
            // Stepping forward never reaches past today: the range keeps its length and ends today at the latest.
            let end = min(to.adding(days: dayCount * steps), .today)
            let start = end.adding(days: 1 - dayCount)
            return (end, start...end)
        }
    }

    /// The first day of the next period, to tell whether there is one yet.
    var nextStart: LocalDate {
        switch scale {
        case .week: from.adding(days: 7)
        case .month: from.adding(months: 1)
        case .year: from.adding(years: 1)
        case .range: to.adding(days: 1)
        }
    }

    var containsToday: Bool { from <= .today && .today <= to }

    /// Whether there is a later period to step to.
    var hasNext: Bool { scale == .range ? to < .today : nextStart <= .today }

    /// Whether this is already the period that "today" asks for.
    var isCurrent: Bool { scale == .range ? to == .today : containsToday }

    /// "This Week", "This Month", "This Year", "Up to Today".
    var currentTitle: String {
        switch scale { case .week: "This Week"; case .month: "This Month"; case .year: "This Year"; case .range: "Up to Today" }
    }
}

/// One bar of the distance chart: a day, a week or a month.
nonisolated struct DistanceBucket: Identifiable, Hashable, Sendable {
    enum Unit { case day, week, month }
    var start: LocalDate
    var unit: Unit
    var meters: Double
    var id: LocalDate { start }

    var kilometers: Double { meters / 1000 }
    var calendarUnit: Calendar.Component {
        switch unit { case .day: .day; case .week: .weekOfYear; case .month: .month }
    }
    var date: Date { start.start(in: TimeZone(identifier: "UTC")!) }

    /// "Thu 22 Oct", "Week of 19 Oct", "October 2026".
    var label: String {
        switch unit {
        case .day: Format.shortDay(start)
        case .week: "Week of \(Format.shortDay(start))"
        case .month: Format.month(start)
        }
    }

    /// Days for up to three months, weeks for longer ranges, months for a year.
    static func buckets(for period: ExplorePeriod, days: [RangeDay]) -> [DistanceBucket] {
        let unit: Unit = period.scale == .year ? .month : (period.dayCount > 92 ? .week : .day)
        func key(_ d: LocalDate) -> LocalDate {
            switch unit { case .day: d; case .week: d.startOfWeek; case .month: d.startOfMonth }
        }
        var sums: [LocalDate: Double] = [:]
        for d in days { sums[key(d.date), default: 0] += d.distanceMeters }
        var out: [DistanceBucket] = []
        var cursor = key(period.from)
        while cursor <= period.to {
            out.append(DistanceBucket(start: cursor, unit: unit, meters: sums[cursor] ?? 0))
            switch unit {
            case .day: cursor = cursor.adding(days: 1)
            case .week: cursor = cursor.adding(days: 7)
            case .month: cursor = cursor.adding(months: 1)
            }
        }
        return out
    }
}

/// Number formats for the Explore panel that the shared `Format` does not cover.
nonisolated enum ExploreFormat {
    /// "8h 32m" up to two days, then "179d 10h": a year of moving would otherwise read "4306h 58m".
    static func duration(_ seconds: Double) -> String {
        let s = max(0, Int(seconds.rounded(.down)))
        guard s >= 48 * 3600 else { return Format.duration(seconds) }
        let d = s / 86_400, h = (s % 86_400) / 3600
        return h > 0 ? "\(d)d \(h)h" : "\(d)d"
    }

    /// A chart axis tick: "0.5 km", "2.5 km", "5k km".
    static func axisKm(_ km: Double) -> String {
        let style = FloatingPointFormatStyle<Double>.number.precision(.fractionLength(0...1)).locale(Locale(identifier: "en_GB"))
        return km >= 1000 ? (km / 1000).formatted(style) + "k km" : km.formatted(style) + " km"
    }
}
