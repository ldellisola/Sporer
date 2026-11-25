import SwiftUI

/// A week, month, year or range of the timeline: what it adds up to, where the time went and the days in it,
/// beside the map that draws its routes.
struct ExplorePanel: View {
    @Environment(\.appModel) private var app
    @State private var isPickingDate = false
    @State private var shown: RangeResponse?

    private var period: ExplorePeriod {
        ExplorePeriod(scale: app.exploreScale, anchor: app.exploreAnchor, range: app.exploreRange)
    }

    /// The headline figure of what is shown, which is all there is to see at the peek detent.
    private var subtitle: String {
        guard let shown, shown.from == period.from, shown.to == period.to else { return "Loading…" }
        if shown.places.isEmpty && shown.days.isEmpty { return shown.state == .pending ? "Updating…" : "No Data" }
        let figure = "\(Format.distance(shown.summary.distanceMeters)) · \(Format.count(shown.summary.places, "place"))"
        return shown.state == .pending ? figure + " · Updating…" : figure
    }

    var body: some View {
        let period = period
        ScrollView {
            Loaded(id: [AnyHashable(period), AnyHashable(app.dataVersion)],
                   refresh: { [app] in app.refreshInterval(from: period.from, to: period.to, state: $0.state) },
                   load: { [service = app.service] in
                #if DEBUG
                if ProcessInfo.processInfo.arguments.contains("-exploreFail") { throw URLError(.notConnectedToInternet) }
                #endif
                return try await service.range(from: period.from, to: period.to)
            }) { range, isStale in
                ExploreLive(period: period, loaded: range, isStale: isStale, shown: $shown)
            } placeholder: {
                ExploreSkeleton()
            }
            .panelPadding()
            .padding(.bottom, 24)
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            Picker("Period", selection: scaleBinding) {
                ForEach(PeriodScale.allCases) { Text($0.title).tag($0) }
            }
            .pickerStyle(.segmented)
            .panelPadding()
            .padding(.bottom, 8)
        }
        .scrollEdgeEffectStyle(.soft, for: .top)
        .navigationTitle(period.title)
        .navigationSubtitle(subtitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarTitleMenu { titleMenu(period) }
        .toolbar { toolbar(period) }
        .onAppear {
            #if DEBUG
            if ProcessInfo.processInfo.arguments.contains("-explorePicker") { isPickingDate = true }
            #endif
        }
    }

    private var scaleBinding: Binding<PeriodScale> {
        Binding(get: { app.exploreScale }, set: { app.exploreScale = $0 })
    }

    // Separate items on iOS (adjacent items share one glass capsule anyway). On the Mac, one item: AppKit wraps adjacent items
    // in a group of its own, whose constraints crash the toolbar on macOS 27 (see DayPanel).
    @ToolbarContentBuilder private func toolbar(_ period: ExplorePeriod) -> some ToolbarContent {
        #if targetEnvironment(macCatalyst)
        ToolbarItem(placement: .topBarTrailing) {
            HStack(spacing: 4) {
                previousButton(period)
                nextButton(period)
                calendarButton(period)
            }
        }
        #else
        ToolbarItem(placement: .topBarTrailing) { previousButton(period) }
        ToolbarItem(placement: .topBarTrailing) { nextButton(period) }
        ToolbarSpacer(.fixed, placement: .topBarTrailing)
        ToolbarItem(placement: .topBarTrailing) { calendarButton(period) }
        #endif
    }

    private func previousButton(_ period: ExplorePeriod) -> some View {
        Button {
            move(period, by: -1)
        } label: {
            Label("Previous \(period.scale.title)", systemImage: "chevron.left")
                .labelStyle(.iconOnly)
        }
        .keyboardShortcut(.leftArrow, modifiers: [])
    }

    private func nextButton(_ period: ExplorePeriod) -> some View {
        Button {
            move(period, by: 1)
        } label: {
            Label("Next \(period.scale.title)", systemImage: "chevron.right")
                .labelStyle(.iconOnly)
        }
        .keyboardShortcut(.rightArrow, modifiers: [])
        .disabled(!period.hasNext)
    }

    private func calendarButton(_ period: ExplorePeriod) -> some View {
        Button {
            isPickingDate = true
        } label: {
            Label(period.scale == .range ? "Choose Dates" : "Choose Date", systemImage: "calendar")
                .labelStyle(.iconOnly)
        }
        .popover(isPresented: $isPickingDate) {
            ExploreDatePopover(period: period) { isPickingDate = false }
        }
    }

    @ViewBuilder private func titleMenu(_ period: ExplorePeriod) -> some View {
        Button(period.currentTitle, systemImage: "arrow.uturn.forward") { goToToday(period) }
            .keyboardShortcut("t")
            .disabled(period.isCurrent)
        Picker("Show", selection: scaleBinding) {
            ForEach(PeriodScale.allCases) { Text($0.title).tag($0) }
        }
        .pickerStyle(.inline)
    }

    private func goToToday(_ period: ExplorePeriod) {
        app.exploreAnchor = .today
        if period.scale == .range {
            app.exploreRange = LocalDate.today.adding(days: 1 - period.dayCount)...LocalDate.today
        }
    }

    private func move(_ period: ExplorePeriod, by steps: Int) {
        let next = period.moved(by: steps)
        app.exploreAnchor = next.anchor
        app.exploreRange = next.range
    }
}

/// A loaded period, kept fresh by `Loaded` (every 30 s while pending, every minute while it includes today); the map follows it.
private struct ExploreLive: View {
    let period: ExplorePeriod
    let loaded: RangeResponse
    let isStale: Bool
    @Binding var shown: RangeResponse?

