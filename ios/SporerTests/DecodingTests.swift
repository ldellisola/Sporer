import Foundation
import Testing
@testable import Sporer

/// The JSON the server writes (README.md and web/src/api/types.ts) decodes into the app's models.
@Suite("Decoding the API's JSON")
struct DecodingTests {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let s = try decoder.singleValueContainer().decode(String.self)
            let f = ISO8601DateFormatter()
            f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let d = f.date(from: s) { return d }
            f.formatOptions = [.withInternetDateTime]
            if let d = f.date(from: s) { return d }
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: s))
        }
        return try decoder.decode(T.self, from: Data(json.utf8))
    }

    @Test func aDayWithAStayAMoveAndAGap() throws {
        let day = try decode(DayResponse.self, """
        {"date":"2026-10-22","timeZone":"Europe/Oslo","state":"done",
         "summary":{"places":2,"distanceMeters":2264.5,"movingSeconds":1800},
         "segments":[
          {"kind":"stay","id":1,"start":"2026-10-21T19:40:00Z","end":"2026-10-22T05:55:00Z","startTimeZone":"Europe/Oslo","endTimeZone":"Europe/Oslo",
           "place":{"id":1,"name":"Home","city":"Oslo","country":"Norway","lat":59.92,"lon":10.75},"home":true},
          {"kind":"move","id":2,"start":"2026-10-22T05:55:00Z","end":"2026-10-22T06:25:00.123Z","startTimeZone":"Europe/Oslo","endTimeZone":"Europe/Oslo",
           "mode":"cycle","distanceMeters":2264.5,"geometry":[[10.75,59.92],[10.76,59.91]]},
          {"kind":"move","id":3,"start":"2026-10-22T06:25:00Z","end":"2026-10-22T06:30:00Z","startTimeZone":"Europe/Oslo","endTimeZone":"Europe/Oslo",
           "distanceMeters":10,"geometry":[]},
          {"kind":"gap","id":4,"start":"2026-10-22T18:05:00Z","end":"2026-10-22T19:40:00Z","startTimeZone":"Europe/Oslo","endTimeZone":"Europe/Oslo",
           "from":{"lat":59.92,"lon":10.75},"to":null},
          {"kind":"stay","id":5,"start":"2026-10-22T19:40:00Z","end":"2026-10-23T05:00:00Z","startTimeZone":"Europe/Oslo","endTimeZone":"Europe/Oslo",
           "place":null,"home":false}
         ]}
        """)
        #expect(day.date == LocalDate("2026-10-22"))
        #expect(day.segments.count == 5)
        guard case .stay(let home) = day.segments[0], case .move(let ride) = day.segments[1], case .move(let unknown) = day.segments[2],
              case .gap(let gap) = day.segments[3], case .stay(let nowhere) = day.segments[4]
        else { Issue.record("wrong kinds"); return }
        #expect(home.home && home.place?.name == "Home")
        #expect(ride.mode == .cycle && ride.geometry == [LonLat(lon: 10.75, lat: 59.92), LonLat(lon: 10.76, lat: 59.91)])
        #expect(unknown.mode == nil, "a mode the server could not tell is left out")
        #expect(gap.from?.lat == 59.92 && gap.to == nil)
        #expect(nowhere.place == nil)
        #expect(day.segments[0].id != day.segments[4].id)
    }

    @Test func rawPointsKeepTheirExactMicroseconds() throws {
        let points = try decode(DayPointsResponse.self, """
        {"date":"2026-10-22","devices":["iPhone","iPad"],"points":[[1790000000123456,10.75,59.92,0,0],[1790000000123457,10.76,59.93,1,2]]}
        """)
        #expect(points.points[0].t == 1_790_000_000_123_456)
        #expect(points.points[1].device == 1 && points.points[1].status == .glitch)
        let body = try JSONEncoder().encode(["points": [PointRef(device: "iPhone", t: points.points[0].t)]])
        #expect(String(decoding: body, as: UTF8.self).contains("1790000000123456"))
    }

    @Test func heatCellsAreTriples() throws {
        let heat = try decode(HeatResponse.self, #"{"maxSeconds":3600,"cells":[[10.757,59.922,3600],[10.758,59.923,60]]}"#)
        #expect(heat.cells.count == 2 && heat.cells[0].seconds == 3600)
    }

    @Test func aTripOfTheList() throws {
        let trips = try decode(TripsResponse.self, """
        {"trips":[{"id":"2026-09-12","name":"Lisbon & Porto","firstNight":"2026-09-12","lastNight":"2026-09-18","nights":7,
          "start":"2026-09-12T04:05:00Z","end":null,"startTimeZone":"Europe/Oslo","endTimeZone":"Europe/Lisbon",
          "localStartDate":"2026-09-12","localEndDate":"2026-09-19","ongoing":true,
          "cities":[{"name":"Lisbon","country":"Portugal","nights":3,"lat":38.71,"lon":-9.13}],
          "edited":false,"ownName":null,"startEdited":false,"endEdited":false,"thumbnail":[[10.75,59.92],[-9.13,38.71]]}]}
        """)
        let trip = try #require(trips.trips.first)
        #expect(trip.ongoing && trip.end == nil && trip.ownName == nil)
        #expect(trip.thumbnail.count == 2 && trip.cities.first?.nights == 3)
    }

    @Test func editsWriteTheirNullsOut() throws {
        let edit = String(decoding: try JSONEncoder().encode(EditTripRequest(name: nil, startDate: LocalDate("2026-09-10"), endDate: nil)), as: UTF8.self)
        #expect(edit.contains("\"name\":null") && edit.contains("\"endDate\":null") && edit.contains("\"startDate\":\"2026-09-10\""))
        let home = String(decoding: try JSONEncoder().encode(AddHomeRequest(placeId: 53, from: LocalDate("2025-10-18")!, to: nil)), as: UTF8.self)
        #expect(home.contains("\"to\":null") && home.contains("\"placeId\":53"))
    }

    @Test func statusAndSettings() throws {
        let status = try decode(StatusResponse.self, """
        {"algorithmVersion":null,"backfill":{"from":null,"to":null,"cursor":null,"percent":42,"paused":false},"pendingRanges":3,
         "failedRanges":[{"from":"2024-03-02T00:00:00Z","to":"2024-03-09T00:00:00Z","attempts":3,"lastError":"timeout"}],
         "lastRunAt":null,"lastError":null,"places":{"total":10,"unnamed":2,"failed":0},"warnings":["OVERLAND_TOKEN is not set"]}
        """)
        #expect(status.backfill.percent == 42 && status.failedRanges.first?.attempts == 3 && status.warnings.count == 1)
        let settings = try decode(SettingsResponse.self, #"{"tripMinDistanceKm":80,"tripMinDistanceKmDefault":50}"#)
        #expect(settings.tripMinDistanceKm == 80)
    }
}
