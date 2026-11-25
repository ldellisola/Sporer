import SwiftUI

// The pieces every screen is made of, so the screens read as one app.

/// Loads a value for an id and shows it; while the next one loads (or fails), the last one stays on screen, never a blank.
///
/// - A screen with nothing of its own on show opens at once on the answer saved last time, if the service keeps them, while
///   the server is asked.
/// - When the server can't be reached the saved answer is shown with a note saying so, and when it was saved; a failure that may
///   pass, and such a saved answer, are asked for again by themselves (after 5 s, 15 s, then every 30 s) until the server answers.
/// - `refresh` says how long until the value shown is asked for again (a pending day, a period with today in it), or nil.
/// - Everything is asked for again when the app comes back to the foreground (`AppModel.wakeCount`).
struct Loaded<Value: Sendable, Content: View, Placeholder: View>: View {
    let id: AnyHashable
    var refresh: (Value) -> Duration? = { _ in nil }
    let load: @Sendable () async throws -> Value
    @ViewBuilder var content: (Value, _ isStale: Bool) -> Content
    @ViewBuilder var placeholder: () -> Placeholder

    @Environment(\.appModel) private var app
    @State private var value: Value?
    @State private var valueID: AnyHashable?
    /// When the answer on show was saved, when it is shown because the server couldn't be reached.
    @State private var offlineCopy: Date?
    @State private var error: (any Error)?
    @State private var attempt = 0

    var body: some View {
        Group {
            if let value {
                content(value, valueID != id)
                    .safeAreaInset(edge: .top, spacing: 0) {
                        if let error {
                            InlineError(error: error) { attempt += 1 }
                                .padding(.horizontal)
                                .padding(.bottom, 8)
                        } else if let offlineCopy, valueID == id {
                            OfflineNote(savedAt: offlineCopy) { attempt += 1 }
                                .padding(.horizontal)
                                .padding(.bottom, 8)
                        }
                    }
            } else if let error {
                ErrorState(error: error) { attempt += 1 }
            } else {
                placeholder()
            }
        }
        .task(id: TaskKey(id: id, attempt: attempt, wake: app.wakeCount)) { await run() }
    }

    private func run() async {
        let id = self.id
        error = nil
        if valueID != id, app.service.keepsResponses {
            let note = CacheNote()
            let saved = try? await ServiceContext.$mode.withValue(.cacheOnly) {
                try await ServiceContext.$note.withValue(note) { try await load() }
            }
            guard !Task.isCancelled else { return }
            if let saved {
                value = saved
                valueID = id
                offlineCopy = nil
            }
        }
        // Until the server itself answers: a failure that may pass (the VPN reconnecting, the server restarting), or a saved copy
        // given because the server can't be reached, is asked for again after 5 and 15 seconds, then every 30. A refusal stays.
        var backoff = [5, 15]
        while true {
            do {
                let (fresh, savedAt) = try await fetch()
                guard !Task.isCancelled else { return }
                value = fresh
                valueID = id
                offlineCopy = savedAt
                error = nil
                if savedAt == nil { break }
            } catch is CancellationError {
                return
            } catch {
                guard !Task.isCancelled else { return }
                self.error = error
                guard (error as? ServiceError)?.isRetryable ?? true else { return }
            }
            try? await Task.sleep(for: .seconds(backoff.isEmpty ? 30 : backoff.removeFirst()))
            guard !Task.isCancelled else { return }
        }
        // Kept fresh while it may change. A refresh that fails leaves what is shown as it is, quietly.
        while let shown = value, let interval = refresh(shown) {
            try? await Task.sleep(for: interval)
            guard !Task.isCancelled else { return }
            guard let result = try? await fetch(), !Task.isCancelled else { continue }
            value = result.0
            offlineCopy = result.1
        }
    }

    private func fetch() async throws -> (Value, Date?) {
        let note = CacheNote()
        let value = try await ServiceContext.$note.withValue(note) { try await load() }
        return (value, note.savedAt)
    }

    private struct TaskKey: Hashable {
        var id: AnyHashable
        var attempt: Int
        var wake: Int
    }
}

extension Loaded where Placeholder == LoadingState {
    init(id: AnyHashable, refresh: @escaping (Value) -> Duration? = { _ in nil }, load: @escaping @Sendable () async throws -> Value,
         @ViewBuilder content: @escaping (Value, _ isStale: Bool) -> Content) {
        self.init(id: id, refresh: refresh, load: load, content: content, placeholder: { LoadingState() })
    }
}

/// The server couldn't be reached, and what is shown is what was saved on the device.
struct OfflineNote: View {
    let savedAt: Date
    var retry: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "icloud.slash.fill")
                .foregroundStyle(.secondary)
            Text("Offline. Saved \(savedAt.formatted(.relative(presentation: .named))).")
                .font(.footnote)
                .lineLimit(2)
            Spacer(minLength: 0)
            Button("Retry", action: retry)
                .font(.footnote.weight(.semibold))
                .buttonStyle(.borderless)
        }
        .padding(12)
        .background(.fill.tertiary, in: .rect(cornerRadius: 14))
        .accessibilityElement(children: .combine)
    }
}

struct LoadingState: View {
    var body: some View {
        ProgressView()
            .controlSize(.large)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding(.vertical, 40)
    }
}

/// A view that could not load: why, and a Retry when asking again can help.
struct ErrorState: View {
    let error: any Error
    var retry: () -> Void

