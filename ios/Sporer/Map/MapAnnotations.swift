import MapKit
import UIKit

/// A stop of a day, or the place of the place view: a pink disc with the stay numbers, a house for home, or a pin for a place on
/// its own, with its name under it. Where names would cover other stops or each other, the map shows those of the stops with the
/// lowest `rank` (the most time spent) and hides the others (`SporerMapView.Coordinator.layOutStopNames`).
final class StopAnnotation: NSObject, MKAnnotation {
    let coordinate: CLLocationCoordinate2D
    let placeID: Int?
    let label: String
    let isHome: Bool
    let name: String?
    /// The segments of the day this stop stands for, to light it up when one of them is focused.
    let segmentIDs: [String]
    /// 0 for the stop whose name matters most.
    let rank: Int

    init(coordinate: CLLocationCoordinate2D, placeID: Int?, label: String, isHome: Bool, name: String?, segmentIDs: [String], rank: Int = 0) {
        self.coordinate = coordinate
        self.placeID = placeID
        self.label = label
        self.isHome = isHome
        self.name = name
        self.segmentIDs = segmentIDs
        self.rank = rank
    }

    var title: String? { name }
}

final class StopAnnotationView: MKAnnotationView {
    static let reuseID = "stop"

    private let disc = UIView()
    private let glyph = UILabel()
    private let icon = UIImageView()
    private let nameLabel = HaloLabel()

    override init(annotation: (any MKAnnotation)?, reuseIdentifier: String?) {
        super.init(annotation: annotation, reuseIdentifier: reuseIdentifier)
        displayPriority = .required
        canShowCallout = false

        disc.backgroundColor = .pin
        disc.layer.borderColor = UIColor.white.cgColor
        disc.layer.borderWidth = 2.5
        disc.layer.shadowColor = UIColor.black.cgColor
        disc.layer.shadowOpacity = 0.25
        disc.layer.shadowRadius = 3
        disc.layer.shadowOffset = CGSize(width: 0, height: 1)
        addSubview(disc)

        glyph.font = UIFont.systemFont(ofSize: 13, weight: .bold).rounded
        glyph.textColor = .white
        glyph.textAlignment = .center
        disc.addSubview(glyph)

        icon.tintColor = .white
        icon.contentMode = .center
        icon.preferredSymbolConfiguration = .init(pointSize: 13, weight: .bold)
        disc.addSubview(icon)

        nameLabel.font = .systemFont(ofSize: 12, weight: .semibold)
        nameLabel.textAlignment = .center
        nameLabel.numberOfLines = 2
        addSubview(nameLabel)
    }

    required init?(coder: NSCoder) { fatalError() }

    override var annotation: (any MKAnnotation)? {
        didSet { configure() }
    }

    var isStopFocused = false {
        didSet {
            guard isStopFocused != oldValue else { return }
            UIView.animate(withDuration: 0.25, delay: 0, usingSpringWithDamping: 0.6, initialSpringVelocity: 0) {
                self.disc.transform = self.isStopFocused ? CGAffineTransform(scaleX: 1.25, y: 1.25) : .identity
            }
        }
    }

    /// Whether the name shows; the map hides it where it would cover another stop or a more important name.
    var showsName: Bool {
        get { !nameLabel.isHidden }
        set { nameLabel.isHidden = !newValue }
    }

    /// The disc and the name on the map, for a stop whose place is at `point` of the map view (the disc's centre is on it).
    /// Worked out from the place, not with `convert`: MapKit keeps annotation views out of the map view's own hierarchy.
    func frames(at point: CGPoint) -> (disc: CGRect, name: CGRect?) {
        let shift = CGPoint(x: point.x - disc.center.x, y: point.y - disc.center.y)
        let discFrame = disc.frame.offsetBy(dx: shift.x, dy: shift.y)
        let nameFrame = nameLabel.text == nil ? nil : nameLabel.frame.offsetBy(dx: shift.x, dy: shift.y).insetBy(dx: -2, dy: -1)
        return (discFrame, nameFrame)
    }

