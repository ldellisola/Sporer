import SwiftUI

/// How a move was made. The server tells walk, cycle, drive, bus, train and flight apart; a mode it could not tell is `nil`, and so
/// is a mode this app does not know yet (see the decoding below).
nonisolated enum Mode: String, Codable, Hashable, Sendable, CaseIterable {
    case walk, cycle, drive, bus, train, flight
}

extension Mode {
    var title: String {
        switch self {
        case .walk: "Walk"
        case .cycle: "Cycle"
        case .drive: "Drive"
        case .bus: "Bus"
        case .train: "Train"
        case .flight: "Flight"
        }
    }

    var symbol: String {
        switch self {
        case .walk: "figure.walk"
        case .cycle: "bicycle"
        case .drive: "car.fill"
        case .bus: "bus.fill"
        case .train: "train.side.front.car"
        case .flight: "airplane"
        }
    }

    /// The colours of the web app's map, which are the system's: green, teal, blue, brown, purple, orange.
    var color: Color {
        switch self {
        case .walk: .green
        case .cycle: .teal
        case .drive: .blue
        case .bus: .brown
        case .train: .purple
        case .flight: .orange
        }
    }

    var uiColor: UIColor {
        switch self {
        case .walk: .systemGreen
        case .cycle: .systemTeal
        case .drive: .systemBlue
        case .bus: .systemBrown
        case .train: .systemPurple
        case .flight: .systemOrange
        }
    }
}

extension KeyedDecodingContainer {
    /// A mode the app does not know, from a server newer than the app, reads as no mode, so that one move never makes a whole
    /// day, period or trip unreadable. Every `Mode?` of the API's types is read through here: their synthesized decoders call
    /// `decodeIfPresent(Mode.self, forKey:)`, which picks this over the generic one (DecodingTests checks the day, range and trip).
    nonisolated func decodeIfPresent(_ type: Mode.Type, forKey key: Key) throws -> Mode? {
        guard let raw = try decodeIfPresent(String.self, forKey: key) else { return nil }
        return Mode(rawValue: raw)
    }
}

/// The title, symbol and colour of a move whose mode may be unknown.
struct ModeStyle {
    let mode: Mode?
    var title: String { mode?.title ?? "Move" }
    var symbol: String { mode?.symbol ?? "point.topleft.down.to.point.bottomright.curvepath" }
    var color: Color { mode?.color ?? .gray }
    var uiColor: UIColor { mode?.uiColor ?? .systemGray }
}

extension Color {
    /// The pink of the stop pins and the app icon.
    static let pin = Color(red: 1, green: 0x37 / 255, blue: 0x5F / 255)
}

extension UIColor {
    static let pin = UIColor(red: 1, green: 0x37 / 255, blue: 0x5F / 255, alpha: 1)
}
