import SwiftUI

/// The writes on a place, for wording what the server answered.
enum PlaceOperation {
    case rename, merge, separate, home

    var failureTitle: String {
        switch self {
        case .rename: "Couldn't Rename"
        case .merge: "Couldn't Merge"
        case .separate: "Couldn't Separate"
        case .home: "Couldn't Set Home"
        }
    }

    /// The web app's words for what the server answered.
    func message(for error: any Error) -> String {
        if let error = error as? ServiceError {
            switch (self, error) {
            case (.rename, .notFound): return "This place no longer exists."
            case (.merge, .notFound): return "One of the places no longer exists."
            case (.separate, .notFound): return "It is not merged into this place any more."
            case (.home, .notFound): return "That place no longer exists."
            case (.merge, .conflict(let detail)), (.home, .conflict(let detail)): return detail
            default: break
            }
        }
        let verb = switch self {
        case .rename: "rename"
        case .merge: "merge"
        case .separate: "separate"
        case .home: "set home"
        }
        return "Could not \(verb): \(error.localizedDescription)"
    }

    /// The place (or the link between two) is gone: read it again rather than act on it.
    func isGone(_ error: any Error) -> Bool {
        if case ServiceError.notFound = error { return true }
        return false
    }
}

struct PlaceFailure: Identifiable {
    let id = UUID()
    var title: String
    var message: String
}

/// Write state of the place screen, kept above the loaded content so a reload never resets it.
@Observable
final class PlaceWriter {
    var failure: PlaceFailure?
    var isWorking = false
    /// The merged place being separated, for its row's spinner.
    var separatingID: Int?
}

enum PlaceText {
    /// "55d 20h" from 100 hours on, else the usual "8h 32m".
    static func total(_ seconds: Double) -> String {
        let hours = Int(seconds / 3600)
        guard hours >= 100 else { return Format.duration(seconds) }
        let days = hours / 24, rest = hours % 24
        return rest > 0 ? "\(days)d \(rest)h" : "\(days)d"
    }

    /// "9 hours 20 minutes", for VoiceOver.
    static func spoken(_ seconds: Double) -> String {
        let s = max(0, Int(seconds))
        let h = s / 3600, m = (s % 3600) / 60
        var parts: [String] = []
        if h > 0 { parts.append(Format.count(h, "hour")) }
        if m > 0 { parts.append(Format.count(m, "minute")) }
        if parts.isEmpty { parts.append(Format.count(s, "second")) }
        return parts.joined(separator: " ")
    }
}
