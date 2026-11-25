import SwiftUI

/// One place a picker offers.
struct PickablePlace: Identifiable, Hashable {
    var id: Int
    var name: String?
    var address: String?
    /// How far it is from the place merged into, for merge candidates.
    var distanceM: Double?
    var visits: Int
}

/// Picks a place from a searchable list: the nearest places to merge with, or the most visited to set as home.
/// Presented in its own navigation stack (a sheet), with Cancel.
struct PlacePicker: View {
    let title: String
    let prompt: String
    /// Asked again, debounced, as the search text changes.
    let search: @Sendable (String) async throws -> [PickablePlace]
    var onPick: (PickablePlace) -> Void
    /// Cancel closes the sheet this is in; by default it dismisses.
    var onCancel: (() -> Void)?

    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var results: [PickablePlace]?
    @State private var error: (any Error)?
    @State private var isSearching = false

    var body: some View {
        List {
            if let error, results == nil {
                ErrorState(error: error) { Task { await run(query) } }
            } else if let results {
                if results.isEmpty {
                    if query.isEmpty {
                        ContentUnavailableView("No Places", systemImage: "mappin.slash", description: Text("There are no other places to pick yet."))
                    } else {
                        ContentUnavailableView.search(text: query)
                    }
                } else {
                    ForEach(results) { place in
                        Button {
                            onPick(place)
                        } label: {
                            PickablePlaceRow(place: place)
                        }
                        .tint(.primary)
                    }
                }
            }
        }
        .opacity(isSearching && results != nil ? 0.6 : 1)
        .overlay {
            if results == nil, error == nil { ProgressView() }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: prompt)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel", role: .cancel) { if let onCancel { onCancel() } else { dismiss() } }
            }
        }
        .task(id: query) {
            if !query.isEmpty { try? await Task.sleep(for: .milliseconds(300)) }
            guard !Task.isCancelled else { return }
            await run(query)
        }
    }

    private func run(_ q: String) async {
        isSearching = true
        defer { if !Task.isCancelled { isSearching = false } }
        do {
            let found = try await search(q)
            guard !Task.isCancelled else { return }
            results = found
            error = nil
        } catch is CancellationError {
        } catch {
            guard !Task.isCancelled else { return }
            self.error = error
        }
    }
}

struct PickablePlaceRow: View {
    let place: PickablePlace

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "mappin.circle.fill")
                .font(.title2)
                .foregroundStyle(.white, Color.pin)
            VStack(alignment: .leading, spacing: 2) {
                Text(Format.placeName(place.name))
                    .font(.body.weight(.medium))
                    .foregroundStyle(place.name == nil ? .secondary : .primary)
                let detail = [place.address, place.distanceM.map { Format.distance($0) + " away" }, Format.count(place.visits, "visit")]
                    .compactMap { $0 }.joined(separator: " · ")
                Text(detail)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
    }
}
