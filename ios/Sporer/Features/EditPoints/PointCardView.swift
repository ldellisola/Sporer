import SwiftUI

/// The card of one raw point: why the timeline uses or ignores it, what the device recorded, and where it sits in the day.
struct PointCardView: View {
    let point: RawPoint

    var body: some View {
        // Keyed on the point, so tapping another point never shows the first one's details.
        PointCardBody(point: point).id(point.t)
    }
}

private struct PointCardBody: View {
    @Environment(\.appModel) private var app
    @Environment(\.dismiss) private var dismiss
    let point: RawPoint

    private var editing: EditPointsModel? { app.map.editing }
    private var deviceName: String {
        guard let devices = editing?.devices, devices.indices.contains(point.device) else { return "" }
        return devices[point.device]
    }
    private var isSelected: Bool { editing?.selected.contains(point.t) ?? false }

    @State private var detail: PointDetailResponse?
    @State private var error: (any Error)?
    @State private var attempt = 0
    @State private var gate = EditGate.shared

    var body: some View {
        NavigationStack {
            Group {
                if let detail {
                    content(detail)
                } else if let error {
                    if case ServiceError.notFound = error {
                        ContentUnavailableView("This point no longer exists", systemImage: "mappin.slash")
                    } else {
                        ErrorState(error: error) { attempt += 1 }
                    }
                } else {
                    HStack(spacing: 8) { ProgressView(); Text("Loading…").foregroundStyle(.secondary) }
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .navigationTitle(title)
            .navigationSubtitle(subtitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close", systemImage: "xmark") { dismiss() }
                        .keyboardShortcut(.escape, modifiers: [])
                }
                ToolbarItem(placement: .primaryAction) {
                    Button(isSelected ? "Deselect" : "Select") {
                        editing?.toggle(point)
                    }
                    .disabled(editing == nil || error != nil || gate.isRemoving)
                }
            }
        }
        .onChange(of: app.map.editing == nil) { _, ended in if ended { dismiss() } }
        .task(id: "\(attempt)-\(gate.revision)") {
            error = nil
            do {
                let loaded = try await app.service.pointDetail(device: deviceName, t: point.t)
                guard !Task.isCancelled else { return }
                detail = loaded
            } catch is CancellationError {
            } catch {
                guard !Task.isCancelled else { return }
                self.error = error
            }
        }
    }

    // MARK: Title

    private var date: Date { Date(timeIntervalSince1970: Double(point.t) / 1_000_000) }

    private var title: String {
        guard let detail else { return "Point" }
        return Self.clock(date, zone: detail.zone) + " " + Format.zoneAbbreviation(detail.zone, at: date)
    }

    private var subtitle: String {
        guard let detail else { return "" }
        return Format.date(LocalDate(date, in: Format.zone(detail.zone)))
    }

    private static func clock(_ date: Date, zone: String) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_GB")
        f.timeZone = Format.zone(zone)
        f.dateFormat = "HH:mm:ss"
        return f.string(from: date)
    }

    // MARK: Content

    private func content(_ d: PointDetailResponse) -> some View {
        List {
            Section {
                statusRow(d)
            }
            Section("Details") {
                row("Device", deviceName.isEmpty ? nil : deviceName, symbol: "iphone")
                coordinateRow(d)
                row("Accuracy", accuracyText(d), symbol: "scope")
                row("Speed", d.speedMps.flatMap { $0 < 0 ? nil : String(format: "%.1f km/h", $0 * 3.6) }, symbol: "speedometer")
                row("Altitude", d.altitudeM.isFinite ? "\(Int(d.altitudeM.rounded())) m" : nil, symbol: "mountain.2")
                row("Motion", (d.motion ?? []).isEmpty ? nil : (d.motion ?? []).map { $0.capitalized }.joined(separator: ", "), symbol: "figure.walk.motion")
            }
            if let segment = d.segment {
                Section("Timeline") {
                    Label {
                        Text(segmentText(segment, d: d))
                    } icon: {
                        Image(systemName: segmentSymbol(segment)).foregroundStyle(segmentTint(segment))
                    }
                }
            }
            Section("Nearby Points") {
                neighbourRow(d.previous, after: true)
                neighbourRow(d.next, after: false)
            }
        }
        .listStyle(.insetGrouped)
        .listSectionSpacing(.compact)
    }

    private func accuracyText(_ d: PointDetailResponse) -> String? {
        guard let a = d.accuracyM, a >= 0 else { return nil }
        return a > d.maxAccuracyM ? "\(Int(a.rounded())) m" : String(format: "%.1f m", a)
    }

