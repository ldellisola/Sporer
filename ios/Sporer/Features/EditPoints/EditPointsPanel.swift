import SwiftUI

/// Shared by the panel and the point card: a removal in flight freezes the selection; the revision tells the card to re-read its point.
@Observable
final class EditGate {
    static let shared = EditGate()
    var isRemoving = false
    var revision = 0
}

/// Edit mode of a day: remove bad GPS points. The first row is the status and the actions, so the peek is enough to work with.
struct EditPointsPanel: View {
    @Environment(\.appModel) private var app
    let editing: EditPointsModel
    let day: DayResponse?

    @State private var gate = EditGate.shared
    @State private var failure: RemoveFailure?
    @State private var loadError: (any Error)?
    @State private var confirming = false
    @State private var generation = 0

    struct RemoveFailure: Identifiable {
        let id = UUID()
        let message: String
        let refs: [PointRef]
        let ids: Set<Int64>
        let retryable: Bool
    }

    private static let maxRemoval = 50_000
    private static let confirmAbove = 50

    private var selectedCount: Int { editing.selected.count }
    private var isRemoving: Bool { gate.isRemoving }
    private var isPeek: Bool { app.detent == SheetDetents.peek }
    private var hasPoints: Bool { !editing.points.isEmpty }
    private var isInitialLoad: Bool { editing.isLoading && !hasPoints && loadError == nil }

