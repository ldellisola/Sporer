import SwiftUI

/// What loading a place ends in: the place (and every place, for the map round it), or the word that it is gone.
private nonisolated enum PlaceLoad: Sendable {
    case place(PlaceResponse, isHome: Bool, around: [MapPlace])
    case gone
}

/// One place, as an Apple Maps place card: its name and address, the actions on it, what it adds up to, and its visits.
struct PlaceDetailView: View {
    @Environment(\.appModel) private var app
    @Environment(\.dismiss) private var dismiss
    let placeID: Int
    /// Bumped after a write, so the place is read again while the old one stays on screen.
    @State private var version = 0
    /// Write state lives here, above the loaded content, so a reload never resets it.
    @State private var writer = PlaceWriter()

    init(placeID: Int) {
        self.placeID = placeID
    }

    var body: some View {
        Loaded(id: Key(placeID: placeID, version: version, data: app.dataVersion), load: { [service = app.service, placeID] () async throws -> PlaceLoad in
            do {
                // The places round it are no part of the place: the place is shown without them when they cannot be had.
                async let around = (try? await service.allPlaces()) ?? []
                let place = try await service.place(placeID)
                let homes = (try? await service.homes()) ?? []
                let isHome = homes.contains { h in h.to == nil && (h.placeId == place.id || place.merged.contains { $0.id == h.placeId }) }
                return .place(place, isHome: isHome, around: await around)
            } catch ServiceError.notFound {
                return .gone
            }
        }) { loaded, isStale in
            switch loaded {
            case .place(let place, let isHome, let around):
                PlaceContent(place: place, isHome: isHome, around: around, isStale: isStale, writer: writer) { version += 1 }
                    .mapScene(isStale ? nil : .place(place, around: around))
            case .gone:
                ContentUnavailableView {
                    Label("This Place No Longer Exists", systemImage: "mappin.slash")
                } description: {
                    Text("It may have been merged into another place.")
                } actions: {
                    Button("Back to Places") { dismiss() }
                        .buttonStyle(.glass)
                }
                .navigationTitle("Place")
                .navigationBarTitleDisplayMode(.inline)
            }
        } placeholder: {
            LoadingState()
                .navigationTitle("Place")
                .navigationBarTitleDisplayMode(.inline)
        }
    }

    private struct Key: Hashable {
        var placeID: Int
        var version: Int
        var data = 0
    }
}

private struct PlaceContent: View {
    @Environment(\.appModel) private var app
    @Environment(\.dynamicTypeSize) private var typeSize
    let place: PlaceResponse
    let isHome: Bool
    let around: [MapPlace]
    let isStale: Bool
    @Bindable var writer: PlaceWriter
    var reload: () -> Void

    @State private var isRenaming = false
    @State private var draftName = ""
    @State private var debugFlagsApplied = false
    @State private var isSettingHome = false
    @State private var separating: MergedPlace?

    private static let nameLimit = 100

