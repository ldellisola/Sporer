import SwiftUI

nonisolated enum TripLoad: Sendable {
    case found(TripResponse)
    case gone
}

/// One trip: what it adds up to, its cities and its days, beside the map that draws its routes.
struct TripDetailView: View {
    let tripID: String

    init(tripID: String) {
        self.tripID = tripID
    }

    var body: some View {
        // Remade per trip, so nothing is carried from one to the next.
        TripDetailBody(tripID: tripID).id(tripID)
    }
}

private struct TripDetailBody: View {
    @Environment(\.appModel) private var app
    let tripID: String
    private let revision = TripsRevision.shared

    private struct LoadKey: Hashable { var id: String; var revision: Int; var data: Int }

    var body: some View {
        Loaded(id: LoadKey(id: tripID, revision: revision.value, data: app.dataVersion), load: { @Sendable [service = app.service, tripID] () async throws -> TripLoad in
            do {
                return .found(try await service.trip(tripID))
            } catch ServiceError.notFound {
                return .gone
            }
        }, content: { result, isStale in
            switch result {
            case .found(let trip):
                TripFound(trip: trip, isStale: isStale)
            case .gone:
                TripGone(tripID: tripID)
                    .navigationTitle("Trip")
                    .navigationBarTitleDisplayMode(.inline)
            }
        }, placeholder: {
            ProgressView {
                Text("Loading Trip\u{2026}")
            }
            .controlSize(.large)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .navigationTitle("Trip")
            .navigationBarTitleDisplayMode(.inline)
        })
        .task(id: revision.value) {
            if let list = try? await app.service.trips() { revision.cache = list }
        }
    }
}

/// A trip that has loaded: its content, and the title, menu and sheets that act on it.
private struct TripFound: View {
    @Environment(\.appModel) private var app
    let trip: TripResponse
    let isStale: Bool
    private let revision = TripsRevision.shared

    @State private var isEditing = false
    @State private var isConfirmingDelete = false

    var body: some View {
        TripContent(trip: trip, isStale: isStale)
            .mapScene(isStale ? nil : .trip(trip))
            .navigationTitle(trip.name)
            .navigationSubtitle(Format.span(trip.localStartDate, trip.localEndDate))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbar }
            .sheet(isPresented: $isEditing) {
                TripEditSheet(trip: trip, onSaved: saved, onGone: { revision.bump() })
            }
            .tripsDebugFlags(isEditing: $isEditing, isConfirmingDelete: $isConfirmingDelete)
    }

    // MARK: Neighbours

    private var neighbours: [TripListItem] { revision.visible }
    private var index: Int? { neighbours.firstIndex { $0.id == trip.id } }
    /// The list is newest first: older is further down.
    private var older: TripListItem? { index.flatMap { neighbours.indices.contains($0 + 1) ? neighbours[$0 + 1] : nil } }
    private var newer: TripListItem? { index.flatMap { $0 > 0 ? neighbours[$0 - 1] : nil } }

    private func step(to other: TripListItem?) {
        guard let other else { return }
        app.replaceTrip(trip.id, with: other.id)
    }

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                Button("Edit Trip", systemImage: "pencil") { isEditing = true }
                    .disabled(isStale)
                Button("Delete Trip", systemImage: "trash", role: .destructive) { isConfirmingDelete = true }
                    .disabled(isStale)
                Section {
                    Button("Older Trip", systemImage: "chevron.left") { step(to: older) }
                        .keyboardShortcut(.leftArrow, modifiers: [])
                        .disabled(older == nil)
                    Button("Newer Trip", systemImage: "chevron.right") { step(to: newer) }
                        .keyboardShortcut(.rightArrow, modifiers: [])
                        .disabled(newer == nil)
                }
            } label: {
                Label("More", systemImage: "ellipsis")
            }
            .confirmationDialog("Delete \u{201C}\(trip.name)\u{201D}?", isPresented: $isConfirmingDelete, titleVisibility: .visible) {
                Button("Delete Trip", role: .destructive, action: delete)
                Button("Cancel", role: .cancel) {}
            } message: {
                Text(TripActions.deleteMessage)
            }
        }
    }

    // MARK: Writes

    private func saved(_ response: EditTripResponse) {
        revision.bump()
        app.toasts.show(Toast(message: "Trip updated"))
        if response.id != trip.id {
            revision.rename(trip.id, to: response.id)
            app.replaceTrip(trip.id, with: response.id)
        }
    }

    private func delete() {
        let id = trip.id, name = trip.name, app = app
        // Leave the page first, so it never loads a trip that is already gone.
        app.popTrip(id)
        Task {
            do {
                try await TripActions.delete(id: id, name: name, app: app)
            } catch {
                if case ServiceError.notFound = error { TripsRevision.shared.bump() }
                app.toasts.show(Toast(message: "Couldn't delete \(name). \(TripActions.message(for: error))", symbol: "exclamationmark.triangle.fill"))
            }
        }
    }
}

// MARK: - Content

private struct TripContent: View {
    @Environment(\.appModel) private var app
    let trip: TripResponse
    let isStale: Bool
    @Environment(\.dynamicTypeSize) private var typeSize

