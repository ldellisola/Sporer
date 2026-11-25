import SwiftUI

/// The buttons that float over the map on Liquid Glass: Settings at the top left (iPhone), and the map's own controls
/// at the top right: its style, the heat layer, recentring, and area selection in edit mode.
struct MapControls: View {
    /// How much of the map's right side the buttons take, which a drawing fitted to the map keeps clear of.
    static let columnWidth: CGFloat = 44
    /// How far below the top of the safe area the row of buttons reaches on iPhone (the Settings button and the top of the
    /// map's own controls), which a fitted drawing keeps clear of too.
    static let rowHeight: CGFloat = 68

    @Environment(\.appModel) private var app
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Namespace private var glass

    var body: some View {
        let map = app.map
        VStack {
            HStack(alignment: .top) {
                if sizeClass == .compact {
                    Button {
                        app.isShowingSettings = true
                    } label: {
                        Image(systemName: "gearshape.fill")
                            .font(.system(size: 17, weight: .semibold))
                            .frame(width: 44, height: 44)
                    }
                    .buttonStyle(.glass)
                    .buttonBorderShape(.circle)
                    .accessibilityLabel("Settings")
                }
                Spacer()
                GlassEffectContainer(spacing: 8) {
                    VStack(spacing: 0) {
                        Menu {
                            Picker("Map Style", selection: Bindable(map).style) {
                                ForEach(MapStyleChoice.allCases) { Text($0.title).tag($0) }
                            }
                            Toggle("Fade Routes in Periods", isOn: Bindable(map).fadeRoutes)
                        } label: {
                            controlIcon("map")
                        }
                        .accessibilityLabel("Map Style")
                        Divider().frame(width: 28)
                        if map.canShowHeat {
                            Button {
                                withAnimation { map.isHeatOn.toggle() }
                            } label: {
                                controlIcon(map.isHeatOn ? "flame.fill" : "flame")
                                    .foregroundStyle(map.isHeatOn ? AnyShapeStyle(.orange) : AnyShapeStyle(.primary))
                            }
                            .accessibilityLabel("Heat Map")
                            .accessibilityAddTraits(map.isHeatOn ? .isSelected : [])
                            Divider().frame(width: 28)
                        }
                        Button {
                            map.recenter()
                        } label: {
                            controlIcon("scope")
                        }
                        .accessibilityLabel("Recenter Map")
                    }
                    .buttonStyle(.plain)
                    .glassEffect(.regular.interactive(), in: .capsule)
                    .glassEffectID("controls", in: glass)

                    if let editing = map.editing {
                        Button {
                            withAnimation { editing.isSelectingArea.toggle() }
                        } label: {
                            controlIcon("rectangle.dashed")
                                .foregroundStyle(editing.isSelectingArea ? .white : .primary)
                        }
                        .buttonStyle(.plain)
                        .glassEffect(editing.isSelectingArea ? .regular.tint(.pin).interactive() : .regular.interactive(), in: .circle)
                        .glassEffectID("area", in: glass)
                        .accessibilityLabel("Select Area")
                        .accessibilityAddTraits(editing.isSelectingArea ? .isSelected : [])
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
            Spacer()
        }
        .task(id: heatKey) { await loadHeat() }
    }

    private func controlIcon(_ name: String) -> some View {
        Image(systemName: name)
            .font(.system(size: 17, weight: .medium))
            .frame(width: 44, height: 44)
            .contentShape(.rect)
    }

    /// The heat is asked for again for other days, after an edit and when the app comes back.
    private var heatKey: String {
        guard app.map.isHeatOn, let span = app.map.scene.heatSpan else { return "" }
        return "\(span.0)-\(span.1)|\(app.dataVersion)|\(app.wakeCount)"
    }

    /// Loads the heat of the drawing's days. A failure keeps the glow already drawn and tries again a little later, a few times.
    private func loadHeat() async {
        guard app.map.isHeatOn, let span = app.map.scene.heatSpan else { return }
        for delay in [0, 5, 15, 30] {
            if delay > 0 { try? await Task.sleep(for: .seconds(delay)) }
            guard !Task.isCancelled else { return }
            if let heat = try? await app.service.heat(from: span.0, to: span.1) {
                guard !Task.isCancelled else { return }
                app.map.heat = heat
                return
            }
        }
    }
}

/// Edit mode's area selection: while it is on, a drag over the map draws a box, and the points in it are selected.
struct AreaSelectionLayer: View {
    @Environment(\.appModel) private var app
    @State private var start: CGPoint?
    @State private var current: CGPoint?

    var body: some View {
        if let editing = app.map.editing, editing.isSelectingArea, !EditGate.shared.isRemoving {
            GeometryReader { _ in
                ZStack(alignment: .topLeading) {
                    Color.clear.contentShape(.rect)
                    if let rect {
                        Rectangle()
                            .fill(Color.pin.opacity(0.12))
                            .strokeBorder(Color.pin, style: StrokeStyle(lineWidth: 2, dash: [6, 4]))
                            .frame(width: rect.width, height: rect.height)
                            .offset(x: rect.minX, y: rect.minY)
                    }
                }
                .gesture(
                    DragGesture(minimumDistance: 6, coordinateSpace: .local)
                        .onChanged { value in
                            start = value.startLocation
                            current = value.location
                        }
                        .onEnded { _ in
                            if let rect, let mapRect = app.map.areaToRect?(rect) {
                                for p in editing.points where mapRect.contains(MKMapPoint(p.coordinate)) {
                                    editing.selected.insert(p.t)
                                }
                            }
                            start = nil
                            current = nil
                        }
                )
            }
            .ignoresSafeArea()
        }
    }

    private var rect: CGRect? {
        guard let start, let current else { return nil }
        return CGRect(x: min(start.x, current.x), y: min(start.y, current.y), width: abs(start.x - current.x), height: abs(start.y - current.y))
    }
}

import MapKit
