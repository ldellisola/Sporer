import SwiftUI

/// The address the app talks to; the VPN has to be on to reach it. Kept in UserDefaults under `key` (a launch argument
/// `-serverURL http://127.0.0.1:5097` overrides it, for a local server).
nonisolated enum ServerDefaults {
    static let url = "https://sporer.lud.ar"
    static let key = "serverURL"

    /// The address the HTTP client uses now.
    static var current: String { UserDefaults.standard.string(forKey: key) ?? url }

    static func host(_ address: String) -> String {
        URL(string: address.trimmingCharacters(in: .whitespaces))?.host() ?? address
    }

    /// Trimmed, no trailing slash; nil when it isn't a web address.
    static func normalised(_ text: String) -> String? {
        var s = text.trimmingCharacters(in: .whitespacesAndNewlines)
        while s.hasSuffix("/") { s.removeLast() }
        guard let url = URL(string: s), let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http", url.host() != nil else { return nil }
        return s
    }
}

/// Server: its address and whether it answers (the status is fetched once, for this and Processing).
struct ServerSection: View {
    let model: SettingsModel
    @AppStorage("serverURL") private var serverURL = ServerDefaults.url

    var body: some View {
        Section {
            NavigationLink {
                ServerAddressView { await model.loadAll() }
            } label: {
                LabeledContent("Server", value: ServerDefaults.host(serverURL))
            }
            statusRow
            if model.status.error != nil {
                Button {
                    Task { await model.loadAll() }
                } label: {
                    Label("Try Again", systemImage: "arrow.clockwise").frame(minHeight: 44, alignment: .leading)
                }
            }
        } header: {
            Text("Server")
        } footer: {
            Text("Your server is only reachable over the VPN.")
        }
        .id("settings-server")
    }

    private var statusRow: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("Status")
                Spacer(minLength: 8)
                if model.status.error != nil {
                    Label("Can't Connect", systemImage: "xmark.octagon.fill").foregroundStyle(.red)
                } else if model.status.value != nil {
                    Label("Connected", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                } else {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("Checking…").foregroundStyle(.secondary)
                    }
                }
            }
            if let error = model.status.error {
                Text(error.localizedDescription).font(.subheadline).foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// Where the server is. Kept on the device; the HTTP client reads it. Edited as a draft and saved with Save.
struct ServerAddressView: View {
    @AppStorage("serverURL") private var serverURL = ServerDefaults.url
    @Environment(\.dismiss) private var dismiss
    var onSaved: () async -> Void

    @State private var draft = ""
    @State private var didLoad = false

    private var normalised: String? { ServerDefaults.normalised(draft) }
    private var isChanged: Bool { normalised != nil && normalised != serverURL }

    var body: some View {
        Form {
            Section {
                TextField("Server Address", text: $draft, prompt: Text(ServerDefaults.url))
                    .keyboardType(.URL)
                    .textContentType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .onSubmit { save() }
                    .accessibilityLabel("Server Address")
                if normalised == nil {
                    Label("Enter a web address, like \(ServerDefaults.url).", systemImage: "exclamationmark.circle.fill")
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
            } footer: {
                Text("Your Sporer server is only reachable over the VPN. Connect to it before you open the app away from home.")
            }
            Section {
                Button("Use Default Address") { draft = ServerDefaults.url }
                    .disabled(draft == ServerDefaults.url)
            }
        }
        .navigationTitle("Server Address")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Save", role: .confirm) { save() }.disabled(!isChanged)
            }
        }
        .onAppear { if !didLoad { draft = serverURL; didLoad = true } }
    }

    private func save() {
        guard let value = normalised, isChanged else { return }
        serverURL = value
        AppModel.dataChanged() // every screen asks the new server
        dismiss()
        Task { await onSaved() }
    }
}