    private var summary: String {
        [Format.count(trip.nights, "night"), Format.count(trip.stats.flights, "flight"), Format.count(trip.stats.cities, "city", "cities")]
            .joined(separator: " · ")
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack(spacing: 8) {
                    Text(summary).font(.subheadline).foregroundStyle(.secondary)
                    if trip.ongoing { OngoingCapsule() }
                }
                stats
                cities
                days
            }
            .panelPadding()
            .padding(.bottom, 24)
            .opacity(isStale ? 0.55 : 1)
            .animation(.default, value: isStale)
        }
        .scrollEdgeEffectStyle(.soft, for: .top)
    }

    @ViewBuilder private var stats: some View {
        let first = [
            Stat(value: "\(trip.nights)", label: trip.nights == 1 ? "Night" : "Nights", symbol: "moon.fill", tint: .indigo),
            Stat(value: "\(trip.stats.flights)", label: trip.stats.flights == 1 ? "Flight" : "Flights", symbol: "airplane", tint: ModeStyle(mode: .flight).color),
            Stat(value: "\(trip.stats.cities)", label: trip.stats.cities == 1 ? "City" : "Cities", symbol: "building.2.fill", tint: .pin),
        ]
        let second = [
            Stat(value: Format.distance(trip.stats.groundDistanceMeters), label: "On the Ground", symbol: "point.topleft.down.to.point.bottomright.curvepath", tint: .blue),
            Stat(value: "\(trip.stats.places)", label: trip.stats.places == 1 ? "Place" : "Places", symbol: "mappin", tint: .pin),
        ]
        if typeSize.isAccessibilitySize {
            ForEach(first + second) { StatStrip(stats: [$0]) }
        } else {
            StatStrip(stats: first)
            StatStrip(stats: second)
        }
    }

    @ViewBuilder private var cities: some View {
        if !trip.cities.isEmpty {
            PanelSectionHeader(title: "Cities")
            VStack(spacing: 0) {
                ForEach(Array(trip.cities.enumerated()), id: \.offset) { index, city in
                    if index > 0 { Divider() }
                    HStack(alignment: .firstTextBaseline) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(city.name).font(.body.weight(.medium))
                            if let country = city.country {
                                Text(country).font(.subheadline).foregroundStyle(.secondary)
                            }
                        }
                        Spacer(minLength: 8)
                        Text(Format.count(city.nights, "night"))
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 8)
                    .accessibilityElement(children: .combine)
                }
            }
        }
    }

    @ViewBuilder private var days: some View {
        PanelSectionHeader(title: "Day by Day", trailing: trip.days.isEmpty ? nil : Format.count(trip.days.count, "day"))
        if trip.days.isEmpty {
            Text("No days to show for this trip.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        } else {
            VStack(spacing: 0) {
                ForEach(Array(trip.days.enumerated()), id: \.element.id) { index, day in
                    if index > 0 { Divider() }
                    DayRow(day: day) { app.open(.day(day.date)) }
                }
            }
        }
    }
}

private struct DayRow: View {
    let day: TripDay
    var open: () -> Void

    private var label: String {
        var parts = [Format.shortDay(day.date), day.description]
        if !day.highlights.isEmpty { parts.append(day.highlights.prefix(3).joined(separator: ", ")) }
        if day.groundDistanceMeters > 0 { parts.append(Format.distance(day.groundDistanceMeters) + " on the ground") }
        if day.flights > 0 { parts.append(Format.count(day.flights, "flight")) }
        return parts.joined(separator: ", ")
    }

    var body: some View {
        Button(action: open) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(Format.shortDay(day.date)).font(.caption.weight(.medium)).foregroundStyle(.secondary)
                    Text(day.description).font(.headline)
                    if !day.highlights.isEmpty {
                        Text(day.highlights.prefix(3).joined(separator: ", "))
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                }
                Spacer(minLength: 8)
                VStack(alignment: .trailing, spacing: 4) {
                    if day.groundDistanceMeters > 0 {
                        Text(Format.distance(day.groundDistanceMeters))
                            .font(.subheadline)
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                    }
                    if day.flights > 0 {
                        Label("\(day.flights)", systemImage: "airplane")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(ModeStyle(mode: .flight).color)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 2)
                            .background(ModeStyle(mode: .flight).color.opacity(0.16), in: .capsule)
                            .accessibilityLabel(Format.count(day.flights, "flight"))
                    }
                }
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.tertiary)
                    .padding(.top, 4)
                    .accessibilityHidden(true)
            }
            .padding(.vertical, 8)
            .contentShape(.rect)
        }
        .buttonStyle(RowButtonStyle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel(label)
    }
}

private struct TripGone: View {
    @Environment(\.appModel) private var app
    let tripID: String

    var body: some View {
        ContentUnavailableView {
            Label("This Trip No Longer Exists", systemImage: "suitcase")
        } description: {
            Text("It may have been deleted or its dates may have changed.")
        } actions: {
            Button("Go Back") { app.popTrip(tripID) }
                .buttonStyle(.borderedProminent)
        }
    }
}