    var body: some View {
        ExploreContent(period: period, range: loaded, isStale: isStale)
            .mapScene(.range(loaded))
            .onAppear { shown = loaded }
            .onChange(of: loaded) { shown = loaded }
    }
}

/// The figures, the chart, the places and the days of a loaded period.
private struct ExploreContent: View {
    let period: ExplorePeriod
    let range: RangeResponse
    let isStale: Bool

    var body: some View {
        Group {
            if range.places.isEmpty && range.moves.isEmpty && range.days.isEmpty {
                ContentUnavailableView {
                    Label("No Data", systemImage: "location.slash")
                } description: {
                    Text("No data for this period.")
                } actions: {
                    if range.state == .pending { PendingBadge() }
                }
                .padding(.top, 24)
            } else {
                VStack(alignment: .leading, spacing: 20) {
                    ExploreStats(stats: [
                        Stat(value: Format.grouped(range.summary.places), label: range.summary.places == 1 ? "Place" : "Places", symbol: "mappin", tint: .pin),
                        Stat(value: Format.distance(range.summary.distanceMeters), label: "Distance", symbol: "point.topleft.down.to.point.bottomright.curvepath", tint: .blue),
                        Stat(value: ExploreFormat.duration(range.summary.movingSeconds), label: "Moving", symbol: "figure.walk", tint: .green),
                        Stat(value: Format.grouped(range.summary.moves), label: range.summary.moves == 1 ? "Move" : "Moves", symbol: "arrow.triangle.swap", tint: .orange),
                    ])
                    DistanceChart(period: period, days: range.days)
                    if !range.places.isEmpty {
                        TopPlaces(period: period, places: range.places)
                    }
                    DaysList(period: period, days: range.days)
                }
            }
        }
        .opacity(isStale ? 0.55 : 1)
        .animation(.default, value: isStale)
    }
}

/// What a period looks like before it has loaded.
private struct ExploreSkeleton: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            ExploreStats(stats: [
                Stat(value: "21", label: "Places", symbol: "mappin"),
                Stat(value: "214 km", label: "Distance", symbol: "point.topleft.down.to.point.bottomright.curvepath"),
                Stat(value: "9h 2m", label: "Moving", symbol: "figure.walk"),
                Stat(value: "60", label: "Moves", symbol: "arrow.triangle.swap"),
            ])
            RoundedRectangle(cornerRadius: 20).frame(height: 200)
            ForEach(0..<4, id: \.self) { _ in
                Text("A place with a name").padding(.vertical, 6)
            }
        }
        .redacted(reason: .placeholder)
        .accessibilityLabel("Loading")
    }
}
