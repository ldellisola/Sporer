import Foundation

/// A calendar date with no time and no zone, as the API writes it: `yyyy-MM-dd`.
nonisolated struct LocalDate: Hashable, Comparable, Sendable, Codable, CustomStringConvertible {
    var year: Int
    var month: Int
    var day: Int

    init(year: Int, month: Int, day: Int) {
        self.year = year
        self.month = month
        self.day = day
    }

    init?(_ string: String) {
        let parts = string.split(separator: "-")
        guard string.count == 10, parts.count == 3, parts[0].count == 4, parts[1].count == 2, parts[2].count == 2, let y = Int(parts[0]), let m = Int(parts[1]), let d = Int(parts[2]),
              (1...12).contains(m), (1...31).contains(d)
        else { return nil }
        self.init(year: y, month: m, day: d)
    }

    /// The date of `date` on the clock of `timeZone`; by default the phone's zone as it is now (`autoupdatingCurrent`: `current`
    /// is a snapshot that would keep the zone the app started in after a flight).
    init(_ date: Date, in timeZone: TimeZone = .autoupdatingCurrent) {
        let c = Self.calendar(timeZone).dateComponents([.year, .month, .day], from: date)
        self.init(year: c.year!, month: c.month!, day: c.day!)
    }

    static var today: LocalDate { LocalDate(Date()) }

    init(from decoder: any Decoder) throws {
        let s = try decoder.singleValueContainer().decode(String.self)
        guard let d = LocalDate(s) else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Not a yyyy-MM-dd date: \(s)"))
        }
        self = d
    }

    func encode(to encoder: any Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(description)
    }

    var description: String { String(format: "%04d-%02d-%02d", year, month, day) }

    static func < (a: LocalDate, b: LocalDate) -> Bool {
        (a.year, a.month, a.day) < (b.year, b.month, b.day)
    }

    /// Weeks run Monday to Sunday, as in the web app.
    static func calendar(_ timeZone: TimeZone = TimeZone(identifier: "UTC")!) -> Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = timeZone
        c.firstWeekday = 2
        c.minimumDaysInFirstWeek = 4
        c.locale = Locale(identifier: "en_GB")
        return c
    }

    /// Noon UTC of the date: a stable instant to format and do calendar arithmetic with.
    var noonUTC: Date {
        Self.calendar().date(from: DateComponents(year: year, month: month, day: day, hour: 12))!
    }

    /// Midnight at the start of the date on the clock of `timeZone`.
    func start(in timeZone: TimeZone) -> Date {
        Self.calendar(timeZone).date(from: DateComponents(year: year, month: month, day: day))!
    }

    func adding(days: Int) -> LocalDate {
        LocalDate(Self.calendar().date(byAdding: .day, value: days, to: noonUTC)!, in: TimeZone(identifier: "UTC")!)
    }

    func adding(months: Int) -> LocalDate {
        LocalDate(Self.calendar().date(byAdding: .month, value: months, to: noonUTC)!, in: TimeZone(identifier: "UTC")!)
    }

    func adding(years: Int) -> LocalDate {
        LocalDate(Self.calendar().date(byAdding: .year, value: years, to: noonUTC)!, in: TimeZone(identifier: "UTC")!)
    }

    func days(to other: LocalDate) -> Int {
        Self.calendar().dateComponents([.day], from: noonUTC, to: other.noonUTC).day!
    }

    var startOfWeek: LocalDate {
        let weekday = Self.calendar().component(.weekday, from: noonUTC) // 1 = Sunday
        let fromMonday = (weekday + 5) % 7
        return adding(days: -fromMonday)
    }

    var startOfMonth: LocalDate { LocalDate(year: year, month: month, day: 1) }
    var endOfMonth: LocalDate { startOfMonth.adding(months: 1).adding(days: -1) }
    var startOfYear: LocalDate { LocalDate(year: year, month: 1, day: 1) }
    var endOfYear: LocalDate { LocalDate(year: year, month: 12, day: 31) }

    var isToday: Bool { self == .today }
}

extension LocalDate: Identifiable {
    nonisolated var id: String { description }
}
