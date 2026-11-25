import SwiftUI

/// Trips: how far from home a night counts as a trip (GET and PUT /api/settings).
struct TripDistanceSection: View {
    @Bindable var model: SettingsModel
    @FocusState private var isFocused: Bool
    @State private var isWorking = false

    var body: some View {
        LoadedSection(
            title: "Trips", state: model.settings,
            footer: "A trip is a night spent this far from home, or farther. Changing it doesn't rebuild the timeline.",
            retry: { Task { await model.loadSettings() } }
        ) { settings in
            LabeledContent("Minimum Distance") {
                HStack(spacing: 4) {
                    TextField("Distance", text: $model.tripText)
                        .keyboardType(.decimalPad)
                        .multilineTextAlignment(.trailing)
                        .focused($isFocused)
                        .frame(minWidth: 56)
                        .onSubmit { commit() }
                        .accessibilityLabel("Minimum distance in kilometres")
                    Text("km").foregroundStyle(.secondary)
                }
            }
            Stepper(value: Binding(
                get: { model.tripValue ?? settings.tripMinDistanceKm },
                set: { model.tripText = TripDistance.plain($0) }
            ), in: TripDistance.range, step: 5) {
                Text("Adjust by 5 km").foregroundStyle(.secondary)
            }
            .accessibilityLabel("Minimum distance")
            .accessibilityValue("\(TripDistance.plain(model.tripValue ?? settings.tripMinDistanceKm)) kilometres")
            if model.tripIsInvalid {
                Label("Enter a distance from 5 to 1000 km.", systemImage: "exclamationmark.circle.fill")
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .onAppear { AccessibilityNotification.Announcement("Enter a distance from 5 to 1000 kilometres.").post() }
            }
            if model.tripIsChanged, model.tripValue != nil {
                Button { commit() } label: { rowLabel("Save", symbol: "checkmark") }
                    .disabled(isWorking)
            }
            if !model.tripIsDefault {
                Button {
                    isFocused = false
                    Task { isWorking = true; await model.saveTrip(nil); isWorking = false }
                } label: {
                    rowLabel("Reset to Default (\(Format.km(settings.tripMinDistanceKmDefault)))", symbol: "arrow.counterclockwise")
                }
                .disabled(isWorking)
            }
        }
        .id("settings-trips")
    }

    private func commit() {
        guard let value = model.tripValue, model.tripIsChanged, !isWorking else { return }
        isFocused = false
        Task { isWorking = true; await model.saveTrip(value); isWorking = false }
    }

    private func rowLabel(_ title: String, symbol: String) -> some View {
        HStack {
            Label(title, systemImage: symbol)
            if isWorking { Spacer(); ProgressView() }
        }
        .frame(minHeight: 44, alignment: .leading)
    }
}
