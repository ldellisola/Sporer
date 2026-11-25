import SwiftUI

/// How a move was made. The server tells walk, cycle, drive and flight apart; a mode it could not tell is `nil`.
nonisolated enum Mode: String, Codable, Hashable, Sendable, CaseIterable {
    case walk, cycle, drive, flight
}

extension Mode {
    var title: String {
        switch self {
        case .walk: "Walk"
        case .cycle: "Cycle"
        case .drive: "Drive"
        case .flight: "Flight"
        }
    }

    var symbol: String {
        switch self {
        case .walk: "figure.walk"
        case .cycle: "bicycle"
        case .drive: "car.fill"
        case .flight: "airplane"
        }
    }

    /// The colours of the web app's map, which are the system's: green, teal, blue, orange.
    var color: Color {
        switch self {
        case .walk: .green
        case .cycle: .teal
        case .drive: .blue
        case .flight: .orange
        }
    }

    var uiColor: UIColor {
        switch self {
        case .walk: .systemGreen
        case .cycle: .systemTeal
        case .drive: .systemBlue
        case .flight: .systemOrange
        }
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
