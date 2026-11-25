import SwiftUI

/// Deleted Trips: trips you deleted stay deleted when the data is processed again, until you restore them.
struct DeletedTripsSection: View {
    let model: SettingsModel

    var body: some View {
        LoadedSection(
            title: "Deleted Trips", state: model.deleted,
            footer: "A deleted trip stays deleted when your data is processed again. Restore brings it back.",
            retry: { Task { await model.loadDeleted() } }
        ) { trips in
            if trips.isEmpty {
                Label("No deleted trips", systemImage: "suitcase").foregroundStyle(.secondary)
            }
            ForEach(trips) { trip in
                HStack(spacing: 12) {
                    Text(trip.label)
                    Spacer(minLength: 8)
                    RowActionButton(title: "Restore", isWorking: model.restoring.contains(trip.key), accessibilityLabel: "Restore \(trip.label)") {
                        Task { await model.restore(trip) }
                    }
                }
            }
        }
        .id("settings-deleted")
    }
}

/// Removed Points: batches of points you removed in edit mode, kept so they can come back.
struct RemovedPointsSection: View {
    let model: SettingsModel

    var body: some View {
        LoadedSection(
            title: "Removed Points", state: model.removed,
            footer: "Points you removed while editing a day. Restoring them puts them back in the timeline.",
            retry: { Task { await model.loadRemoved() } }
        ) { batches in
            if batches.isEmpty {
                Label("No removed points", systemImage: "point.3.connected.trianglepath.dotted").foregroundStyle(.secondary)
            }
            ForEach(batches) { batch in
                let days = Self.daysLabel(batch)
                HStack(spacing: 12) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(days)
                        Text("\(Format.count(batch.count, "point")) · removed \(Format.stamp(batch.removedAt))")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 8)
                    RowActionButton(title: "Restore", isWorking: model.restoring.contains(batch.batch),
                                    accessibilityLabel: "Restore \(Format.count(batch.count, "point")) from \(days), removed \(Format.stamp(batch.removedAt))") {
                        Task { await model.restore(batch) }
                    }
                }
            }
        }
        .id("settings-removed")
    }

    /// The days a batch touched, runs of consecutive days joined: "1 – 2 Sep 2026, 5 Sep 2026".
    static func daysLabel(_ batch: RemovedBatch) -> String {
        let dates = Array(Set(batch.localDates)).sorted()
        // No local dates: the span of the first and last point on the device's clock (as the web app does).
        if dates.isEmpty { return Format.span(LocalDate(batch.from), LocalDate(batch.to)) }
        var runs: [(LocalDate, LocalDate)] = []
        for d in dates {
            if let last = runs.last, last.1.adding(days: 1) == d {
                runs[runs.count - 1].1 = d
            } else {
                runs.append((d, d))
            }
        }
        return runs.map { Format.span($0.0, $0.1) }.joined(separator: ", ")
    }
}