    private func configure() {
        guard let stop = annotation as? StopAnnotation else { return }
        let textWidth = (stop.label as NSString).size(withAttributes: [.font: glyph.font!]).width
        let diameter = stop.isHome || stop.label.isEmpty ? 28 : max(28, textWidth + 16)
        // A stop shows its numbers, home a house, and a place on its own (the place view) a pin.
        glyph.text = stop.isHome || stop.label.isEmpty ? nil : stop.label
        icon.image = stop.isHome ? UIImage(systemName: "house.fill") : (stop.label.isEmpty ? UIImage(systemName: "mappin") : nil)
        disc.backgroundColor = .pin
        // Where home and a numbered stop overlap, the numbers stay readable on top; the house still shows round them.
        zPriority = stop.isHome ? MKAnnotationViewZPriority(rawValue: 400) : MKAnnotationViewZPriority(rawValue: 500)
        nameLabel.text = stop.name
        nameLabel.isHidden = false
        let nameSize = nameLabel.sizeThatFits(CGSize(width: 140, height: 40))
        let width = max(diameter, min(140, nameSize.width))
        let height = diameter + (stop.name == nil ? 0 : nameSize.height + 2)
        frame.size = CGSize(width: width, height: height)
        disc.frame = CGRect(x: (width - diameter) / 2, y: 0, width: diameter, height: diameter)
        disc.layer.cornerRadius = diameter / 2
        glyph.frame = disc.bounds
        icon.frame = disc.bounds
        nameLabel.frame = CGRect(x: 0, y: diameter + 2, width: width, height: nameSize.height)
        // The disc's centre sits on the place.
        centerOffset = CGPoint(x: 0, y: height / 2 - diameter / 2)
        accessibilityLabel = stop.isHome ? "Home, \(stop.name ?? "Unnamed place")" : "Stop \(stop.label), \(stop.name ?? "Unnamed place")"
        isAccessibilityElement = true
    }
}

/// A label beside a dot or under a stop: the places of a period ("Barcode"), the cities of trips ("Lisbon · 4 nights"), the name of a
/// stop. Where labels would overlap each other or a stop, the map shows the one of higher `priority` and hides the other.
final class DotLabelAnnotation: NSObject, MKAnnotation {
    enum Side { case left, right, below }

    let coordinate: CLLocationCoordinate2D
    let text: String
    /// The radius of what it labels, so that the label clears it.
    let radius: CGFloat
    /// Labels west of the drawing's middle go on the right of their dot, the others on the left, to stay inside the drawing; a
    /// stop's name goes under it.
    let side: Side
    let priority: MKFeatureDisplayPriority

    init(coordinate: CLLocationCoordinate2D, text: String, radius: CGFloat, side: Side, priority: MKFeatureDisplayPriority = .defaultHigh) {
        self.coordinate = coordinate
        self.text = text
        self.radius = radius
        self.side = side
        self.priority = priority
    }
}

final class DotLabelAnnotationView: MKAnnotationView {
    static let reuseID = "dotLabel"
    private let label = HaloLabel()

    override init(annotation: (any MKAnnotation)?, reuseIdentifier: String?) {
        super.init(annotation: annotation, reuseIdentifier: reuseIdentifier)
        label.font = .systemFont(ofSize: 12, weight: .semibold)
        label.textAlignment = .center
        label.numberOfLines = 2
        addSubview(label)
        collisionMode = .rectangle
        displayPriority = .defaultHigh
        isEnabled = false
    }

    required init?(coder: NSCoder) { fatalError() }

    override var annotation: (any MKAnnotation)? {
        didSet {
            guard let a = annotation as? DotLabelAnnotation else { return }
            label.text = a.text
            displayPriority = a.priority
            let size = label.sizeThatFits(CGSize(width: a.side == .below ? 140 : 200, height: 40))
            frame.size = size
            label.frame = CGRect(origin: .zero, size: size)
            switch a.side {
            case .left: centerOffset = CGPoint(x: -(size.width / 2 + a.radius + 4), y: 0)
            case .right: centerOffset = CGPoint(x: size.width / 2 + a.radius + 4, y: 0)
            case .below: centerOffset = CGPoint(x: 0, y: size.height / 2 + a.radius + 2)
            }
        }
    }
}

/// Text with a halo of the map's background, so it reads over roads and routes.
final class HaloLabel: UILabel {
    override func drawText(in rect: CGRect) {
        guard let context = UIGraphicsGetCurrentContext() else { return super.drawText(in: rect) }
        let ink = textColor
        context.setLineWidth(3.5)
        context.setLineJoin(.round)
        context.setTextDrawingMode(.stroke)
        textColor = traitCollection.userInterfaceStyle == .dark ? UIColor(white: 0.11, alpha: 0.95) : UIColor(white: 1, alpha: 0.95)
        super.drawText(in: rect)
        context.setTextDrawingMode(.fill)
        textColor = ink
        super.drawText(in: rect)
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        textColor = .label
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (label: HaloLabel, _) in
            label.setNeedsDisplay()
        }
    }

    required init?(coder: NSCoder) { fatalError() }
}

extension UIFont {
    var rounded: UIFont {
        guard let descriptor = fontDescriptor.withDesign(.rounded) else { return self }
        return UIFont(descriptor: descriptor, size: pointSize)
    }
}