    var body: some View {
        dialogs
            .navigationTitle("Edit Points")
            .navigationSubtitle(Format.longDay(editing.date))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbar }
            .task(id: editing.date) { await load() }
    }

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .confirmationAction) {
            Button("Done") {
                app.map.editing?.inspected = nil
                app.map.editing = nil
                app.detent = SheetDetents.medium
            }
            .keyboardShortcut(.escape, modifiers: [])
        }
    }

    @ViewBuilder private var content: some View {
        VStack(alignment: .leading, spacing: 16) {
                if let loadError, !hasPoints {
                    ErrorState(error: loadError) { Task { await load() } }
                        .frame(maxWidth: .infinity)
                } else if isInitialLoad {
                    HStack(spacing: 8) { ProgressView().controlSize(.small); Text("Loading points…").font(.headline).foregroundStyle(.secondary) }
                } else if !hasPoints {
                    ContentUnavailableView("No Points on This Day", systemImage: "mappin.slash")
                } else {
                    actionRow
                    if !isPeek {
                        if let loadError {
                            InlineError(error: loadError) { Task { await load() } }
                        }
                        hints
                        overview
                    }
                }
            }
            .panelPadding()
            .padding(.bottom, 40)
    }

    private var dialogs: some View {
        ScrollView { content }
        .scrollBounceBehavior(.basedOnSize)
        .onChange(of: selectedCount) { _, count in
            let words: String = count == 0 ? "None selected" : Format.grouped(count) + " selected"
            AccessibilityNotification.Announcement(words).post()
        }
        .alert("Couldn't Remove Points", isPresented: failureShown, presenting: failure) { failure in
            if failure.retryable {
                Button("Retry") { Task { await perform(failure.refs, ids: failure.ids) } }
            }
            Button(failure.retryable ? "Cancel" : "OK", role: .cancel) {}
        } message: { failure in
            Text(failure.message)
        }
        .confirmationDialog("Remove \(Format.count(selectedCount, "Point"))?", isPresented: $confirming, titleVisibility: .visible) {
            Button("Remove \(Format.count(selectedCount, "Point"))", role: .destructive) { Task { await remove() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("You can undo this from the message that follows, or restore the points later in Settings.")
        }
    }

    // MARK: Status and actions

    private var failureShown: Binding<Bool> {
        Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })
    }

    private var statusText: String {
        selectedCount == 0 ? "None selected" : "\(Format.grouped(selectedCount)) selected"
    }

    private var actionRow: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 10) {
                status
                Spacer(minLength: 4)
                clearButton
                removeButton(short: false)
            }
            VStack(alignment: .leading, spacing: 10) {
                status
                HStack(spacing: 10) {
                    clearButton
                    removeButton(short: true)
                }
            }
        }
        .padding(.top, 4)
        .animation(.default, value: selectedCount)
    }

    private var status: some View {
        Text(statusText)
            .font(.headline)
            .monospacedDigit()
            .foregroundStyle(.primary)
            .contentTransition(.numericText())
    }

    private var clearButton: some View {
        Button("Clear") { withAnimation { editing.selected = [] } }
            .buttonStyle(.glass)
            .disabled(selectedCount == 0 || isRemoving)
    }

    private func removeButton(short: Bool) -> some View {
        Button(role: .destructive) {
            if selectedCount > Self.confirmAbove { confirming = true } else { Task { await remove() } }
        } label: {
            if isRemoving {
                HStack(spacing: 6) { ProgressView().controlSize(.small); Text("Removing…") }
            } else if selectedCount == 0 {
                Text("Remove")
            } else {
                Text(short ? "Remove \(Format.grouped(selectedCount))" : "Remove \(Format.count(selectedCount, "Point"))")
                    .monospacedDigit()
            }
        }
        .buttonStyle(.glassProminent)
        .tint(.red)
        .disabled(selectedCount == 0 || isRemoving)
        .accessibilityLabel("Remove selected points")
        .accessibilityValue(isRemoving ? "Removing" : selectedCount == 0 ? "None selected" : Format.count(selectedCount, "point"))
        .keyboardShortcut(.delete, modifiers: [])
    }

    // MARK: Below the peek

    private var hints: some View {
        VStack(alignment: .leading, spacing: 6) {
            if editing.isSelectingArea {
                Text("Select Area is on. Drag on the map to draw a box.")
            } else if selectedCount == 0 {
                Text("Tap a point, or use Select Area on the map.")
            }
            if editing.ignoredCount > 0 {
                Text("Hollow points are ones the timeline already ignores (no GPS fix, a glitch or a repeat).")
            }
        }
        .font(.subheadline)
        .foregroundStyle(.secondary)
    }

    private var ignoredIDs: Set<Int64> { Set(editing.points.filter { $0.status.isIgnored }.map(\.t)) }

    private var overview: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 18) {
                LegendDot(kind: .used, label: "Used")
                LegendDot(kind: .ignored, label: "Ignored")
                LegendDot(kind: .selected, label: "Selected")
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Legend: solid dot used, hollow dot ignored, red dot selected")

            Text(counts)
                .font(.footnote.weight(.medium))
                .foregroundStyle(.secondary)
                .monospacedDigit()

            if editing.ignoredCount > 0 {
                let ignored = ignoredIDs
                let allSelected = ignored.isSubset(of: editing.selected)
                Button {
                    withAnimation {
                        if allSelected { editing.selected.subtract(ignored) } else { editing.selected.formUnion(ignored) }
                    }
                } label: {
                    Label(allSelected ? "Deselect Ignored (\(Format.grouped(ignored.count)))" : "Select All Ignored (\(Format.grouped(ignored.count)))",
                          systemImage: "circle.dashed")
                }
                .buttonStyle(.bordered)
                .keyboardShortcut("a", modifiers: .command)
                .disabled(isRemoving)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.background.secondary, in: .rect(cornerRadius: 20))
    }

    private var counts: String {
        var text = Format.count(editing.points.count, "point")
        if editing.ignoredCount > 0 { text += " · \(Format.grouped(editing.ignoredCount)) ignored" }
        return text
    }

    // MARK: Loading and removing

    private func load() async {
        generation += 1
        let mine = generation
        let date = editing.date
        editing.isLoading = true
        loadError = nil
        defer { if generation == mine, !Task.isCancelled { editing.isLoading = false } }
        do {
            let response = try await app.service.dayPoints(date)
            guard !Task.isCancelled, generation == mine, editing.date == date else { return }
            editing.devices = response.devices
            editing.points = response.points
            editing.selected.formIntersection(Set(response.points.map(\.t)))
            if mine == 1 { applyDebugFlags() }
        } catch is CancellationError {
        } catch {
            guard !Task.isCancelled, generation == mine else { return }
            loadError = error
        }
    }

    private func remove() async {
        guard !isRemoving else { return }
        let chosen = editing.points.filter { editing.selected.contains($0.t) }
        let known = chosen.filter { editing.devices.indices.contains($0.device) }
        guard !chosen.isEmpty else { return }
        if known.isEmpty || chosen.count > Self.maxRemoval {
            failure = RemoveFailure(
                message: chosen.count > Self.maxRemoval
                    ? "Up to \(Format.grouped(Self.maxRemoval)) points can be removed at once. Select fewer points."
                    : "These points have no known device and can't be removed. Reload the day and try again.",
                refs: [], ids: [], retryable: false)
            return
        }
        await perform(known.map { PointRef(device: editing.devices[$0.device], t: $0.t) }, ids: Set(known.map(\.t)))
    }

    /// Sends the removal. Keeps going if the panel is closed meanwhile; then the outcome is told by a message.
    private func perform(_ refs: [PointRef], ids: Set<Int64>) async {
        guard !gate.isRemoving else { return }
        let app = self.app, editing = self.editing
        gate.isRemoving = true
        defer { gate.isRemoving = false }
        do {
            let result = try await app.service.removePoints(refs)
            gate.isRemoving = false // the map takes taps again while the points reload
            editing.selected.subtract(ids)
            gate.revision += 1
            app.noteDayEdited(editing.date)
            if let batch = result.batch {
                let count = result.count
                app.toasts.show(Self.undoToast(app: app, editing: editing, batch: batch, count: count))
                AccessibilityNotification.Announcement("Removed \(Format.count(count, "point"))").post()
            } else {
                app.toasts.show(Toast(message: "Those points were removed already", symbol: "info.circle.fill"))
            }
            // The points once more, without those removed (a day can have 40 000 of them: once is enough).
            if app.map.editing === editing { await load() }
        } catch {
            let message = Self.removeMessage(error)
            let retryable = (error as? ServiceError)?.isRetryable ?? true
            AccessibilityNotification.Announcement(message).post()
            if app.map.editing === editing {
                failure = RemoveFailure(message: message, refs: refs, ids: ids, retryable: retryable)
            } else {
                let text: String = "Couldn't remove " + Format.count(refs.count, "point") + ". " + message
                var again: (@MainActor () async -> Void)?
                if retryable { again = { [app, editing] in
                    do {
                        let r = try await app.service.removePoints(refs)
                        EditGate.shared.revision += 1; app.noteDayEdited(editing.date)
                        if let b = r.batch { app.toasts.show(Self.undoToast(app: app, editing: editing, batch: b, count: r.count)) }
                    } catch {
                        app.toasts.show(Self.failureToast(Self.removeMessage(error), retry: nil))
                    }
                } }
                app.toasts.show(Self.failureToast(text, retry: again))
            }
        }
    }

    /// Re-reads the points of the edit session, only while that session is still the live one.
    private static func refresh(app: AppModel, editing: EditPointsModel) async {
        guard app.map.editing === editing else { return }
        let date = editing.date
        if let again = try? await app.service.dayPoints(date), app.map.editing === editing, editing.date == date {
            editing.devices = again.devices
            editing.points = again.points
            editing.selected.formIntersection(Set(again.points.map(\.t)))
        }
    }

    private static func undoToast(app: AppModel, editing: EditPointsModel, batch: String, count: Int) -> Toast {
        Toast(message: "Removed \(Format.count(count, "point"))", actionTitle: "Undo", action: { [app, editing] in
            await undo(app: app, editing: editing, batch: batch, count: count)
        })
    }

    private static func undo(app: AppModel, editing: EditPointsModel, batch: String, count: Int) async {
        do {
            try await app.service.restorePoints(batch: batch)
            EditGate.shared.revision += 1; app.noteDayEdited(editing.date)
            await refresh(app: app, editing: editing)
            app.toasts.show(Toast(message: "Restored \(Format.count(count, "point"))"))
        } catch {
            let canRetry = (error as? ServiceError)?.isRetryable ?? true
            var again: (@MainActor () async -> Void)?
            if canRetry { again = { [app, editing] in await undo(app: app, editing: editing, batch: batch, count: count) } }
            app.toasts.show(failureToast(undoMessage(error), retry: again))
        }
    }

    private static func failureToast(_ message: String, retry: (@MainActor () async -> Void)?) -> Toast {
        var toast = Toast(message: message, symbol: "exclamationmark.triangle.fill")
        toast.duration = .seconds(10)
        if let retry {
            toast.actionTitle = "Retry"
            toast.action = retry
        }
        return toast
    }

    private static func removeMessage(_ error: any Error) -> String {
        if case ServiceError.notFound = error { return "The day no longer exists." }
        return "Could not remove: \(error.localizedDescription)"
    }

    private static func undoMessage(_ error: any Error) -> String {
        if case ServiceError.notFound = error { return "That removal has been undone already." }
        return "Could not undo: \(error.localizedDescription)"
    }

    private func applyDebugFlags() {
        #if DEBUG
        let args = ProcessInfo.processInfo.arguments
        if args.contains("-editSelectSome"), editing.selected.isEmpty {
            let step = max(1, editing.points.count / 12)
            editing.selected = Set(editing.points.enumerated().filter { $0.offset % step == 0 }.prefix(12).map(\.element.t))
        }
        if args.contains("-editInspect"), editing.inspected == nil {
            editing.inspected = editing.points.first { $0.status == .glitch }
        }
        #endif
    }
}

/// A sample dot drawn like the map draws it.
private struct LegendDot: View {
    enum Kind { case used, ignored, selected }
    let kind: Kind
    let label: String
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        HStack(spacing: 6) {
            dot
            Text(label).font(.footnote)
        }
    }

    @ViewBuilder private var dot: some View {
        switch kind {
        case .used:
            Circle().fill(scheme == .dark ? Color(white: 0.95) : Color(white: 0.11))
                .overlay(Circle().strokeBorder(scheme == .dark ? Color(white: 0.11) : .white, lineWidth: 1))
                .frame(width: 10, height: 10)
        case .ignored:
            Circle().strokeBorder(scheme == .dark ? Color.gray : Color(white: 0.42), lineWidth: 1.5)
                .frame(width: 10, height: 10)
        case .selected:
            Circle().fill(.red)
                .overlay(Circle().strokeBorder(.white, lineWidth: 2))
                .frame(width: 14, height: 14)
        }
    }
}
