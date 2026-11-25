import SwiftUI

/// The sheet of "Set Home…": pick the place (most visited first, searchable), then say from when.
struct SetHomeFlow: View {
    @Environment(\.appModel) private var app
    /// Called with the place's name once the home is saved.
    var onSaved: (String) -> Void
    /// Called when the server says the place is gone: the sheet closes and the homes reload.
    var onGone: () -> Void = {}
    @Environment(\.dismiss) private var dismiss

    @State private var path: [PickablePlace] = []

    var body: some View {
        let service = app.service
        NavigationStack(path: $path) {
            PlacePicker(
                title: "Choose a Place",
                prompt: "Search Places",
                search: { query in
                    try await service.searchPlaces(query).map {
                        PickablePlace(id: $0.id, name: $0.name, address: $0.address, distanceM: nil, visits: $0.visits)
                    }
                },
                onPick: { path = [$0] }
            )
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .navigationDestination(for: PickablePlace.self) { place in
                SetHomeForm(place: place, onSaved: onSaved, onGone: onGone, onCancel: { dismiss() })
            }
        }
        .presentationDetents([.large])
        .task {
            // Debug: `-settingsSetHomeForm` opens the form for the most visited place.
            if SettingsDebug.flag("-settingsSetHomeForm"), path.isEmpty, let first = try? await service.searchPlaces("").first {
                path = [PickablePlace(id: first.id, name: first.name, address: first.address, distanceM: nil, visits: first.visits)]
            }
        }
    }
}

/// "Set <name> as Home": from when, and until when (or still).
struct SetHomeForm: View {
    @Environment(\.appModel) private var app
    let place: PickablePlace
    var onSaved: (String) -> Void
    var onGone: () -> Void = {}
    var onCancel: () -> Void = {}

    @State private var from = LocalDate.today.noonUTC
    @State private var to = LocalDate.today.noonUTC
    @State private var stillHome = true
    @State private var isSaving = false
    @State private var failure: SettingsFailure?

    private var name: String { Format.placeName(place.name) }
    private var utc: TimeZone { TimeZone(identifier: "UTC")! }
    private var endsBeforeStart: Bool { !stillHome && LocalDate(to, in: utc) < LocalDate(from, in: utc) }

    var body: some View {
        Form {
            Section {
                HStack(spacing: 12) {
                    Image(systemName: "house.fill")
                        .foregroundStyle(.white)
                        .frame(width: 40, height: 40)
                        .background(Color.pin, in: .rect(cornerRadius: 10))
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(name).font(.headline)
                        Text(place.address ?? "Home for the dates below")
                            .font(.subheadline).foregroundStyle(.secondary)
                    }
                }
                .accessibilityElement(children: .combine)
            }
            Section {
                DatePicker("From", selection: $from, displayedComponents: .date)
                Toggle("Still Home", isOn: $stillHome.animation())
                if !stillHome {
                    DatePicker("To", selection: $to, in: from..., displayedComponents: .date)
                }
                if endsBeforeStart {
                    Label("The end date can't be before the start date.", systemImage: "exclamationmark.circle.fill")
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
            } footer: {
                Text("A home you set replaces what was detected for those dates.")
            }
        }
        .environment(\.calendar, LocalDate.calendar())
        .environment(\.timeZone, utc)
        .navigationTitle("Set Home")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel", action: onCancel)
            }
            ToolbarItem(placement: .confirmationAction) {
                if isSaving {
                    ProgressView()
                } else {
                    Button("Save", role: .confirm) { Task { await save() } }
                        .disabled(endsBeforeStart)
                }
            }
        }
        .alert(
            failure?.title ?? "",
            isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } }),
            presenting: failure
        ) { f in
            if let retry = f.retry { Button("Retry", action: retry) }
            Button("OK", role: .cancel) { if f.isGone { onGone() } }
        } message: { f in
            Text(f.message)
        }
        .onChange(of: from) { _, newFrom in
            if to < newFrom { to = newFrom }
        }
    }

    private func save() async {
        isSaving = true
        defer { isSaving = false }
        let request = AddHomeRequest(
            placeId: place.id,
            from: LocalDate(from, in: utc),
            to: stillHome ? nil : LocalDate(to, in: utc)
        )
        do {
            _ = try await app.service.addHome(request)
            onSaved(name)
        } catch {
            failure = SettingsFailure(.setHome, error, retry: { Task { await save() } })
        }
    }
}
