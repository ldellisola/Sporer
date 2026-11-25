import SwiftUI

/// One section of Settings that loads on its own: a spinner row, then the content; if a reload fails the old
/// content stays and the error sits in the same section. A single `Section`, so nothing attaches to siblings.
struct LoadedSection<Value, Content: View>: View {
    let title: String
    let state: SettingsModel.Loaded<Value>
    var footer: String?
    let retry: () -> Void
    @ViewBuilder var content: (Value) -> Content

    var body: some View {
        Section {
            if let value = state.value {
                content(value)
                if let error = state.error { SectionErrorRow(error: error, retry: retry) }
            } else if let error = state.error {
                SectionErrorRow(error: error, retry: retry)
            } else {
                HStack(spacing: 12) {
                    ProgressView()
                    Text("Loading…").foregroundStyle(.secondary)
                }
                .accessibilityElement(children: .combine)
            }
        } header: {
            HStack(spacing: 8) {
                Text(title)
                if state.isLoading, state.value != nil { ProgressView().controlSize(.mini) }
            }
        } footer: {
            if state.value != nil, let footer { Text(footer) }
        }
    }
}

/// "Couldn't load" and why, with Retry.
struct SectionErrorRow: View {
    let error: any Error
    var retry: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label {
                Text("Couldn't Load").fontWeight(.medium)
            } icon: {
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
            }
            Text(error.localizedDescription)
                .font(.subheadline)
                .foregroundStyle(.secondary)
            if (error as? ServiceError)?.isRetryable ?? true {
                Button("Retry", action: retry)
                    .buttonStyle(.bordered)
                    .controlSize(.small)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .contain)
    }
}

/// A restore or retry button that fits in a row: small, and it takes only its own taps.
struct RowActionButton: View {
    let title: String
    var isWorking = false
    var accessibilityLabel: String?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            if isWorking { ProgressView().controlSize(.small) } else { Text(title) }
        }
        .buttonStyle(.bordered)
        .buttonBorderShape(.capsule)
        .controlSize(.small)
        .disabled(isWorking)
        .accessibilityLabel(accessibilityLabel ?? title)
    }
}
