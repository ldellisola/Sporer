import SwiftUI

/// Home: where home was, period by period (GET /api/homes); the ones you set can be removed or added to.
struct HomeSection: View {
    let model: SettingsModel
    var setHome: () -> Void

    var body: some View {
        LoadedSection(
            title: "Home", state: model.homes,
            footer: "Detected from where you sleep: the place you spent 60 of the last 90 nights. A home you set replaces it for those dates.",
            retry: { Task { await model.loadHomes() } }
        ) { periods in
            if periods.isEmpty {
                Label("No home yet", systemImage: "house").foregroundStyle(.secondary)
            }
            ForEach(periods) { period in
                row(period)
            }
            Button(action: setHome) {
                Label("Set Home…", systemImage: "house.badge.plus")
                    .frame(minHeight: 44, alignment: .leading)
            }
        }
        .id("settings-home")
    }

    @ViewBuilder private func row(_ period: HomePeriod) -> some View {
        if period.source == .user {
            HomePeriodRow(period: period, isRemoving: model.removingHomes.contains(period.id))
                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                    Button("Remove", role: .destructive) { model.pendingRemoval = period }
                }
                .contextMenu {
                    Button("Remove Home…", systemImage: "trash", role: .destructive) { model.pendingRemoval = period }
                }
                .accessibilityAction(named: "Remove Home") { model.pendingRemoval = period }
        } else {
            HomePeriodRow(period: period, isRemoving: false)
        }
    }
}

struct HomePeriodRow: View {
    let period: HomePeriod
    var isRemoving: Bool

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "house.fill")
                .font(.body)
                .foregroundStyle(.white)
                .frame(width: 32, height: 32)
                .background(period.source == .user ? Color.pin : Color.gray, in: .rect(cornerRadius: 8))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(Format.placeName(period.placeName))
                    .foregroundStyle(period.placeName == nil ? .secondary : .primary)
                Text(Self.dates(period))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            if isRemoving {
                ProgressView()
            } else {
                Text(period.source == .user ? "Set by You" : "Detected")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(.fill.tertiary, in: .capsule)
            }
        }
        .accessibilityElement(children: .combine)
    }

    static func dates(_ p: HomePeriod) -> String {
        guard let to = p.to else { return "Since \(Format.date(p.from))" }
        return Format.span(p.from, to)
    }
}