    private var subtitle: String {
        [place.address ?? place.city, place.country].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ", ")
    }

    private var busy: Bool { writer.isWorking || isStale }

    /// Merge mode is on for this place: the panel is the merge's, and the map picks the places.
    private var merging: PlaceMergeModel? { app.map.merging.flatMap { $0.into == place.id ? $0 : nil } }

    var body: some View {
        // A ZStack, not a Group: a modifier on a Group goes to each branch, and the details going as merge mode begins would end it.
        ZStack {
            if let merging {
                PlaceMergePanel(place: place, around: around, merging: merging, onMerged: reload, onGone: reload)
            } else {
                details
            }
        }
        // Leaving the place (Back, another tab) ends its merge mode, and forgets what was picked.
        .onDisappear { if app.map.merging?.into == place.id { app.map.endMerging() } }
    }

    /// How far round a place merge mode shows the places: as far as GPS drift splits one place into several (the server's home radius).
    private static let mergeAround = 250.0

    /// Picks places on the map to merge into this one: the sheet comes down, and the map comes close to the place and the places round it.
    private func startMerging() {
        app.map.merging = PlaceMergeModel(into: place.id)
        app.revealMap()
        let near = around.filter { $0.id != place.id && Geo.distance($0.coordinate, place.coordinate) <= Self.mergeAround }
        app.map.focus = .area([LonLat(lon: place.lon, lat: place.lat)] + near.map { LonLat(lon: $0.lon, lat: $0.lat) })
    }

    private var details: some View {
        List {
            Section {
                actions
                    .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 8, trailing: 0))
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                StatStrip(stats: [
                    Stat(value: PlaceText.total(place.totalSeconds), label: "Total Time", symbol: "clock.fill", tint: .pin),
                    Stat(value: Format.grouped(place.visits), label: "Visits", symbol: "figure.walk.arrival", tint: .pin),
                ])
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
            }

            Section {
                if isHome {
                    Label("Your Home", systemImage: "house.fill")
                        .foregroundStyle(Color.pin)
                }
                LabeledContent("First Visit", value: Format.date(firstDate))
                LabeledContent("Last Visit", value: Format.date(lastDate))
            }

            if !place.merged.isEmpty {
                Section {
                    ForEach(place.merged) { other in
                        HStack {
                            Text(Format.placeName(other.name))
                                .foregroundStyle(other.name == nil ? .secondary : .primary)
                            Spacer()
                            if writer.separatingID == other.id {
                                ProgressView()
                                    .accessibilityLabel("Separating")
                            } else {
                                Button("Separate") { separating = other }
                                    .buttonStyle(.bordered)
                                    .buttonBorderShape(.capsule)
                                    .controlSize(.small)
                                    .disabled(busy)
                                    .accessibilityLabel("Separate \(Format.placeName(other.name))")
                            }
                        }
                    }
                } header: {
                    Text("Merged Places")
                } footer: {
                    Text("Time spent at these places counts here.")
                }
            }

            Section {
                if place.recentVisits.isEmpty {
                    Text("No visits yet").foregroundStyle(.secondary)
                }
                ForEach(place.recentVisits.prefix(50), id: \.start) { visit in
                    Button {
                        app.open(.day(visit.date))
                    } label: {
                        VisitRow(visit: visit)
                    }
                    .tint(.primary)
                    .disabled(isStale)
                }
            } header: {
                Text("Recent Visits")
            }
        }
        .listStyle(.insetGrouped)
        .contentMargins(.top, 4, for: .scrollContent)
        .opacity(isStale ? 0.6 : 1)
        .accessibilityHidden(isStale)
        .navigationTitle(Format.placeName(place.name))
        .navigationSubtitle(subtitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if writer.isWorking {
                ToolbarItem(placement: .topBarTrailing) {
                    ProgressView().accessibilityLabel("Saving")
                }
            }
        }
        .alert("Rename Place", isPresented: $isRenaming) {
            TextField("Name", text: $draftName)
                .onChange(of: draftName) { if draftName.count > Self.nameLimit { draftName = String(draftName.prefix(Self.nameLimit)) } }
            Button("Save") { Task { await rename() } }
                .disabled(draftName.trimmingCharacters(in: .whitespacesAndNewlines) == ownName)
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Leave it empty to use the OpenStreetMap name.")
        }
        .alert(writer.failure?.title ?? "", isPresented: Binding(get: { writer.failure != nil }, set: { if !$0 { writer.failure = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(writer.failure?.message ?? "")
        }
        .confirmationDialog(separating.map { "Separate “\(Format.placeName($0.name))”?" } ?? "",
                            isPresented: Binding(get: { separating != nil }, set: { if !$0 { separating = nil } }),
                            titleVisibility: .visible, presenting: separating) { other in
            Button("Separate") { Task { await separate(other) } }
            Button("Cancel", role: .cancel) {}
        } message: { _ in
            Text("Its visits stop counting here, and anything merged into it goes with it. The name you chose stays with this place.")
        }
        .sheet(isPresented: $isSettingHome) {
            SetHomeSheet(place: place) { reload() }
        }
        .task { await applyDebugFlags() }
    }

    // MARK: Pieces

    /// Both dates on the clock of the zone of the most recent visit, like the web app.
    private var visitZone: TimeZone { Format.zone(place.recentVisits.first?.timeZone ?? "UTC") }
    private var lastDate: LocalDate { LocalDate(place.lastVisit, in: visitZone) }
    private var firstDate: LocalDate { LocalDate(place.firstVisit, in: visitZone) }

    /// Rename, Merge and Set as Home, like the Directions, Call and Website of a Maps card.
    /// Three across when they fit, else stacked full width (large type, narrow columns).
    private var actions: some View {
        let rename = { draftName = ownName; isRenaming = true }
        return ViewThatFits(in: .horizontal) {
            HStack(spacing: 10) {
                if !typeSize.isAccessibilitySize {
                    tile("Rename", symbol: "pencil", action: rename)
                    tile("Merge", symbol: "arrow.triangle.merge", action: startMerging)
                    tile("Set as Home", symbol: "house.fill") { isSettingHome = true }
                }
            }
            VStack(spacing: 8) {
                row("Rename", symbol: "pencil", action: rename)
                row("Merge", symbol: "arrow.triangle.merge", action: startMerging)
                row("Set as Home", symbol: "house.fill") { isSettingHome = true }
            }
        }
    }

    /// The name the owner gave: shown names are the own name, else the OpenStreetMap one, which the server does not separate.
    private var ownName: String { place.name ?? "" }

    private func tile(_ title: String, symbol: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 4) {
                Image(systemName: symbol).font(.title3).frame(height: 24)
                Text(title).font(.footnote.weight(.semibold)).lineLimit(1).fixedSize(horizontal: true, vertical: false)
            }
            .frame(maxWidth: .infinity, minHeight: 52)
        }
        .buttonStyle(.glass)
        .buttonBorderShape(.roundedRectangle(radius: 18))
        .disabled(busy)
    }

    private func row(_ title: String, symbol: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: symbol)
                .font(.body.weight(.semibold))
                .frame(maxWidth: .infinity, minHeight: 36)
        }
        .buttonStyle(.glass)
        .buttonBorderShape(.roundedRectangle(radius: 18))
        .disabled(busy)
    }

    // MARK: Writes

    private func rename() async {
        let trimmed = String(draftName.trimmingCharacters(in: .whitespacesAndNewlines).prefix(Self.nameLimit))
        if trimmed == ownName { return }
        writer.isWorking = true
        defer { writer.isWorking = false }
        do {
            let updated = try await app.service.renamePlace(place.id, name: trimmed.isEmpty ? nil : trimmed)
            reload()
            app.toasts.show(Toast(message: "Renamed to \(Format.placeName(updated.name))"))
        } catch {
            writer.failure = PlaceFailure(title: PlaceOperation.rename.failureTitle, message: PlaceOperation.rename.message(for: error))
            if PlaceOperation.rename.isGone(error) { reload() }
        }
    }

    private func separate(_ other: MergedPlace) async {
        writer.isWorking = true
        writer.separatingID = other.id
        defer {
            writer.isWorking = false
            writer.separatingID = nil
        }
        do {
            try await app.service.separatePlace(other.id, from: place.id)
            reload()
            app.toasts.show(Toast(message: "Separated \(Format.placeName(other.name))"))
        } catch {
            writer.failure = PlaceFailure(title: PlaceOperation.separate.failureTitle, message: PlaceOperation.separate.message(for: error))
            reload()
        }
    }

    /// Opens a dialog on launch, for screenshots: -placesRename, -placesMerge (merge mode, with -placesPick 43,44 picking places), -placesHome,
    /// -placesSeparate.
    private func applyDebugFlags() async {
        #if DEBUG
        guard !debugFlagsApplied else { return }
        debugFlagsApplied = true
        let args = ProcessInfo.processInfo.arguments
        if args.contains("-placesRename") { draftName = ownName; isRenaming = true }
        if args.contains("-placesHome") { isSettingHome = true }
        if args.contains("-placesMerge"), app.map.merging == nil {
            startMerging()
            if let i = args.firstIndex(of: "-placesPick"), args.indices.contains(i + 1) {
                for id in args[i + 1].split(separator: ",").compactMap({ Int($0) }) { app.map.merging?.toggle(id) }
            }
        }
        if args.contains("-placesSeparate"), let first = place.merged.first { separating = first }
        #endif
    }
}

private struct VisitRow: View {
    let visit: PlaceVisit

    var body: some View {
        let zone = Format.zone(visit.timeZone)
        let nextDay = LocalDate(visit.end, in: zone) != visit.date
        let times = "\(Format.time(visit.start, zone: visit.timeZone)) – \(Format.time(visit.end, zone: visit.timeZone))" + (nextDay ? " (+1)" : "")
        let seconds = visit.end.timeIntervalSince(visit.start)
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(Format.shortDay(visit.date, withYear: true))
                    .font(.body)
                Text(times)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
            Spacer(minLength: 8)
            Text(PlaceText.total(seconds))
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .monospacedDigit()
            Image(systemName: "chevron.right")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.tertiary)
                .accessibilityHidden(true)
        }
        .contentShape(.rect)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(Format.longDay(visit.date)), \(Format.time(visit.start, zone: visit.timeZone)) to \(Format.time(visit.end, zone: visit.timeZone))\(nextDay ? " the next day" : ""), \(PlaceText.spoken(seconds))")
        .accessibilityHint("Opens the day")
    }
}
