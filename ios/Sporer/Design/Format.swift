import Foundation

/// The wording and number formats of the web app: English, 24-hour clock, metric, weeks from Monday,
/// and every time on the clock of the zone it happened in.
nonisolated enum Format {
    private static let locale = Locale(identifier: "en_GB")

    static func zone(_ identifier: String) -> TimeZone {
        TimeZone(identifier: identifier) ?? TimeZone(identifier: "UTC")!
    }

    /// The short name of a zone at a moment, as the web app writes it: "CET", "CEST", "WET", "EST", else "GMT+9".
    /// British English names Europe's zones and American English America's; neither has a name for most others.
    static func zoneAbbreviation(_ identifier: String, at date: Date) -> String {
        let named = ["en_GB", "en_US"].lazy.map { locale -> String in
            let formatter = DateFormatter()
            formatter.locale = Locale(identifier: locale)
            formatter.timeZone = zone(identifier)
            formatter.dateFormat = "zzz"
            return formatter.string(from: date)
        }
        return named.first { !$0.hasPrefix("GMT+") && !$0.hasPrefix("GMT-") } ?? named.first ?? identifier
    }

    // MARK: Durations and distances

    /// "8h 32m", "24m", "45s".
    static func duration(_ seconds: Double) -> String {
        let s = max(0, Int(seconds.rounded(.down)))
        let h = s / 3600, m = (s % 3600) / 60
        if h > 0 { return m > 0 ? "\(h)h \(m)m" : "\(h)h" }
        if m > 0 { return "\(m)m" }
        return "\(s)s"
    }

    /// "850 m", "1.1 km", "412 km".
    static func distance(_ meters: Double) -> String {
        let m = meters.rounded()
        if m < 1000 { return "\(Int(m)) m" }
        let km = m / 1000
        if km < 100 { return String(format: "%.1f km", km) }
        return grouped(Int(km.rounded())) + " km"
    }

    /// A kilometre value the owner set: up to two decimals, no trailing zeros. "50 km", "7.5 km".
    static func km(_ value: Double) -> String {
        let f = NumberFormatter()
        f.locale = locale
        f.numberStyle = .decimal
        f.maximumFractionDigits = 2
        return (f.string(from: value as NSNumber) ?? "\(value)") + " km"
    }

    static func grouped(_ n: Int) -> String {
        let f = NumberFormatter()
        f.locale = locale
        f.numberStyle = .decimal
        return f.string(from: n as NSNumber) ?? "\(n)"
    }

    /// "1 place", "5 places".
    static func count(_ n: Int, _ singular: String, _ plural: String? = nil) -> String {
        "\(grouped(n)) \(n == 1 ? singular : (plural ?? singular + "s"))"
    }

    // MARK: Times and dates

    private static func formatter(_ pattern: String, _ zone: TimeZone) -> DateFormatter {
        let f = DateFormatter()
        f.locale = locale
        f.calendar = LocalDate.calendar(zone)
        f.timeZone = zone
        f.dateFormat = pattern
        return f
    }

    /// "08:46" on the clock of `zone`.
    static func time(_ date: Date, zone: String) -> String {
        formatter("HH:mm", self.zone(zone)).string(from: date)
    }

    /// "Thursday 22 October" (with the year when it is not this year).
    static func longDay(_ date: LocalDate) -> String {
        let utc = TimeZone(identifier: "UTC")!
        let pattern = date.year == LocalDate.today.year ? "EEEE d MMMM" : "EEEE d MMMM yyyy"
        return formatter(pattern, utc).string(from: date.noonUTC)
    }

    /// "Thu 22 Oct".
    static func shortDay(_ date: LocalDate, withYear: Bool = false) -> String {
        formatter(withYear ? "EEE d MMM yyyy" : "EEE d MMM", TimeZone(identifier: "UTC")!).string(from: date.noonUTC)
    }

    /// "22 Oct 2026".
    static func date(_ date: LocalDate) -> String {
        formatter("d MMM yyyy", TimeZone(identifier: "UTC")!).string(from: date.noonUTC)
    }

    /// "Today", "Yesterday", or the weekday and date.
    static func dayTitle(_ date: LocalDate) -> String {
        let today = LocalDate.today
        if date == today { return "Today" }
        if date == today.adding(days: -1) { return "Yesterday" }
        return formatter("EEEE", TimeZone(identifier: "UTC")!).string(from: date.noonUTC)
    }

    /// "22 October 2026" for under the day's title.
    static func dayDate(_ date: LocalDate) -> String {
        formatter("d MMMM yyyy", TimeZone(identifier: "UTC")!).string(from: date.noonUTC)
    }

    /// "October 2026".
    static func month(_ date: LocalDate) -> String {
        formatter("MMMM yyyy", TimeZone(identifier: "UTC")!).string(from: date.noonUTC)
    }

    /// "19 – 25 Oct 2026", "28 Sep – 4 Oct 2026", "29 Dec 2025 – 4 Jan 2026".
    static func span(_ from: LocalDate, _ to: LocalDate, collapse: Bool = true) -> String {
        let utc = TimeZone(identifier: "UTC")!
        if from == to { return date(from) }
        if from.year != to.year {
            return "\(date(from)) – \(date(to))"
        }
        if collapse && from.month == to.month {
            return "\(from.day) – \(formatter("d MMM yyyy", utc).string(from: to.noonUTC))"
        }
        return "\(formatter("d MMM", utc).string(from: from.noonUTC)) – \(formatter("d MMM yyyy", utc).string(from: to.noonUTC))"
    }

    /// The times of a stay or move on the clocks of the zones it started and ended in, as the day view shows them.
    static func timeRange(start: Date, startZone: String, end: Date, endZone: String, on day: LocalDate, ongoing: Bool = false) -> String {
        let startedBefore = LocalDate(start, in: zone(startZone)) < day
        let endsAfter = LocalDate(end, in: zone(endZone)) > day || ongoing
        switch (startedBefore, endsAfter) {
        case (true, true): return ongoing ? "All day so far" : "All day"
        case (true, false): return "Until \(time(end, zone: endZone))"
        case (false, true): return ongoing ? "Since \(time(start, zone: startZone))" : "From \(time(start, zone: startZone))"
        case (false, false): return "\(time(start, zone: startZone)) – \(time(end, zone: endZone))"
        }
    }

    /// "Lisbon · 4 nights".
    static func nights(_ name: String, _ nights: Int) -> String {
        "\(name) · \(count(nights, "night"))"
    }

    static func placeName(_ name: String?, city: String? = nil) -> String {
        if let name, !name.isEmpty { return name }
        if let city, !city.isEmpty { return city }
        return "Unnamed place"
    }

    /// "Thu 22 Oct 2026 08:46" on the device's clock.
    static func stamp(_ date: Date) -> String {
        formatter("EEE d MMM yyyy HH:mm", .autoupdatingCurrent).string(from: date)
    }
}