    private func statusRow(_ d: PointDetailResponse) -> some View {
        let (symbol, tint, text): (String, Color, String) = switch d.status {
        case .used: ("checkmark.circle.fill", .green, "Used by the timeline")
        case .poorAccuracy:
            ("exclamationmark.triangle.fill", .orange,
             (d.accuracyM ?? -1) < 0
                ? "Ignored: the GPS accuracy was not valid"
                : "Ignored: the GPS accuracy was \(Int((d.accuracyM ?? 0).rounded())) m (more than \(Int(d.maxAccuracyM.rounded())) m)")
        case .glitch: ("arrow.left.arrow.right.circle.fill", .orange, "Ignored: an out-and-back jump")
        case .duplicate: ("doc.on.doc.fill", .orange, "Ignored: a repeat of an earlier point")
        case .removed: ("trash.circle.fill", .red, "Removed by you")
        }
        return VStack(alignment: .leading, spacing: 6) {
            Label {
                Text(text).font(.body.weight(.medium))
            } icon: {
                Image(systemName: symbol).foregroundStyle(tint).font(.title3)
            }
            if point.status == .duplicate {
                Text(d.status == .duplicate
                     ? "Stored twice: this is the repeat, and the timeline uses the first."
                     : "Stored twice: this is the first, and the repeat is ignored.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
        }
    }

    private func row(_ title: String, _ value: String?, symbol: String) -> some View {
        LabeledContent {
            Text(value ?? "Not recorded")
                .foregroundStyle(value == nil ? .tertiary : .secondary)
                .monospacedDigit()
                .multilineTextAlignment(.trailing)
        } label: {
            Label { Text(title) } icon: { Image(systemName: symbol).foregroundStyle(.secondary) }
        }
        .accessibilityElement(children: .combine)
    }

    private func coordinateRow(_ d: PointDetailResponse) -> some View {
        let text = String(format: "%.6f, %.6f", d.lat, d.lon)
        return LabeledContent {
            Text(text).foregroundStyle(.secondary).monospacedDigit().multilineTextAlignment(.trailing)
        } label: {
            Label { Text("Coordinates") } icon: { Image(systemName: "location").foregroundStyle(.secondary) }
        }
        .contextMenu {
            Button("Copy Coordinates", systemImage: "doc.on.doc") { UIPasteboard.general.string = text }
        }
        .accessibilityElement(children: .combine)
        .accessibilityValue(String(format: "latitude %.4f, longitude %.4f", d.lat, d.lon))
        .accessibilityAction(named: "Copy Coordinates") { UIPasteboard.general.string = text }
    }

    @ViewBuilder private func neighbourRow(_ n: PointNeighbour?, after: Bool) -> some View {
        if let n {
            let relation = after ? "after the previous point" : "before the next point"
            Label {
                Text("\(duration(n.gapSeconds)) and \(Format.distance(n.distanceM)) \(relation) (\(String(format: "%.1f", n.speedKmh)) km/h)")
            } icon: {
                Image(systemName: after ? "chevron.up" : "chevron.down").foregroundStyle(.secondary)
            }
        } else {
            Label {
                Text(after ? "No earlier point" : "No later point").foregroundStyle(.secondary)
            } icon: {
                Image(systemName: after ? "chevron.up" : "chevron.down").foregroundStyle(.tertiary)
            }
        }
    }

    /// "5 min 12 s", "40 s", "2 h 3 min".
    private func duration(_ seconds: Double) -> String {
        let s = Int(seconds.rounded())
        if s >= 3600 { return "\(s / 3600) h \((s % 3600) / 60) min" }
        if s >= 60 { return "\(s / 60) min \(s % 60) s" }
        return "\(s) s"
    }

    // MARK: Segment

    private func stamp(_ date: Date, d: PointDetailResponse) -> String {
        let zone = Format.zone(d.zone)
        let time = Format.time(date, zone: d.zone)
        guard LocalDate(date, in: zone) != LocalDate(self.date, in: zone) else { return time }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_GB")
        f.timeZone = zone
        f.dateFormat = "EEE d MMM"
        return "\(f.string(from: date)) \(time)"
    }

    private func segmentText(_ s: PointSegment, d: PointDetailResponse) -> String {
        let range = "\(stamp(s.startUtc, d: d))–\(stamp(s.endUtc, d: d))"
        switch s.kind {
        case "stay":
            let name = (s.place?.name).flatMap { $0.isEmpty ? nil : $0 }
            return "In a stay at \(name ?? "a place with no name") (\(range))"
        case "move": return "In a move: \(s.mode.flatMap(Mode.init(rawValue:))?.title ?? "Move") (\(range))"
        default: return "In a gap (\(range))"
        }
    }

    private func segmentSymbol(_ s: PointSegment) -> String {
        switch s.kind {
        case "stay": "mappin.circle.fill"
        case "move": ModeStyle(mode: s.mode.flatMap(Mode.init(rawValue:))).symbol
        default: "questionmark.circle"
        }
    }

    private func segmentTint(_ s: PointSegment) -> Color {
        switch s.kind {
        case "stay": .pin
        case "move": ModeStyle(mode: s.mode.flatMap(Mode.init(rawValue:))).color
        default: .secondary
        }
    }
}
