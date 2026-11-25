import SwiftUI

/// Processing: how far the server is with your history and what is waiting (GET /api/status, shared with Server).
struct ProcessingSection: View {
    let model: SettingsModel

    var body: some View {
        LoadedSection(title: "Processing", state: model.status, retry: { Task { await model.loadStatus() } }) { status in
            backfill(status.backfill)
            VStack(alignment: .leading, spacing: 2) {
                Text("Last Processed")
                if let last = status.lastRunAt {
                    TimelineView(.periodic(from: .now, by: 30)) { _ in
                        Text(Self.relative(last)).foregroundStyle(.secondary)
                    }
                    Text(Format.stamp(last)).font(.caption).foregroundStyle(.secondary)
                } else {
                    Text("Not yet").foregroundStyle(.secondary)
                }
            }
            .accessibilityElement(children: .combine)
            LabeledContent("Waiting", value: Format.count(status.pendingRanges, "period"))
            VStack(alignment: .leading, spacing: 2) {
                Text("Place Names")
                Text(placeSummary(status.places)).font(.subheadline).foregroundStyle(.secondary)
            }
            .accessibilityElement(children: .combine)
            ForEach(status.warnings, id: \.self) { warning in
                Label(warning, systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(.red)
                    .font(.subheadline)
            }
            if let error = status.lastError, !error.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Label("Last Error", systemImage: "xmark.octagon.fill").foregroundStyle(.red).fontWeight(.medium)
                    Text(error).font(.caption.monospaced()).foregroundStyle(.red)
                }
                .accessibilityElement(children: .combine)
            }
        }
        .id("settings-processing")
    }

    /// The percent and "Paused" show independently of each other, as on the web.
    @ViewBuilder private func backfill(_ b: BackfillStatus) -> some View {
        if b.percent < 100 || b.paused {
            VStack(alignment: .leading, spacing: 8) {
                Text("Processing your history… \(b.percent) %" + (b.paused ? " · Paused" : ""))
                    .monospacedDigit()
                ProgressView(value: Double(min(100, max(0, b.percent))), total: 100)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Processing your history")
            .accessibilityValue("\(b.percent) percent" + (b.paused ? ", paused" : ""))
        } else {
            Label("Up to date", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
        }
    }

    private func placeSummary(_ p: PlaceStatus) -> String {
        var parts = [Format.count(p.total, "place")]
        parts.append(p.unnamed == 0 ? "all named" : "\(Format.grouped(p.unnamed)) unnamed")
        if p.failed > 0 { parts.append("\(Format.grouped(p.failed)) failed") }
        return parts.joined(separator: " · ")
    }

    private static let formatter: RelativeDateTimeFormatter = {
        let f = RelativeDateTimeFormatter()
        f.locale = Locale(identifier: "en_GB")
        f.unitsStyle = .full
        return f
    }()

    /// "5 minutes ago"; "Just now" within a minute either way (the server's clock may be a moment ahead of the phone's).
    static func relative(_ date: Date) -> String {
        abs(date.timeIntervalSinceNow) < 60 ? "Just now" : formatter.localizedString(for: date, relativeTo: Date())
    }
}

/// Failed Periods: what the server could not process, and a way to ask it to try again now.
struct FailedPeriodsSection: View {
    let model: SettingsModel

    var body: some View {
        if let status = model.status.value {
            Section {
                if status.failedRanges.isEmpty {
                    Label("Nothing has failed", systemImage: "checkmark.circle").foregroundStyle(.secondary)
                } else {
                    ForEach(status.failedRanges, id: \.from) { FailedRangeRow(range: $0) }
                    Button {
                        Task { await model.retryFailed() }
                    } label: {
                        HStack {
                            Label("Retry Failed", systemImage: "arrow.clockwise")
                            if model.isRetrying { Spacer(); ProgressView() }
                        }
                        .frame(minHeight: 44, alignment: .leading)
                    }
                    .disabled(model.isRetrying)
                }
            } header: {
                Text("Failed Periods")
            } footer: {
                if !status.failedRanges.isEmpty {
                    Text("The server tries failed periods again by itself. Retry Failed asks it to try right now.")
                }
            }
        }
    }
}

/// A period the server could not process: when, how many tries, and what it said.
private struct FailedRangeRow: View {
    let range: FailedRange

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(.subheadline.weight(.medium))
            Text(Format.count(range.attempts, "attempt")).font(.subheadline).foregroundStyle(.secondary)
            if let error = range.lastError, !error.isEmpty {
                Text(error).font(.caption.monospaced()).foregroundStyle(.red).textSelection(.enabled)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }

    /// On the device's clock, as the web app's Settings lists do.
    private var label: String {
        let a = Format.stamp(range.from), b = Format.stamp(range.to)
        if a.prefix(15) == b.prefix(15) { return "\(a) – \(b.suffix(5))" }
        return "\(a) – \(b)"
    }
}
