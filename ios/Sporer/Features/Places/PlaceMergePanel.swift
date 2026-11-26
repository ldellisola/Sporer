import SwiftUI

/// Merge mode of a place: the places tapped on the map (or picked from the list of the nearest) are merged into it, all at once. The first row is the
/// status and Merge, so a lowered sheet is enough to work with while the map is where the places are picked.
struct PlaceMergePanel: View {
    @Environment(\.appModel) private var app
    let place: PlaceResponse
    /// Every place in use, for the names of the places picked on the map and how far they are.
    let around: [MapPlace]
    let merging: PlaceMergeModel
    /// Merged: the place is read again.
    var onMerged: () -> Void
    /// The place, or one of the others, is gone: the place is read again.
    var onGone: () -> Void

    private enum Keep: Hashable { case here, name(String) }

    @State private var keep: Keep = .here
    @State private var isMerging = false
    @State private var failure: String?
    @State private var isPickingFromList = false
    /// The names of the places picked from the list, which may not be among `around` yet.
    @State private var listed: [Int: String?] = [:]

    private struct Row: Identifiable {
        var id: Int
        var name: String?
        var distanceM: Double?
    }

    private var rows: [Row] {
        merging.picked.map { id in
            let known = around.first { $0.id == id }
            return Row(id: id, name: known?.name ?? listed[id] ?? nil, distanceM: known.map { Geo.distance($0.coordinate, place.coordinate) })
        }
    }

    /// The names to keep one of: this place's, then each picked place's that is another, once. A place with no name has none to keep.
    private var otherNames: [String] {
        var seen = Set([place.name].compactMap { $0 })
        return rows.compactMap(\.name).filter { seen.insert($0).inserted }
    }

    /// What is sent as the name: the one chosen, or this place's (a place with no name keeps the one it has, none, and nothing is sent).
    private var keptName: String?? {
        if case .name(let name) = keep, otherNames.contains(name) { return .some(name) }
        guard let own = place.name else { return .none }
        return .some(own)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                actionRow
                if let failure {
                    Label(failure, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.red)
                        .font(.subheadline)
                }
                if rows.isEmpty {
                    Text("Tap the places on the map that are “\(Format.placeName(place.name))” too. Everything spent there will count here, and you can separate them again later.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                } else {
                    picked
                    if !otherNames.isEmpty { nameToKeep }
                }
                Button {
                    isPickingFromList = true
                } label: {
                    Label("Pick from List", systemImage: "list.bullet")
                }
                .buttonStyle(.glass)
                .disabled(isMerging)
            }
            .panelPadding()
            .padding(.bottom, 40)
        }
        .scrollBounceBehavior(.basedOnSize)
        .navigationTitle("Merge Places")
        .navigationSubtitle("Into \(Format.placeName(place.name))")
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(true)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { app.map.endMerging() }
                    .keyboardShortcut(.escape, modifiers: [])
            }
        }
        .onChange(of: merging.picked.count) { _, count in
            AccessibilityNotification.Announcement(count == 0 ? "None picked" : "\(Format.count(count, "place")) picked").post()
        }
        .sheet(isPresented: $isPickingFromList) {
            NavigationStack {
                PlacePicker(title: "Pick a Place", prompt: "Search Places", search: { [service = app.service, id = place.id] query in
                    try await service.mergeCandidates(for: id, query: query).map {
                        PickablePlace(id: $0.id, name: $0.name, address: $0.address, distanceM: $0.distanceM, visits: $0.visits)
                    }
                }, onPick: { picked in
                    listed[picked.id] = picked.name
                    if !merging.picked.contains(picked.id) { merging.toggle(picked.id) }
                    isPickingFromList = false
                })
            }
            .presentationDetents([.large])
        }
    }

    // MARK: Pieces

    private var actionRow: some View {
        HStack(spacing: 10) {
            Text(rows.isEmpty ? "Tap Places to Merge" : "\(Format.count(rows.count, "Place")) Picked")
                .font(.headline)
                .monospacedDigit()
                .contentTransition(.numericText())
            Spacer(minLength: 4)
            Button {
                Task { await merge() }
            } label: {
                if isMerging {
                    HStack(spacing: 6) { ProgressView().controlSize(.small); Text("Merging…") }
                } else {
                    Text("Merge")
                }
            }
            .buttonStyle(.glassProminent)
            .disabled(rows.isEmpty || isMerging)
            .accessibilityValue(rows.isEmpty ? "None picked" : Format.count(rows.count, "place"))
        }
        .padding(.top, 4)
        .animation(.default, value: rows.count)
    }

    private var picked: some View {
        VStack(spacing: 0) {
            ForEach(rows) { row in
                HStack(spacing: 12) {
                    Image(systemName: "mappin.circle.fill")
                        .font(.title2)
                        .foregroundStyle(.white, .blue)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(Format.placeName(row.name))
                            .font(.body.weight(.medium))
                            .foregroundStyle(row.name == nil ? .secondary : .primary)
                        if let distance = row.distanceM {
                            Text("\(Format.distance(distance)) away")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                    }
                    Spacer(minLength: 0)
                    Button {
                        withAnimation { merging.toggle(row.id) }
                    } label: {
                        Image(systemName: "minus.circle.fill")
                            .font(.title3)
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                    .disabled(isMerging)
                    .accessibilityLabel("Remove \(Format.placeName(row.name))")
                }
                .padding(.vertical, 8)
                if row.id != rows.last?.id { Divider().padding(.leading, 40) }
            }
        }
    }

    private var nameToKeep: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Name to Keep")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)
            Picker("Name to Keep", selection: $keep) {
                Text(Format.placeName(place.name)).tag(Keep.here)
                ForEach(otherNames, id: \.self) { name in
                    Text(name).tag(Keep.name(name))
                }
            }
            .pickerStyle(.menu)
            .disabled(isMerging)
        }
    }

    // MARK: Write

    private func merge() async {
        isMerging = true
        defer { isMerging = false }
        failure = nil
        let count = rows.count
        do {
            _ = try await app.service.mergePlaces(merging.picked, into: place.id, name: keptName)
            app.map.endMerging()
            onMerged()
            app.toasts.show(Toast(message: "Merged \(Format.count(count, "place"))"))
        } catch {
            failure = PlaceOperation.merge.message(for: error)
            if PlaceOperation.merge.isGone(error) { onGone() }
        }
    }
}