    var body: some View {
        ContentUnavailableView {
            Label("Couldn't Load", systemImage: "wifi.exclamationmark")
        } description: {
            Text(error.localizedDescription)
        } actions: {
            if (error as? ServiceError)?.isRetryable ?? true {
                Button("Try Again", action: retry)
                    .buttonStyle(.glassProminent)
            }
        }
    }
}

/// A failure over data that is still shown: the data stays, the failure is a line above it.
struct InlineError: View {
    let error: any Error
    var retry: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
            Text("Couldn't load. \(error.localizedDescription)")
                .font(.footnote)
                .lineLimit(2)
            Spacer(minLength: 0)
            Button("Retry", action: retry)
                .font(.footnote.weight(.semibold))
                .buttonStyle(.borderless)
        }
        .padding(12)
        .background(.orange.opacity(0.12), in: .rect(cornerRadius: 14))
    }
}

/// "Updating…": the period still has points waiting to be processed, so it may change.
struct PendingBadge: View {
    var body: some View {
        HStack(spacing: 6) {
            ProgressView().controlSize(.mini)
            Text("Updating…")
        }
        .font(.caption.weight(.medium))
        .foregroundStyle(.secondary)
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(.fill.tertiary, in: .capsule)
        .accessibilityElement(children: .combine)
    }
}

/// One figure of a summary: a value over its unit, with a symbol.
struct Stat: Identifiable {
    var id: String { label }
    var value: String
    var label: String
    var symbol: String
    var tint: Color = .secondary
}

/// The figures of a day, a period or a trip, side by side in one rounded card; two by two when a row would crowd them.
struct StatStrip: View {
    let stats: [Stat]

    var body: some View {
        ViewThatFits(in: .horizontal) {
            row
            grid
        }
        .padding(.vertical, 12)
        .background(.background.secondary, in: .rect(cornerRadius: 20))
    }

    private var row: some View {
        HStack(alignment: .top, spacing: 0) {
            ForEach(Array(stats.enumerated()), id: \.element.id) { index, stat in
                if index > 0 {
                    Divider().frame(height: 34).padding(.top, 4)
                }
                StatCell(stat: stat)
                    .fixedSize(horizontal: true, vertical: false)
                    .frame(minWidth: 72, maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 12)
            }
        }
    }

    private var grid: some View {
        Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 12) {
            ForEach(Array(stride(from: 0, to: stats.count, by: 2)), id: \.self) { i in
                GridRow {
                    StatCell(stat: stats[i])
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 12)
                    if i + 1 < stats.count {
                        StatCell(stat: stats[i + 1])
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 12)
                    } else {
                        Color.clear.frame(height: 1)
                    }
                }
            }
        }
    }
}

private struct StatCell: View {
    let stat: Stat

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Label {
                Text(stat.label)
            } icon: {
                Image(systemName: stat.symbol).foregroundStyle(stat.tint)
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .labelStyle(.titleAndIcon)
            .lineLimit(1)
            Text(stat.value)
                .font(.title3.weight(.semibold))
                .monospacedDigit()
                .lineLimit(1)
                .contentTransition(.numericText())
        }
        .accessibilityElement(children: .combine)
    }
}

/// The disc of a stop, as the map draws it: the stay's number, or a house for home, or grey for a stay with no place.
struct StopBadge: View {
    var label: String?
    var isHome = false
    var size: CGFloat = 30

    var body: some View {
        ZStack {
            Circle().fill(label == nil && !isHome ? Color.gray : Color.pin)
            Circle().strokeBorder(.white, lineWidth: 2)
            if isHome {
                Image(systemName: "house.fill")
                    .font(.system(size: size * 0.42, weight: .bold))
            } else if let label {
                Text(label)
                    .font(.system(size: size * 0.42, weight: .bold, design: .rounded))
                    .minimumScaleFactor(0.6)
                    .padding(.horizontal, 3)
            }
        }
        .foregroundStyle(.white)
        .frame(width: size, height: size)
        .shadow(color: .black.opacity(0.18), radius: 2, y: 1)
    }
}

/// The symbol of a mode in a small disc of its colour.
struct ModeBadge: View {
    var mode: Mode?
    var size: CGFloat = 26

    var body: some View {
        let style = ModeStyle(mode: mode)
        Image(systemName: style.symbol)
            .font(.system(size: size * 0.48, weight: .semibold))
            .foregroundStyle(style.color)
            .frame(width: size, height: size)
            .background(style.color.opacity(0.16), in: .circle)
    }
}

/// A section title inside a scrolling panel.
struct PanelSectionHeader: View {
    let title: String
    var trailing: String?

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title).font(.title3.weight(.semibold))
            Spacer()
            if let trailing {
                Text(trailing).font(.subheadline).foregroundStyle(.secondary)
            }
        }
        .padding(.top, 8)
        .accessibilityAddTraits(.isHeader)
    }
}

/// A horizontal bar of a share of the most, as "Where your time went" draws it.
struct ShareBar: View {
    var fraction: Double
    var tint: Color = .pin

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(.fill.tertiary)
                Capsule().fill(tint.gradient)
                    .frame(width: max(6, geo.size.width * min(1, max(0, fraction))))
            }
        }
        .frame(height: 6)
        .accessibilityHidden(true)
    }
}

extension View {
    /// The common padding of a panel's scrolling content.
    func panelPadding() -> some View {
        padding(.horizontal, 16)
    }
}
