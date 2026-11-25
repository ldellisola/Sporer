import SwiftUI
import Charts

/// Distance per day (per week for a long range, per month for a year) as bars in the app's own colour, not a mode's.
/// Tap a bar to read its figure; tap it again, or the empty plot, to let go. (A drag would fight the sheet's scrolling.)
struct DistanceChart: View {
    let period: ExplorePeriod
    let days: [RangeDay]
    @State private var selectedID: LocalDate?

    private var buckets: [DistanceBucket] { DistanceBucket.buckets(for: period, days: days) }

    private var unitName: String {
        switch buckets.first?.unit ?? .day { case .day: "day"; case .week: "week"; case .month: "month" }
    }

    var body: some View {
        let buckets = buckets
        let top = buckets.first { $0.id == selectedID }
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text("Distance").font(.headline)
                Spacer(minLength: 8)
                Text(top.map { "\($0.label) · \(Format.distance($0.meters))" } ?? "Per \(unitName)")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.trailing)
            }
            .accessibilityAddTraits(.isHeader)
            Chart(buckets) { bucket in
                BarMark(x: .value("Date", bucket.date, unit: bucket.calendarUnit),
                        y: .value("Distance (km)", bucket.kilometers))
                    .foregroundStyle(Color.pin.gradient)
                    .opacity(top == nil || top == bucket ? 1 : 0.35)
                    .cornerRadius(3)
                    .accessibilityLabel(bucket.label)
                    .accessibilityValue(Format.distance(bucket.meters))
            }
            .chartXScale(domain: domain(buckets))
            .chartXAxis { xAxis(buckets) }
            .chartYAxis {
                AxisMarks(position: .trailing, values: .automatic(desiredCount: 3)) { value in
                    AxisGridLine()
                    AxisValueLabel {
                        if let km = value.as(Double.self) { Text(ExploreFormat.axisKm(km)) }
                    }
                }
            }
            .chartOverlay { proxy in
                GeometryReader { geo in
                    Color.clear
                        .contentShape(.rect)
                        .onTapGesture { location in select(at: location, proxy: proxy, geo: geo, buckets: buckets) }
                }
                .accessibilityHidden(true)
            }
            .environment(\.calendar, LocalDate.calendar())
            .environment(\.timeZone, TimeZone(identifier: "UTC")!)
            .environment(\.locale, Locale(identifier: "en_GB"))
            .frame(minHeight: 150, idealHeight: 170)
            .animation(.snappy, value: selectedID)
        }
        .padding(16)
        .background(.background.secondary, in: .rect(cornerRadius: 20))
        .onChange(of: period) { selectedID = nil }
        .onChange(of: days) { selectedID = nil }
    }

    private func select(at location: CGPoint, proxy: ChartProxy, geo: GeometryProxy, buckets: [DistanceBucket]) {
        guard let frame = proxy.plotFrame else { return }
        let plot = geo[frame]
        guard plot.contains(location), let date: Date = proxy.value(atX: location.x - plot.origin.x) else {
            selectedID = nil
            return
        }
        let hit = buckets.last { $0.date <= date }?.id
        selectedID = hit == selectedID ? nil : hit
    }

    private func domain(_ buckets: [DistanceBucket]) -> ClosedRange<Date> {
        let cal = LocalDate.calendar()
        let first = buckets.first?.date ?? period.from.noonUTC
        let last = buckets.last.flatMap { cal.date(byAdding: $0.calendarUnit, value: 1, to: $0.date) } ?? first.addingTimeInterval(86_400)
        return first...last
    }

    @AxisContentBuilder private func xAxis(_ buckets: [DistanceBucket]) -> some AxisContent {
        switch buckets.first?.unit ?? .day {
        case .month:
            AxisMarks(values: .stride(by: .month)) { _ in
                AxisValueLabel(format: .dateTime.month(.narrow), centered: true)
            }
        case .week:
            AxisMarks(values: .automatic(desiredCount: 4)) { _ in
                AxisGridLine()
                AxisValueLabel(format: .dateTime.day().month(.abbreviated))
            }
        case .day where buckets.count <= 7:
            AxisMarks(values: .stride(by: .day)) { _ in
                AxisValueLabel(format: .dateTime.weekday(.abbreviated), centered: true)
            }
        case .day:
            AxisMarks(values: .stride(by: .day, count: buckets.count > 31 ? 14 : 7)) { _ in
                AxisGridLine()
                AxisValueLabel(format: .dateTime.day().month(.abbreviated))
            }
        }
    }
}
