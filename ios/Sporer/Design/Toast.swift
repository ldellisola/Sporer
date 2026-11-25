import SwiftUI

/// A short message after a write ("Removed 3 points", "Restored Lisbon · 12 – 16 Sep 2026"), with an action such as Undo.
/// It goes by itself after a while; one at a time.
struct Toast: Identifiable, Equatable {
    let id = UUID()
    var message: String
    var symbol: String = "checkmark.circle.fill"
    var actionTitle: String?
    var action: (@MainActor () async -> Void)?
    var duration: Duration = .seconds(6)

    static func == (a: Toast, b: Toast) -> Bool { a.id == b.id }
}

@Observable
final class ToastCenter {
    var current: Toast?

    func show(_ toast: Toast) {
        withAnimation(.snappy) { current = toast }
    }

    func dismiss(_ toast: Toast) {
        guard current?.id == toast.id else { return }
        withAnimation(.snappy) { current = nil }
    }
}

/// Where toasts appear: over the top of the map, clear of the sheet and the bars.
struct ToastOverlay: View {
    let center: ToastCenter
    @State private var isActing = false

    var body: some View {
        VStack {
            if let toast = center.current {
                HStack(spacing: 12) {
                    Image(systemName: toast.symbol)
                        .foregroundStyle(.green)
                    Text(toast.message)
                        .font(.subheadline.weight(.medium))
                        .lineLimit(2)
                    if let title = toast.actionTitle, let action = toast.action {
                        Button {
                            isActing = true
                            Task {
                                await action()
                                isActing = false
                                center.dismiss(toast)
                            }
                        } label: {
                            if isActing { ProgressView().controlSize(.small) } else { Text(title).fontWeight(.semibold) }
                        }
                        .buttonStyle(.borderless)
                        .disabled(isActing)
                    }
                }
                .padding(.horizontal, 18)
                .padding(.vertical, 12)
                .glassEffect(.regular, in: .capsule)
                .transition(.move(edge: .top).combined(with: .opacity))
                .task(id: toast.id) {
                    try? await Task.sleep(for: toast.duration)
                    if !isActing { center.dismiss(toast) }
                }
                .accessibilityElement(children: .contain)
                .accessibilityAddTraits(.updatesFrequently)
            }
            Spacer()
        }
        .padding(.top, 64)
        .padding(.horizontal, 16)
        .frame(maxWidth: .infinity)
    }
}
