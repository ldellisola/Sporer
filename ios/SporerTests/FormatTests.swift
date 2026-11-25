import Foundation
import Testing
@testable import Sporer

@Suite("Format: the web app's wording and numbers")
struct FormatTests {
    nonisolated static let durations: [(Double, String)] = [
        (45, "45s"), (60, "1m"), (1440, "24m"), (3600, "1h"), (30720, "8h 32m"), (59.9, "59s"), (-5, "0s"),
    ]
    nonisolated static let distances: [(Double, String)] = [
        (850, "850 m"), (999.4, "999 m"), (999.6, "1.0 km"), (1149, "1.1 km"), (99_940, "99.9 km"), (412_300, "412 km"), (1_284_000, "1,284 km"),
    ]

    @Test(arguments: durations)
    func duration(seconds: Double, expected: String) {
        #expect(Format.duration(seconds) == expected)
    }

    @Test(arguments: distances)
    func distance(meters: Double, expected: String) {
        #expect(Format.distance(meters) == expected)
    }

    @Test func kilometresTheOwnerSet() {
        #expect(Format.km(50) == "50 km")
        #expect(Format.km(7.5) == "7.5 km")
        #expect(Format.km(1000) == "1,000 km")
    }

    @Test func counts() {
        #expect(Format.count(1, "place") == "1 place")
        #expect(Format.count(5, "place") == "5 places")
        #expect(Format.count(3, "city", "cities") == "3 cities")
        #expect(Format.nights("Lisbon", 4) == "Lisbon · 4 nights")
        #expect(Format.nights("Lisbon", 1) == "Lisbon · 1 night")
    }

    @Test func spans() {
        let d = { LocalDate($0)! }
        #expect(Format.span(d("2026-10-19"), d("2026-10-25")) == "19 – 25 Oct 2026")
        #expect(Format.span(d("2026-09-28"), d("2026-10-04")) == "28 Sep – 4 Oct 2026")
        #expect(Format.span(d("2025-12-29"), d("2026-01-04")) == "29 Dec 2025 – 4 Jan 2026")
        #expect(Format.span(d("2026-09-12"), d("2026-09-19"), collapse: false) == "12 Sep – 19 Sep 2026")
        #expect(Format.span(d("2026-09-12"), d("2026-09-12")) == "12 Sep 2026")
    }

    @Test func timesAreOnTheClockOfTheirZone() {
        // 07:46 UTC is 08:46 in Oslo and 07:46 in Lisbon in October 2026 (both on summer time).
        let instant = ISO8601DateFormatter().date(from: "2026-10-22T06:46:00Z")!
        #expect(Format.time(instant, zone: "Europe/Oslo") == "08:46")
        #expect(Format.time(instant, zone: "Europe/Lisbon") == "07:46")
        #expect(Format.time(instant, zone: "Not/AZone") == "06:46")
    }

    @Test func stayTimesOnADay() {
        let day = LocalDate("2026-10-22")!
        let iso = ISO8601DateFormatter()
        let before = iso.date(from: "2026-10-21T20:00:00Z")!
        let morning = iso.date(from: "2026-10-22T06:00:00Z")!
        let noon = iso.date(from: "2026-10-22T10:30:00Z")!
        let after = iso.date(from: "2026-10-22T23:30:00Z")!
        #expect(Format.timeRange(start: morning, startZone: "Europe/Oslo", end: noon, endZone: "Europe/Oslo", on: day) == "08:00 – 12:30")
        #expect(Format.timeRange(start: before, startZone: "Europe/Oslo", end: morning, endZone: "Europe/Oslo", on: day) == "Until 08:00")
        #expect(Format.timeRange(start: noon, startZone: "Europe/Oslo", end: after, endZone: "Europe/Oslo", on: day) == "From 12:30")
        #expect(Format.timeRange(start: noon, startZone: "Europe/Oslo", end: noon, endZone: "Europe/Oslo", on: day, ongoing: true) == "Since 12:30")
        #expect(Format.timeRange(start: before, startZone: "Europe/Oslo", end: after, endZone: "Europe/Oslo", on: day) == "All day")
    }

    @Test func placeNames() {
        #expect(Format.placeName("Barcode") == "Barcode")
        #expect(Format.placeName(nil, city: "Oslo") == "Oslo")
        #expect(Format.placeName("", city: nil) == "Unnamed place")
    }
}

@Suite("LocalDate")
struct LocalDateTests {
    @Test func parsesAndWrites() throws {
        let d = try #require(LocalDate("2026-02-28"))
        #expect(d.description == "2026-02-28")
        #expect(LocalDate("2026-13-01") == nil)
        #expect(LocalDate("26-1-1") == nil)
        #expect(LocalDate("yesterday") == nil)
    }

    @Test func arithmetic() {
        let d = LocalDate("2026-02-28")!
        #expect(d.adding(days: 1) == LocalDate("2026-03-01"))
        #expect(LocalDate("2024-02-28")!.adding(days: 1) == LocalDate("2024-02-29"))
        #expect(LocalDate("2026-01-31")!.adding(months: 1) == LocalDate("2026-02-28"))
        #expect(LocalDate("2026-03-29")!.adding(days: 1) == LocalDate("2026-03-30"), "across the start of summer time")
        #expect(LocalDate("2026-09-12")!.days(to: LocalDate("2026-09-19")!) == 7)
    }

    @Test func weeksStartOnMonday() {
        #expect(LocalDate("2026-11-25")!.startOfWeek == LocalDate("2026-11-23")) // a Wednesday
        #expect(LocalDate("2026-11-29")!.startOfWeek == LocalDate("2026-11-23")) // a Sunday
        #expect(LocalDate("2026-11-23")!.startOfWeek == LocalDate("2026-11-23")) // a Monday
    }

    @Test func monthsAndYears() {
        let d = LocalDate("2024-02-10")!
        #expect(d.startOfMonth == LocalDate("2024-02-01"))
        #expect(d.endOfMonth == LocalDate("2024-02-29"))
        #expect(d.endOfYear == LocalDate("2024-12-31"))
    }

    @Test func dateOfAnInstantInAZone() {
        // 23:30 UTC on 22 October is already 23 October in Oslo.
        let instant = ISO8601DateFormatter().date(from: "2026-10-22T23:30:00Z")!
        #expect(LocalDate(instant, in: TimeZone(identifier: "Europe/Oslo")!) == LocalDate("2026-10-23"))
        #expect(LocalDate(instant, in: TimeZone(identifier: "UTC")!) == LocalDate("2026-10-22"))
    }
}
