import SwiftUI

/// The parts of the app a person moves between. On iPhone they are the tabs of the sheet; on iPad and Mac, the sidebar.
enum AppSection: String, Hashable, CaseIterable, Identifiable {
    case day, explore, trips, places

    var id: String { rawValue }

    var title: String {
        switch self {
        case .day: "Day"
        case .explore: "Explore"
        case .trips: "Trips"
        case .places: "Places"
        }
    }

    var symbol: String {
        switch self {
        case .day: "sun.horizon.fill"
        case .explore: "calendar"
        case .trips: "suitcase.fill"
        case .places: "mappin.and.ellipse"
        }
    }
}

/// Where a screen is: its section, and its depth in the section's stack (0 for the section's own panel).
struct MapClaimant: Hashable {
    var section: AppSection
    var depth: Int
}

/// A screen pushed onto a section's navigation stack.
enum Route: Hashable {
    case day(LocalDate)
    case place(Int)
    case trip(String)
}

/// What the app is showing, shared by the sheet (or sidebar) and the map.
@Observable
final class AppModel {
    let service: any SporerService
    let map = MapModel()
    let toasts = ToastCenter()

    var section: AppSection = .day { didSet { updateMapScene() } }
    var paths: [AppSection: [Route]] = [:] { didSet { updateMapScene() } }

    /// The day of the Day tab.
    var day: LocalDate = .today

    /// The period of the Explore tab: its scale, a date inside it, and the dates of a custom range.
    var exploreScale: PeriodScale = .month
    var exploreAnchor: LocalDate = .today
    var exploreRange: ClosedRange<LocalDate> = LocalDate.today.adding(days: -13)...LocalDate.today

    var isShowingSettings = false

    /// The height the sheet is at on iPhone; lowered when the map needs the room.
    var detent: PresentationDetent = SheetDetents.medium

    /// Bumped after every write (an edit anywhere, a restore in Settings, a removal of points), so that what is on screen
    /// is asked for again: the days, periods, trips and places all key their loads on it.
    private(set) var dataVersion = 0

    /// Bumped when the app comes back after a while in the background: what is on screen is asked for again (`Loaded`).
    private(set) var wakeCount = 0
    private var backgroundedAt: Date?

    /// The date it was when the app last looked: when it changes, a day or a period that was "today" moves on with it.
    private var lastToday = LocalDate.today

    /// When the points of each day were last edited (a removal or its Undo): the day is pending until the server has rebuilt
    /// it, and is asked for every 3 seconds for two minutes after an edit, as the web app does.
    private var editedDays: [LocalDate: Date] = [:]

