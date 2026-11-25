import SwiftUI

/// Bumped after every write to a trip (edit, delete, undo) and by pull to refresh, so the list and the open trip load again
/// (the service itself tells every other screen after a write).
/// Also keeps the last list of trips, so the open trip can step to its neighbours without loading it again.
@Observable
final class TripsRevision {
    static let shared = TripsRevision()
    private(set) var value = 0
    /// The trips as last loaded, newest first.
    var cache: [TripListItem] = []
    /// Trips deleted in this run, hidden from the neighbours before the list has loaded again.
    private(set) var deleted: Set<String> = []

    func bump() { value += 1 }
    func markDeleted(_ id: String) { deleted.insert(id) }
    func unmarkDeleted(_ id: String) { deleted.remove(id) }

    var visible: [TripListItem] { cache.filter { !deleted.contains($0.id) } }

    func rename(_ old: String, to new: String) {
        guard let i = cache.firstIndex(where: { $0.id == old }) else { return }
        cache[i].id = new
    }
}

extension AppModel {
    /// Removes the trip's route from whichever stack holds it, one level, never the whole stack.
    func popTrip(_ id: String) {
        for key in Array(paths.keys) {
            if let i = paths[key]?.lastIndex(of: .trip(id)) { paths[key]?.remove(at: i) }
        }
    }

    /// Shows another trip where this one was.
    func replaceTrip(_ old: String, with new: String) {
        for key in Array(paths.keys) {
            if let i = paths[key]?.lastIndex(of: .trip(old)) { paths[key]?[i] = .trip(new) }
        }
    }
}

/// The writes both the list (swipe) and the trip page (menu) make.
enum TripActions {
    /// Deletes a trip and offers Undo in a toast.
    static func delete(id: String, name: String, app: AppModel) async throws {
        TripsRevision.shared.markDeleted(id)
        do {
            try await app.service.deleteTrip(id)
        } catch {
            TripsRevision.shared.unmarkDeleted(id)
            throw error
        }
        TripsRevision.shared.bump()
        app.toasts.show(Toast(message: "Deleted \(name)", actionTitle: "Undo", action: {
            do {
                try await app.service.restoreTrip(key: id)
                TripsRevision.shared.unmarkDeleted(id)
                TripsRevision.shared.bump()
            } catch {
                app.toasts.show(Toast(message: "Couldn't restore \(name)", symbol: "exclamationmark.triangle.fill"))
            }
        }))
    }

    static let deleteMessage = "It stays deleted when your data is reprocessed. You can restore it in Settings."
    static let overlapMessage = "This trip overlaps another trip. Change the dates and try again."

    /// The words of a refusal.
    static func message(for error: any Error) -> String {
        switch error as? ServiceError {
        case .notFound: "This trip no longer exists."
        case .conflict: overlapMessage
        default: error.localizedDescription
        }
    }
}

#if DEBUG
/// Opens the edit sheet or the delete dialog from a launch argument, for screenshots.
private struct TripsDebugFlags: ViewModifier {
    @Binding var isEditing: Bool
    @Binding var isConfirmingDelete: Bool
    @State private var applied = false

    func body(content: Content) -> some View {
        content.onAppear {
            guard !applied else { return }
            applied = true
            let args = ProcessInfo.processInfo.arguments
            if args.contains("-tripsEdit") { isEditing = true }
            if args.contains("-tripsDelete") { isConfirmingDelete = true }
        }
    }
}
#endif

extension View {
    func tripsDebugFlags(isEditing: Binding<Bool>, isConfirmingDelete: Binding<Bool>) -> some View {
        #if DEBUG
        modifier(TripsDebugFlags(isEditing: isEditing, isConfirmingDelete: isConfirmingDelete))
        #else
        self
        #endif
    }
}

/// A trip's route in a small rounded tile: home, the overnight places, home. Drawn, not a live map.
struct TripThumbnail: View {
    let points: [LonLat]
    var ongoing = false
    var size = CGSize(width: 64, height: 48)

    var body: some View {
        Canvas { context, canvas in
            let projected = Self.project(points, in: CGRect(origin: .zero, size: canvas).insetBy(dx: 9, dy: 9))
            let tint = Color.pin
            switch projected {
            case .none: break
            case .single(let p):
                context.fill(Path(ellipseIn: CGRect(x: p.x - 3.5, y: p.y - 3.5, width: 7, height: 7)), with: .color(tint))
            case .line(let pts):
                var path = Path()
                path.addLines(pts)
                context.stroke(path, with: .color(tint.opacity(0.75)), style: StrokeStyle(lineWidth: 1.6, lineCap: .round, lineJoin: .round))
                for p in pts.dropFirst().dropLast() {
                    context.fill(Path(ellipseIn: CGRect(x: p.x - 2.5, y: p.y - 2.5, width: 5, height: 5)), with: .color(tint))
                }
                if ongoing, let last = pts.last {
                    context.fill(Path(ellipseIn: CGRect(x: last.x - 3.5, y: last.y - 3.5, width: 7, height: 7)), with: .color(.green))
                }
                if let first = pts.first {
                    context.fill(Path(ellipseIn: CGRect(x: first.x - 3, y: first.y - 3, width: 6, height: 6)), with: .color(.primary.opacity(0.55)))
                }
            }
        }
        .frame(width: size.width, height: size.height)
        .background(.quaternary, in: .rect(cornerRadius: 12, style: .continuous))
        .accessibilityHidden(true)
    }

    private enum Projection {
        case none
        case single(CGPoint)
        case line([CGPoint])
    }

    /// Longitude is scaled by cos(latitude) so the shape is not stretched; the shape is centred and fitted to the rect.
    private static func project(_ points: [LonLat], in rect: CGRect) -> Projection {
        guard !points.isEmpty else { return .none }
        let meanLat = points.reduce(0) { $0 + $1.lat } / Double(points.count)
        let k = max(0.05, cos(meanLat * .pi / 180))
        let xs = points.map { $0.lon * k }
        let ys = points.map(\.lat)
        let minX = xs.min()!, maxX = xs.max()!, minY = ys.min()!, maxY = ys.max()!
        let w = maxX - minX, h = maxY - minY
        let center = CGPoint(x: rect.midX, y: rect.midY)
        // Under ~100 m the trip is one point.
        guard max(w, h) > 0.001 else { return .single(center) }
        let scale = min(w > 0 ? rect.width / w : .infinity, h > 0 ? rect.height / h : .infinity)
        let cx = (minX + maxX) / 2, cy = (minY + maxY) / 2
        return .line(zip(xs, ys).map { CGPoint(x: center.x + (($0 - cx) * scale), y: center.y - (($1 - cy) * scale)) })
    }
}
