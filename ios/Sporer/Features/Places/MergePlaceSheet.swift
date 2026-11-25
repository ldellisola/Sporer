import SwiftUI

/// Merge With…: pick a place, then confirm which name to keep, on a pushed screen of the same sheet.
/// The sheet stays open on a failure, with the picker one step back.
struct MergePlaceSheet: View {
    @Environment(\.appModel) private var app
    let place: PlaceResponse
    /// Read the place again (it, or the other one, is gone).
    var onGone: () -> Void
    /// Merged: the sheet closes.
    var onMerged: () -> Void
    var onCancel: () -> Void

    @State private var picked: PickablePlace?

    var body: some View {
        NavigationStack {
            PlacePicker(title: "Merge With", prompt: "Search Places", search: { [service = app.service, id = place.id] query in
                try await service.mergeCandidates(for: id, query: query).map {
                    PickablePlace(id: $0.id, name: $0.name, address: $0.address, distanceM: $0.distanceM, visits: $0.visits)
                }
            }, onPick: { picked = $0 }, onCancel: onCancel)
            .navigationDestination(item: $picked) { there in
                MergeConfirmView(place: place, there: there, onGone: onGone, onMerged: onMerged, onChooseAnother: { picked = nil })
            }
            .task {
                #if DEBUG
                if ProcessInfo.processInfo.arguments.contains("-placesKeep") {
                    try? await Task.sleep(for: .seconds(2))
                    picked = PickablePlace(id: place.id == 2 ? 3 : 2, name: place.id == 2 ? "Barcode" : "Tim Wendelboe", address: nil, distanceM: 120, visits: 10)
                }
                #endif
            }
        }
        .presentationDetents([.large])
    }
}

private struct MergeConfirmView: View {
    private enum Keep: Hashable { case here, there }

    @Environment(\.appModel) private var app
    let place: PlaceResponse
    let there: PickablePlace
    var onGone: () -> Void
    var onMerged: () -> Void
    var onChooseAnother: () -> Void

    @State private var keep: Keep
    @State private var isMerging = false
    @State private var failure: String?

    init(place: PlaceResponse, there: PickablePlace, onGone: @escaping () -> Void, onMerged: @escaping () -> Void, onChooseAnother: @escaping () -> Void) {
        self.place = place
        self.there = there
        self.onGone = onGone
        self.onMerged = onMerged
        self.onChooseAnother = onChooseAnother
        _keep = State(initialValue: place.name != nil || there.name == nil ? .here : .there)
    }

    private var sameName: Bool { there.name != nil && there.name == place.name }

    var body: some View {
        Form {
            Section {
                Text(question)
                    .font(.headline)
                Text("Everything spent there will count here. You can separate it again later.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            if !sameName {
                Section {
                    Picker("Name to Keep", selection: $keep) {
                        Text(Format.placeName(place.name)).tag(Keep.here)
                        if let theirs = there.name {
                            Text(theirs).tag(Keep.there)
                        }
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()
                    .disabled(isMerging)
                } header: {
                    Text("Name to Keep")
                } footer: {
                    if there.name == nil {
                        Text("The other place has no name of its own.")
                    }
                }
            }

            if let failure {
                Section {
                    Label(failure, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.red)
                    Button("Choose Another Place", action: onChooseAnother)
                }
            }
        }
        .navigationTitle("Merge")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button {
                    Task { await merge() }
                } label: {
                    if isMerging { ProgressView() } else { Text("Merge") }
                }
                .disabled(isMerging)
                .accessibilityLabel(isMerging ? "Merging" : "Merge")
            }
        }
    }

    private var question: String {
        if sameName { return "Merge the other “\(Format.placeName(there.name))” into this one?" }
        return "Merge “\(Format.placeName(there.name))” into “\(Format.placeName(place.name))”?"
    }

    private func merge() async {
        isMerging = true
        defer { isMerging = false }
        failure = nil
        let kept = (sameName || keep == .here) ? place.name : there.name
        do {
            let name: String?? = .some(kept)
            _ = try await app.service.mergePlace(there.id, into: place.id, name: name)
            onMerged()
            app.toasts.show(Toast(message: "Merged"))
        } catch {
            failure = PlaceOperation.merge.message(for: error)
            if PlaceOperation.merge.isGone(error) { onGone() }
        }
    }
}
