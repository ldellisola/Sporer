import SwiftUI

/// The Places tab: every place on the map, and the most visited in a list, with search. A dot or a row opens the place, where Merge picks
/// the places near it on the map.
struct PlacesPanel: View {
    @Environment(\.appModel) private var app
    @State private var query = ""
    @State private var results: [PlaceSearchResult]?
    /// Every place in use, for the map; nothing is drawn until they are there (the map is brought to them once).
    @State private var all: [MapPlace]?
    @State private var error: (any Error)?
    @State private var isLoading = false
    @State private var attempt = 0

    var body: some View {
        List {
            if let results {
                if results.isEmpty {
                    Group {
                        if query.isEmpty {
                            ContentUnavailableView("No Places Yet", systemImage: "mappin.slash",
                                                   description: Text("Places appear here once the timeline has found where you stay."))
                        } else {
                            ContentUnavailableView.search(text: query)
                        }
                    }
                    .listRowBackground(Color.clear)
                } else {
                    ForEach(results) { place in
                        Button {
                            app.open(.place(place.id))
                        } label: {
                            HStack(spacing: 8) {
                                PickablePlaceRow(place: PickablePlace(id: place.id, name: place.name, address: place.address, distanceM: nil, visits: place.visits))
                                Image(systemName: "chevron.right")
                                    .font(.footnote.weight(.semibold))
                                    .foregroundStyle(.tertiary)
                                    .accessibilityHidden(true)
                            }
                            .contentShape(.rect)
                        }
                        .tint(.primary)
                        .accessibilityHint("Opens the place")
                    }
                }
            } else if let error {
                ErrorState(error: error) { attempt += 1 }
                    .listRowBackground(Color.clear)
            }
        }
        .opacity(isLoading && results != nil ? 0.55 : 1)
        .overlay {
            if results == nil, error == nil { LoadingState() }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            if let error, results != nil {
                InlineError(error: error) { attempt += 1 }
                    .padding(.horizontal)
                    .padding(.bottom, 8)
            }
        }
        .navigationTitle("Places")
        .navigationSubtitle("Most visited")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, prompt: "Search Places")
        .refreshable { attempt += 1 }
        .mapScene(all.map { .places($0) })
        .task(id: "\(app.dataVersion)|\(attempt)") {
            // The map's dots are no part of the list: a failure to get them leaves the dots there were, and the list says nothing of it.
            if let found = try? await app.service.allPlaces(), !Task.isCancelled { all = found }
        }
        .task(id: TaskKey(query: query, attempt: attempt)) {
            if !query.isEmpty { try? await Task.sleep(for: .milliseconds(300)) }
            guard !Task.isCancelled else { return }
            isLoading = true
            defer { if !Task.isCancelled { isLoading = false } }
            do {
                let found = try await app.service.searchPlaces(query)
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

    private struct TaskKey: Hashable {
        var query: String
        var attempt: Int
    }
}
