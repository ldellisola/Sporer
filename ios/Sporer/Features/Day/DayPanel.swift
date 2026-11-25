import SwiftUI

/// One day of the timeline: what it adds up to, and its stays, moves and gaps in order, beside the map that draws them.
/// The Day tab's own panel steps through days; a day opened from a period, a trip or a place is pinned to its date
/// but can still be stepped.
struct DayPanel: View {
    @Environment(\.appModel) private var app
    /// nil for the Day tab, whose date is the app's.
    let pinned: LocalDate?
    @State private var ownDate: LocalDate
    @State private var isPickingDate = false
    @State private var shown: DayResponse?

    init(pinned: LocalDate?) {
        self.pinned = pinned
        _ownDate = State(initialValue: pinned ?? .today)
    }

    private var date: LocalDate { pinned == nil ? app.day : ownDate }

    private func setDate(_ new: LocalDate) {
        let clamped = min(new, .today)
        if pinned == nil { app.day = clamped } else { ownDate = clamped }
    }

    private var isEditing: Bool { app.map.editing?.date == date }

    var body: some View {
        Group {
            if isEditing, let editing = app.map.editing {
                EditPointsPanel(editing: editing, day: shown)
                    .mapScene(shown.map { .day($0) })
                    .task(id: "\(date)|\(app.dataVersion)|\(app.wakeCount)") {
                        // Edit mode draws its points over the day's routes: the day is loaded again after every removal or Undo
                        // (they change the data version), and kept fresh while the server rebuilds it, as the Day view is.
                        while !Task.isCancelled {
                            if let day = try? await app.service.day(date), !Task.isCancelled { shown = day }
                            guard let day = shown, day.date == date, let interval = app.refreshInterval(for: day) else { return }
                            try? await Task.sleep(for: interval)
                        }
                    }
            } else {
                Loaded(id: [date.description, "\(app.dataVersion)"], refresh: { [app] in app.refreshInterval(for: $0) },
                       load: { [service = app.service, date] in try await service.day(date) }) { day, isStale in
                    DayContent(day: day, isStale: isStale)
                        .mapScene(isStale ? nil : .day(day))
                        .onAppear { shown = day }
                        .onChange(of: day) { shown = day }
                } placeholder: {
                    DaySkeleton()
                }
                .navigationTitle(Format.dayTitle(date))
                .navigationSubtitle(Format.dayDate(date))
                .toolbarTitleMenu { titleMenu }
                .toolbar { toolbar }
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .onChange(of: date) {
            // Leaving the day ends its edit mode.
            if app.map.editing != nil, app.map.editing?.date != date { app.map.editing = nil }
        }
    }

    // Separate items on iOS (adjacent items share one glass capsule anyway). On the Mac, one item: AppKit wraps adjacent items
    // in a group of its own (and so does a ToolbarItemGroup), whose constraints crash the Mac Catalyst toolbar on macOS 27.
    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        #if targetEnvironment(macCatalyst)
        ToolbarItem(placement: .topBarTrailing) {
            HStack(spacing: 4) {
                previousButton
                nextButton
                calendarButton
            }
        }
        #else
        ToolbarItem(placement: .topBarTrailing) { previousButton }
        ToolbarItem(placement: .topBarTrailing) { nextButton }
        ToolbarSpacer(.fixed, placement: .topBarTrailing)
        ToolbarItem(placement: .topBarTrailing) { calendarButton }
        #endif
    }

    private var previousButton: some View {
        Button {
            setDate(date.adding(days: -1))
        } label: {
            Label("Previous Day", systemImage: "chevron.left")
        }
    }

    private var nextButton: some View {
        Button {
            setDate(date.adding(days: 1))
        } label: {
            Label("Next Day", systemImage: "chevron.right")
        }
        .disabled(date >= .today)
    }

    private var calendarButton: some View {
        Button {
            isPickingDate = true
        } label: {
            Label("Choose Date", systemImage: "calendar")
        }
        .popover(isPresented: $isPickingDate) {
            DatePicker("Date", selection: Binding(get: { date.noonUTC }, set: { setDate(LocalDate($0, in: TimeZone(identifier: "UTC")!)); isPickingDate = false }),
                       in: ...LocalDate.today.noonUTC, displayedComponents: .date)
                .datePickerStyle(.graphical)
                .environment(\.timeZone, TimeZone(identifier: "UTC")!)
                .frame(width: 320)
                .padding()
                .presentationCompactAdaptation(.popover)
        }
    }

    @ViewBuilder private var titleMenu: some View {
        if date != .today {
            Button("Go to Today", systemImage: "arrow.uturn.forward") { setDate(.today) }
        }
        Button("Edit Points", systemImage: "point.3.filled.connected.trianglepath.dotted") {
            app.map.editing = EditPointsModel(date: date)
            app.detent = SheetDetents.peek
        }
        .disabled(shown?.segments.isEmpty ?? true)
        Divider()
        Button("Show Week", systemImage: "calendar.day.timeline.left") { openPeriod(.week) }
        Button("Show Month", systemImage: "calendar") { openPeriod(.month) }
    }

    private func openPeriod(_ scale: PeriodScale) {
        app.exploreScale = scale
        app.exploreAnchor = date
        app.paths[.explore] = []
        app.section = .explore
    }
}

/// The figures and the timeline of a loaded day.
private struct DayContent: View {
    @Environment(\.appModel) private var app
    let day: DayResponse
    let isStale: Bool

    var body: some View {
        if day.segments.isEmpty {
            ContentUnavailableView {
                Label("No Data", systemImage: "location.slash")
            } description: {
                Text("Nothing was recorded on \(Format.shortDay(day.date, withYear: true)).")
            }
            .opacity(isStale ? 0.5 : 1)
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if day.state == .pending {
                        PendingBadge()
                    }
                    StatStrip(stats: [
                        Stat(value: "\(day.summary.places)", label: day.summary.places == 1 ? "Place" : "Places", symbol: "mappin", tint: .pin),
                        Stat(value: Format.distance(day.summary.distanceMeters), label: "Distance", symbol: "point.topleft.down.to.point.bottomright.curvepath", tint: .blue),
                        Stat(value: Format.duration(day.summary.movingSeconds), label: "Moving", symbol: "figure.walk", tint: .green),
                    ])
                    TimelineList(day: day)
                }
                .panelPadding()
                .padding(.bottom, 24)
                .opacity(isStale ? 0.55 : 1)
                .animation(.default, value: isStale)
            }
            .scrollEdgeEffectStyle(.soft, for: .top)
        }
    }
}

/// What a day looks like before it has loaded.
private struct DaySkeleton: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                StatStrip(stats: [
                    Stat(value: "6", label: "Places", symbol: "mappin"),
                    Stat(value: "7.9 km", label: "Distance", symbol: "point.topleft.down.to.point.bottomright.curvepath"),
                    Stat(value: "1h 2m", label: "Moving", symbol: "figure.walk"),
                ])
                ForEach(0..<5, id: \.self) { _ in
                    HStack(spacing: 14) {
                        Circle().frame(width: 30, height: 30)
                        VStack(alignment: .leading, spacing: 4) {
                            Text("A place with a name")
                            Text("08:25 – 11:55 · 3h 30m").font(.subheadline)
                        }
                    }
                    .padding(.vertical, 8)
                }
            }
            .panelPadding()
            .redacted(reason: .placeholder)
        }
        .scrollDisabled(true)
        .accessibilityLabel("Loading")
    }
}

