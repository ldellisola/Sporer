#if DEBUG
import UIKit

/// `-snapshot /path/to/file.png [-snapshotDelay 5]`: the app draws its own window into a PNG after a few seconds,
/// for checking layouts on the Mac, where a window cannot be captured from outside without Screen Recording access.
enum DebugSnapshot {
    static func scheduleIfAsked(_ arguments: [String] = ProcessInfo.processInfo.arguments) {
        guard let i = arguments.firstIndex(of: "-snapshot"), arguments.indices.contains(i + 1) else { return }
        let path = arguments[i + 1]
        let delay = arguments.firstIndex(of: "-snapshotDelay").flatMap { arguments.indices.contains($0 + 1) ? Double(arguments[$0 + 1]) : nil } ?? 5
        func log(_ m: String) { FileHandle.standardError.write(("[snapshot] " + m + "\n").data(using: .utf8)!) }
        log("scheduled \(path) in \(delay)s")
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(delay))
            log("scenes \(UIApplication.shared.connectedScenes.count)")
            let windows = UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .flatMap(\.windows)
                .filter { !$0.isHidden }
            guard let window = windows.first(where: \.isKeyWindow) ?? windows.first else { log("no window"); return }
            let format = UIGraphicsImageRendererFormat()
            format.scale = window.screen.scale
            let image = UIGraphicsImageRenderer(bounds: window.bounds, format: format).image { _ in
                for w in windows.sorted(by: { $0.windowLevel < $1.windowLevel }) {
                    w.drawHierarchy(in: w.frame, afterScreenUpdates: true)
                }
            }
            do {
                try image.pngData()?.write(to: URL(fileURLWithPath: path))
                log("wrote \(image.size)")
            } catch {
                log("failed: \(error)")
            }
        }
    }
}
#endif