    init(service: any SporerService) {
        self.service = service
        Task { [weak self] in
            for await _ in NotificationCenter.default.notifications(named: .sporerDataChanged) {
                self?.dataVersion += 1
            }
        }
        Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                self?.rollOver()
            }
        }
        // A new zone (a flight, the phone set by hand) or a jump of the clock: today may be another date now.
        for name in [Notification.Name.NSSystemTimeZoneDidChange, UIApplication.significantTimeChangeNotification] {
            Task { [weak self] in
                for await _ in NotificationCenter.default.notifications(named: name) {
                    self?.rollOver()
                }
            }
        }
    }

    // MARK: What the map draws

    /// What each screen on show would have the map draw, by its place: its section and how deep in that section's stack it is.
    @ObservationIgnored private var mapClaims: [MapClaimant: (token: UUID, scene: MapScene)] = [:]

    /// A screen says what the map should draw while it is the screen on show (see `.mapScene(_:)`).
    func claimMap(_ scene: MapScene, by claimant: MapClaimant, token: UUID) {
        mapClaims[claimant] = (token, scene)
        updateMapScene()
    }

    /// The screen has gone: the one under it draws the map again. Only the screen that claimed the place gives it up, so that a
    /// screen replacing another at the same place (edit mode for a day) keeps it, whichever of the two is told first.
    func releaseMap(_ claimant: MapClaimant, token: UUID) {
        guard mapClaims[claimant]?.token == token else { return }
        mapClaims[claimant] = nil
        updateMapScene()
    }

    /// The map draws what the top-most screen of the section on show asks for, or the screen under it while that one has
    /// nothing to draw yet: never what a screen that is covered, or in another section, asks for later.
    private func updateMapScene() {
        let top = paths[section]?.count ?? 0
        let shown = mapClaims.filter { $0.key.section == section && $0.key.depth <= top }.max { $0.key.depth < $1.key.depth }
        if let shown { map.show(shown.value.scene) }
    }

    // MARK: Keeping what is shown fresh

    func scenePhaseChanged(to phase: ScenePhase) {
        switch phase {
        case .background:
            backgroundedAt = backgroundedAt ?? Date()
        case .active:
            rollOver()
            if let since = backgroundedAt, Date().timeIntervalSince(since) > 30 { wakeCount += 1 }
            backgroundedAt = nil
        default:
            break
        }
    }

    /// After midnight, the Day tab that was on today shows the new today, and so does a period that was anchored on it.
    func rollOver() {
        let now = LocalDate.today
        guard now != lastToday else { return }
        if day == lastToday { day = now }
        if exploreAnchor == lastToday { exploreAnchor = now }
        if exploreRange.upperBound == lastToday { exploreRange = exploreRange.lowerBound...now }
        lastToday = now
    }

    /// Notes that the points of `date` were just edited. The days either side are noted too: a day spans into its neighbours' zones.
    func noteDayEdited(_ date: LocalDate) {
        let now = Date()
        for d in [date.adding(days: -1), date, date.adding(days: 1)] { editedDays[d] = now }
    }

    /// How long until a day is asked for again: every 3 s while pending within two minutes of an edit of its points, every 30 s
    /// while pending otherwise, every minute while it is today (points keep arriving), never once it is over and done.
    func refreshInterval(for day: DayResponse) -> Duration? {
        refreshInterval(from: day.date, to: day.date, state: day.state)
    }

    /// The same for a period of days, `from` to `to` both included.
    func refreshInterval(from: LocalDate, to: LocalDate, state: LoadState) -> Duration? {
        if state == .pending {
            if from == to, let edited = editedDays[from], Date().timeIntervalSince(edited) < 120 { return .seconds(3) }
            return .seconds(30)
        }
        let today = LocalDate.today
        return from <= today && today <= to ? .seconds(60) : nil
    }

    /// Says that the server's data changed.
    static func dataChanged() {
        NotificationCenter.default.post(name: .sporerDataChanged, object: nil)
    }

    /// Opens the app on a given screen, for screenshots and UI checks:
    /// `-section explore|trips|places|day`, `-scale week|month|year|range`, `-day yyyy-MM-dd`,
    /// `-push place:1|trip:2026-09-12|day:2026-09-13`, `-settings`, `-edit`, `-detent peek|medium|large`, `-heat`.
    func applyLaunchArguments(_ arguments: [String] = ProcessInfo.processInfo.arguments) {
        func value(_ name: String) -> String? {
            guard let i = arguments.firstIndex(of: name), arguments.indices.contains(i + 1) else { return nil }
            return arguments[i + 1]
        }
        if let s = value("-section").flatMap(AppSection.init(rawValue:)) { section = s }
        if let s = value("-scale").flatMap(PeriodScale.init(rawValue:)) { exploreScale = s }
        if let d = value("-day").flatMap(LocalDate.init) { day = d; exploreAnchor = d }
        if let push = value("-push") {
            let parts = push.split(separator: ":", maxSplits: 1).map(String.init)
            if parts.count == 2 {
                switch parts[0] {
                case "place": if let id = Int(parts[1]) { paths[section] = [.place(id)] }
                case "trip": paths[section] = [.trip(parts[1])]
                case "day": if let d = LocalDate(parts[1]) { paths[section] = [.day(d)] }
                default: break
                }
            }
        }
        if arguments.contains("-settings") { isShowingSettings = true }
        if arguments.contains("-edit") { map.editing = EditPointsModel(date: day); detent = SheetDetents.peek }
        // A screenshot run says what it wants: heat on with -heat, off otherwise (the setting is not left behind).
        if value("-section") != nil || arguments.contains("-settings") { map.isHeatOn = arguments.contains("-heat") }
        switch value("-detent") {
        case "peek": detent = SheetDetents.peek
        case "large": detent = .large
        case "medium": detent = SheetDetents.medium
        default: break
        }
    }

    func path(for section: AppSection) -> Binding<[Route]> {
        Binding(
            get: { self.paths[section] ?? [] },
            set: { self.paths[section] = $0 }
        )
    }

    func open(_ route: Route) {
        paths[section, default: []].append(route)
    }

    /// Lowers a full sheet so the map shows what was tapped.
    func revealMap() {
        if detent == .large { detent = SheetDetents.medium }
    }
}

extension Notification.Name {
    /// Posted after every successful write (and after a 404 on one): what is on screen is loaded again.
    static let sporerDataChanged = Notification.Name("sporer.dataChanged")
}

/// The lengths of time the Explore tab looks at.
enum PeriodScale: String, CaseIterable, Identifiable, Hashable {
    case week, month, year, range
    var id: String { rawValue }
    var title: String {
        switch self {
        case .week: "Week"
        case .month: "Month"
        case .year: "Year"
        case .range: "Range"
        }
    }
}

enum SheetDetents {
    static let peek = PresentationDetent.height(148)
    static let medium = PresentationDetent.fraction(0.46)
    static let all: Set<PresentationDetent> = [peek, medium, .large]
}

extension AppModel {
    /// The model views get when none was put in the environment (previews).
    static let fallback = AppModel(service: MockService.shared)
}

extension EnvironmentValues {
    @Entry var appModel: AppModel = .fallback
    /// Where the screen is, for what it asks the map to draw (`.mapScene(_:)`).
    @Entry var mapClaimant = MapClaimant(section: .day, depth: 0)
}
