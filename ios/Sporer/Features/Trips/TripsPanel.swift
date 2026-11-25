import SwiftUI

/// The Trips tab: every trip, a year at a time, newest first.
struct TripsPanel: View {
    @Environment(\.appModel) private var app
    private let revision = TripsRevision.shared

    var body: some View {
        Loaded(id: [revision.value, app.dataVersion], load: { [service = app.service] in try await service.trips() }) { trips, isStale in
            TripsList(trips: trips)
                .onAppear { revision.cache = trips }
                .onChange(of: trips) { revision.cache = trips }
                .opacity(isStale ? 0.55 : 1)
                .mapScene(isStale ? nil : .trips(trips))
        }
        .navigationTitle("Trips")
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct TripsList: View {
    @Environment(\.appModel) private var app
    let trips: [TripListItem]
    @State private var failure: String?

    private var years: [(year: Int, trips: [TripListItem])] {
        Dictionary(grouping: trips, by: { $0.localStartDate.year })
            .map { ($0.key, $0.value.sorted { $0.localStartDate > $1.localStartDate }) }
            .sorted { $0.0 > $1.0 }
    }

    private var subtitle: String {
        guard !trips.isEmpty else { return "" }
        return "\(Format.count(trips.count, "trip")) · \(Format.count(trips.reduce(0) { $0 + $1.nights }, "night"))"
    }

    private let revision = TripsRevision.shared

    var body: some View {
        Group {
            if trips.isEmpty {
                NoTripsYet()
            } else {
                List {
                    ForEach(years, id: \.year) { group in
                        Section {
                            ForEach(group.trips) { trip in
                                TripRow(trip: trip, delete: { delete(trip) })
                            }
                        } header: {
                            Text(String(group.year))
                        }
                    }
                }
                .listStyle(.insetGrouped)
                .refreshable { revision.bump() }
            }
        }
        .navigationSubtitle(subtitle)
        .alert("Couldn't Delete Trip", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(failure ?? "")
        }
    }

    private func delete(_ trip: TripListItem) {
        Task {
            do { try await TripActions.delete(id: trip.id, name: trip.name, app: app) }
            catch {
                failure = TripActions.message(for: error)
                // A trip that is already gone should leave the list.
                if case ServiceError.notFound = error { revision.bump() }
            }
        }
    }
}

private struct TripRow: View {
    let trip: TripListItem
    var delete: () -> Void
    @State private var isConfirming = false
    @ScaledMetric(relativeTo: .body) private var tile = 56

    private var span: String { Format.span(trip.localStartDate, trip.localEndDate) }
    private var nights: String { Format.count(trip.nights, "night") }
    /// The cities, unless they only say again what the name says ("Tokyo", in Tokyo).
    private var cities: String {
        let names = trip.cities.map(\.name).joined(separator: " · ")
        return names == trip.name ? "" : names
    }

    private var label: String {
        [trip.name, trip.ongoing ? "Ongoing" : nil, span, nights, cities.isEmpty ? nil : cities]
            .compactMap { $0 }.joined(separator: ", ")
    }

    var body: some View {
        NavigationLink(value: Route.trip(trip.id)) {
            HStack(spacing: 14) {
                TripThumbnail(points: trip.thumbnail, ongoing: trip.ongoing, size: CGSize(width: tile * 4 / 3, height: tile))
                VStack(alignment: .leading, spacing: 2) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(trip.name).font(.headline)
                        if trip.ongoing { OngoingCapsule() }
                    }
                    ViewThatFits(in: .horizontal) {
                        Text("\(span) · \(nights)")
                        VStack(alignment: .leading, spacing: 0) {
                            Text(span)
                            Text(nights)
                        }
                    }
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    if !cities.isEmpty {
                        Text(cities).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                    }
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(label)
        .accessibilityAction(named: "Delete Trip") { isConfirming = true }
        .swipeActions(edge: .trailing) {
            Button("Delete", systemImage: "trash", role: .destructive) { isConfirming = true }
        }
        .contextMenu {
            Button("Delete Trip", systemImage: "trash", role: .destructive) { isConfirming = true }
        }
        .confirmationDialog("Delete \u{201C}\(trip.name)\u{201D}?", isPresented: $isConfirming, titleVisibility: .visible) {
            Button("Delete Trip", role: .destructive, action: delete)
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(TripActions.deleteMessage)
        }
    }
}

struct OngoingCapsule: View {
    var body: some View {
        Text("Ongoing")
            .font(.caption.weight(.semibold))
            .foregroundStyle(.green.mix(with: .primary, by: 0.25))
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .background(.green.opacity(0.16), in: .capsule)
    }
}

private struct NoTripsYet: View {
    @Environment(\.appModel) private var app
    @State private var km: Double?

    var body: some View {
        ContentUnavailableView {
            Label("No Trips Yet", systemImage: "suitcase")
        } description: {
            Text("A trip is a night spent \(km.map(Format.km) ?? "far") or more from home.")
        }
        .task { km = try? await app.service.settings().tripMinDistanceKm }
    }
}
