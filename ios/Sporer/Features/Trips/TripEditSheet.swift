import SwiftUI

/// Renames a trip and moves its dates. Dates left alone are not sent, so the detected ones keep following the data.
struct TripEditSheet: View {
    @Environment(\.appModel) private var app
    @Environment(\.dismiss) private var dismiss
    let trip: TripResponse
    var onSaved: (EditTripResponse) -> Void
    var onGone: () -> Void

    @State private var name: String
    @State private var start: LocalDate
    @State private var end: LocalDate
    @State private var startTouched = false
    @State private var endTouched = false
    @State private var useDetected = false
    @State private var isSaving = false
    @State private var failure: String?
    @State private var isGone = false
    @State private var datesFailure: String?

    private static let utc = TimeZone(identifier: "UTC")!
    private static let bounds = LocalDate(year: 1970, month: 1, day: 1).noonUTC...LocalDate(year: 2099, month: 12, day: 31).noonUTC

    init(trip: TripResponse, onSaved: @escaping (EditTripResponse) -> Void, onGone: @escaping () -> Void) {
        self.trip = trip
        self.onSaved = onSaved
        self.onGone = onGone
        _name = State(initialValue: trip.ownName ?? "")
        _start = State(initialValue: trip.localStartDate)
        _end = State(initialValue: trip.localEndDate)
    }

    private var isRangeValid: Bool { useDetected || start < end }
    private var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var hasDetectedDatesOption: Bool { trip.startEdited || trip.endEdited }
    /// The refusal shown beside the dates: an invalid range, or what the server said.
    private var datesProblem: String? {
        if !isRangeValid { return "The start date must be before the end date." }
        return datesFailure
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent("Name") {
                        TextField("Name", text: $name, prompt: Text("Automatic name"))
                            .multilineTextAlignment(.trailing)
                            .submitLabel(.done)
                            .onChange(of: name) { if name.count > 100 { name = String(name.prefix(100)) } }
                    }
                } footer: {
                    if trip.ownName == nil {
                        Text("Named after its cities: \(trip.name). Type a name to replace it.")
                    } else {
                        Text("Leave it empty to name the trip after its cities.")
                    }
                }

                Section {
                    datePicker("Start Date", selection: $start, touched: $startTouched)
                    datePicker("End Date", selection: $end, touched: $endTouched)
                    if hasDetectedDatesOption {
                        Toggle("Use Detected Dates", isOn: $useDetected.animation())
                    }
                } header: {
                    Text("Dates")
                } footer: {
                    if let problem = datesProblem {
                        Label(problem, systemImage: "exclamationmark.circle.fill")
                            .foregroundStyle(.red)
                    } else if useDetected {
                        Text("The dates will go back to the ones detected from your data when you save.")
                    } else if trip.ongoing {
                        Text("The trip is still going on. Its end follows your data until you set it.")
                    }
                }
            }
            .navigationTitle("Edit Trip")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(isSaving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(action: save) {
                        Text("Save")
                            .opacity(isSaving ? 0 : 1)
                            .overlay { if isSaving { ProgressView() } }
                    }
                    .disabled(!isRangeValid || isSaving || isGone)
                }
            }
            .alert("Couldn't Save Trip", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(failure ?? "")
            }
        }
        .presentationDetents([.medium, .large])
        .interactiveDismissDisabled(isSaving)
    }

    private func datePicker(_ title: String, selection: Binding<LocalDate>, touched: Binding<Bool>) -> some View {
        DatePicker(title, selection: Binding(
            get: { selection.wrappedValue.noonUTC },
            set: { newValue in
                let date = LocalDate(newValue, in: Self.utc)
                guard date != selection.wrappedValue else { return }
                selection.wrappedValue = date
                touched.wrappedValue = true
            }
        ), in: Self.bounds, displayedComponents: .date)
        .environment(\.timeZone, Self.utc)
        .environment(\.calendar, LocalDate.calendar())
        .environment(\.locale, Locale(identifier: "en_GB"))
        .disabled(useDetected)
        .listRowBackground(datesProblem == nil ? nil : Color.red.opacity(0.12))
        .overlay(alignment: .leading) {
            if datesProblem != nil {
                Image(systemName: "exclamationmark.circle.fill")
                    .foregroundStyle(.red)
                    .font(.caption)
                    .offset(x: -14)
                    .accessibilityHidden(true)
            }
        }
        .onChange(of: selection.wrappedValue) { datesFailure = nil }
    }

    private func save() {
        let nameChanged = trimmedName != (trip.ownName ?? "")
        guard nameChanged || startTouched || endTouched || useDetected else {
            dismiss()
            return
        }
        // Dates the person did not touch are sent as null (they follow the data), unless they were set by hand before.
        // The end of a trip that is still going on is not sent.
        let sendStart = !useDetected && (startTouched || trip.startEdited)
        let sendEnd = !useDetected && (endTouched || (trip.endEdited && !trip.ongoing))
        let request = EditTripRequest(name: trimmedName.isEmpty ? nil : trimmedName,
                                      startDate: sendStart ? start : nil,
                                      endDate: sendEnd ? end : nil)
        isSaving = true
        Task {
            do {
                let response = try await app.service.editTrip(trip.id, request)
                onSaved(response)
                dismiss()
            } catch {
                isSaving = false
                switch error as? ServiceError {
                case .notFound:
                    isGone = true
                    datesFailure = TripActions.message(for: error)
                    onGone()
                case .conflict:
                    datesFailure = TripActions.message(for: error)
                default:
                    failure = TripActions.message(for: error)
                }
            }
        }
    }
}
