import SwiftUI

/// What the calendar button opens: a day for a week, a month and a year wheel for a month, a year wheel for a year,
/// and From and To dates (committed with Show Range) for a range. Each has its shortcut back to now.
struct ExploreDatePopover: View {
    @Environment(\.appModel) private var app
    let period: ExplorePeriod
    var dismiss: () -> Void

    private let utc = TimeZone(identifier: "UTC")!

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            switch period.scale {
            case .week:
                DatePicker("Date", selection: anchorBinding, in: ...LocalDate.today.noonUTC, displayedComponents: .date)
                    .datePickerStyle(.graphical)
                    .labelsHidden()
            case .month, .year:
                MonthYearWheels(showsMonth: period.scale == .month, anchor: Binding(get: { app.exploreAnchor }, set: { app.exploreAnchor = $0 }))
            case .range:
                RangeDraftForm(period: period, dismiss: dismiss)
            }
            if period.scale != .range {
                Button(period.currentTitle) {
                    app.exploreAnchor = .today
                    dismiss()
                }
                .buttonStyle(.glass)
                .frame(maxWidth: .infinity)
                .disabled(period.isCurrent)
            }
        }
        .environment(\.timeZone, utc)
        .frame(maxWidth: 320)
        .padding()
        .presentationCompactAdaptation(.popover)
    }

    private var anchorBinding: Binding<Date> {
        Binding(
            get: { app.exploreAnchor.noonUTC },
            set: {
                app.exploreAnchor = min(LocalDate($0, in: utc), .today)
                dismiss()
            }
        )
    }
}

/// A month wheel and a year wheel (or the year alone), never past the current month.
private struct MonthYearWheels: View {
    let showsMonth: Bool
    @Binding var anchor: LocalDate

    private static let months = Calendar(identifier: .gregorian).standaloneMonthSymbols
    private var years: [Int] { Array((LocalDate.today.year - 25)...LocalDate.today.year) }

    var body: some View {
        HStack(spacing: 0) {
            if showsMonth {
                Picker("Month", selection: month) {
                    ForEach(1...12, id: \.self) { Text(Self.months[$0 - 1]).tag($0) }
                }
            }
            Picker("Year", selection: year) {
                ForEach(years, id: \.self) { Text(String($0)).tag($0) }
            }
        }
        .pickerStyle(.wheel)
        .labelsHidden()
        .frame(height: 150)
    }

    private var month: Binding<Int> {
        Binding(get: { anchor.month }, set: { anchor = min(LocalDate(year: anchor.year, month: $0, day: 1), .today) })
    }

    private var year: Binding<Int> {
        Binding(get: { anchor.year }, set: { anchor = min(LocalDate(year: $0, month: showsMonth ? anchor.month : 1, day: 1), .today) })
    }
}

/// From and To of a range, edited as a draft: nothing loads until Show Range. The pickers only offer valid dates, so the
/// range ends no later than today, starts no later than it ends and covers at most 400 days.
private struct RangeDraftForm: View {
    @Environment(\.appModel) private var app
    let period: ExplorePeriod
    var dismiss: () -> Void

    @State private var from: LocalDate
    @State private var to: LocalDate

    private static let maxDays = 400
    private let utc = TimeZone(identifier: "UTC")!

    init(period: ExplorePeriod, dismiss: @escaping () -> Void) {
        self.period = period
        self.dismiss = dismiss
        _from = State(initialValue: period.from)
        _to = State(initialValue: period.to)
    }

    private var days: Int { from.days(to: to) + 1 }
    private var problem: String? {
        if to > .today { return "A range ends no later than today." }
        if to < from { return "The end comes before the start." }
        if days > Self.maxDays { return "A range covers up to \(Self.maxDays) days." }
        return nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            DatePicker("From", selection: fromBinding, in: to.adding(days: 1 - Self.maxDays).noonUTC...to.noonUTC, displayedComponents: .date)
            DatePicker("To", selection: toBinding, in: from.noonUTC...min(LocalDate.today, from.adding(days: Self.maxDays - 1)).noonUTC, displayedComponents: .date)
            Text(problem ?? "\(Format.count(days, "day")). A range covers up to \(Self.maxDays) days.")
                .font(.footnote)
                .foregroundStyle(problem == nil ? Color.secondary : Color.red)
            HStack {
                Button("Cancel", role: .cancel) { dismiss() }
                    .buttonStyle(.glass)
                Spacer()
                Button("Show Range") {
                    app.exploreRange = from...to
                    dismiss()
                }
                .buttonStyle(.glassProminent)
                .disabled(problem != nil)
            }
        }
    }

    private var fromBinding: Binding<Date> {
        Binding(get: { from.noonUTC }, set: { from = LocalDate($0, in: utc) })
    }

    private var toBinding: Binding<Date> {
        Binding(get: { to.noonUTC }, set: { to = LocalDate($0, in: utc) })
    }
}
