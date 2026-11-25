import SwiftUI

/// Sets a place as home for a period: from a date, to a date or still.
struct SetHomeSheet: View {
    @Environment(\.appModel) private var app
    @Environment(\.dismiss) private var dismiss
    let place: PlaceResponse
    var onDone: () -> Void

    @State private var from = LocalDate.today.noonUTC
    @State private var to = LocalDate.today.noonUTC
    @State private var isOpenEnded = true
    @State private var isSaving = false
    @State private var failure: String?

    private static let utc = TimeZone(identifier: "UTC")!

    private var isValid: Bool { isOpenEnded || to >= from }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack(spacing: 12) {
                        Image(systemName: "house.circle.fill")
                            .font(.largeTitle)
                            .foregroundStyle(.white, Color.pin)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(Format.placeName(place.name)).font(.headline)
                            if let address = place.address ?? place.city {
                                Text(address).font(.subheadline).foregroundStyle(.secondary)
                            }
                        }
                    }
                    .accessibilityElement(children: .combine)
                }
                Section {
                    DatePicker("From", selection: $from, displayedComponents: .date)
                        .onChange(of: from) { if to < from { to = from } }
                    Toggle("Still Home", isOn: $isOpenEnded.animation())
                    if !isOpenEnded {
                        DatePicker("To", selection: $to, in: from..., displayedComponents: .date)
                    }
                } footer: {
                    if isValid {
                        Text("A home you set replaces what was detected for those dates.")
                    } else {
                        Text("The end date must not be before the start date.").foregroundStyle(.red)
                    }
                }
            }
            .environment(\.timeZone, Self.utc)
            .navigationTitle("Set as Home")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", role: .cancel) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        Task { await save() }
                    } label: {
                        if isSaving { ProgressView() } else { Text("Save") }
                    }
                    .disabled(!isValid || isSaving)
                    .accessibilityLabel(isSaving ? "Saving" : "Save")
                }
            }
            .alert(PlaceOperation.home.failureTitle, isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(failure ?? "")
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func save() async {
        isSaving = true
        defer { isSaving = false }
        let request = AddHomeRequest(placeId: place.id, from: LocalDate(from, in: Self.utc),
                                     to: isOpenEnded ? nil : LocalDate(to, in: Self.utc))
        do {
            _ = try await app.service.addHome(request)
            dismiss()
            onDone()
            app.toasts.show(Toast(message: "Home set to \(Format.placeName(place.name))"))
        } catch {
            failure = PlaceOperation.home.message(for: error)
        }
    }
}
