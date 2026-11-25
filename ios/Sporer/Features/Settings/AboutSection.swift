import SwiftUI

/// About: the version, the algorithm, where the data comes from, and the web app.
struct AboutSection: View {
    let model: SettingsModel
    @AppStorage("serverURL") private var serverURL = ServerDefaults.url

    private var version: String {
        let info = Bundle.main.infoDictionary
        let short = info?["CFBundleShortVersionString"] as? String ?? "1.0"
        let build = info?["CFBundleVersion"] as? String ?? "1"
        return "\(short) (\(build))"
    }

    private var algorithm: String {
        guard let status = model.status.value else { return "—" }
        return status.algorithmVersion ?? "Not yet processed"
    }

    var body: some View {
        Section {
            LabeledContent("Version", value: version)
            LabeledContent("Algorithm Version", value: algorithm)
            if let url = URL(string: serverURL) {
                linkRow("Open the Web App", symbol: "safari", url: url, hint: "Opens \(ServerDefaults.host(serverURL)) in the browser")
            }
        } header: {
            Text("About")
        }
        Section {
            linkRow("OpenStreetMap Contributors", symbol: "map", url: URL(string: "https://www.openstreetmap.org/copyright")!)
            linkRow("OpenFreeMap", symbol: "square.grid.3x3", url: URL(string: "https://openfreemap.org")!)
            linkRow("OpenMapTiles", symbol: "square.stack.3d.up", url: URL(string: "https://openmaptiles.org")!)
        } header: {
            Text("Acknowledgements")
        } footer: {
            Text("Map data © OpenStreetMap contributors. Place names from Nominatim. Base map by Apple.")
        }
    }

    private func linkRow(_ title: String, symbol: String, url: URL, hint: String? = nil) -> some View {
        Link(destination: url) {
            HStack {
                Label(title, systemImage: symbol)
                Spacer()
                Image(systemName: "arrow.up.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
            }
            .frame(minHeight: 44, alignment: .leading)
        }
        .accessibilityHint(hint ?? "Opens \(url.host() ?? "the page") in the browser")
    }
}
