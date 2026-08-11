import AuthenticationServices
import SwiftUI

enum AppTheme {
    static let background = Color(uiColor: .systemBackground)
    static let panel = Color(uiColor: .systemGray6).opacity(0.4)
    static let panelElevated = Color(uiColor: .systemGray5).opacity(0.6)
    static let borderColor = Color(uiColor: .separator)
    static let primaryGradient = LinearGradient(colors: [.blue, .indigo], startPoint: .topLeading, endPoint: .bottomTrailing)
    
    // Web app aesthetic alignment
    static let houseColor = Color.blue.opacity(0.8)
    static let senateColor = Color.purple.opacity(0.8)
    static let execColor = Color.orange.opacity(0.8)

    static func border(cornerRadius: CGFloat = 16) -> some View {
        RoundedRectangle(cornerRadius: cornerRadius)
            .stroke(borderColor, lineWidth: 1)
    }
}

// Helper for Party Emojis
extension String {
    var partyEmoji: String {
        switch self.lowercased() {
        case "democrat", "dem", "d": return "🫏"
        case "republican", "rep", "r": return "🐘"
        default: return "🦅" // Independent/Other
        }
    }
    
    var chamberLabel: String {
        switch self.lowercased() {
        case "house": return "House"
        case "senate": return "Senate"
        case "executive": return "Executive"
        default: return self.capitalized
        }
    }
}

struct MetricTile: View {
    let title: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(value)
                .font(.subheadline.weight(.bold))
                .lineLimit(1)
                .minimumScaleFactor(0.75)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12))
        .background(AppTheme.panelElevated, in: RoundedRectangle(cornerRadius: 12))
    }
}

struct StatusPill: View {
    let text: String
    let color: Color
    var icon: String? = nil
    var compact: Bool = false

    var body: some View {
        HStack(spacing: compact ? 2 : 4) {
            if let icon {
                Image(systemName: icon)
            }
            Text(text)
        }
        .font(compact ? .caption2.weight(.bold) : .caption.weight(.bold))
        .padding(.horizontal, compact ? 7 : 10)
        .padding(.vertical, compact ? 3 : 6)
        .foregroundStyle(color)
        .background(color.opacity(0.15), in: Capsule())
        .overlay(Capsule().stroke(color.opacity(0.3), lineWidth: 1))
    }
}

/// Selectable capsule chip used by delivery filters and similar multi-select UIs.
struct FilterChip: View {
    let title: String
    let isSelected: Bool
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.caption.weight(.semibold))
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                .foregroundStyle(isSelected ? Color.white : Color.primary)
                .background(
                    isSelected ? Color.accentColor : Color(uiColor: .systemGray5),
                    in: Capsule()
                )
        }
        .buttonStyle(.plain)
    }
}

struct AssetMark: View {
    let symbol: String
    var isTicker: Bool = true
    var size: CGFloat = 48
    @Environment(\.colorScheme) private var colorScheme

    private var themedLogoURL: URL? {
        guard isTicker else { return nil }
        let trimmed = symbol.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        guard let encodedSymbol = trimmed.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) else {
            return nil
        }
        // Logos are served at site origin, not under /api/client/v1.
        let origin = CongressTradeAPIClient.defaultBaseURL
            .deletingLastPathComponent() // v1
            .deletingLastPathComponent() // client
            .deletingLastPathComponent() // api
        guard var components = URLComponents(url: origin, resolvingAgainstBaseURL: false) else {
            return nil
        }
        components.path = "/api/logos/ticker"
        components.queryItems = [
            URLQueryItem(name: "symbol", value: encodedSymbol),
            URLQueryItem(name: "theme", value: colorScheme == .dark ? "dark" : "light")
        ]
        return components.url
    }

    var body: some View {
        // No monogram / blue-square placeholders: when there is no real logo,
        // take zero space so asset + politician names get the width.
        if let url = themedLogoURL {
            AsyncImage(url: url) { phase in
                switch phase {
                case .success(let image):
                    image
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .padding(size * 0.12)
                        .frame(width: size, height: size)
                        .background(
                            colorScheme == .dark
                                ? Color(uiColor: .secondarySystemBackground)
                                : Color.white,
                            in: RoundedRectangle(cornerRadius: size * 0.22)
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: size * 0.22)
                                .stroke(AppTheme.borderColor, lineWidth: 1)
                        )
                default:
                    EmptyView()
                }
            }
        }
    }
}

/// Compact money/count formatting (Trends KPIs + trade amount brackets).
/// Fleet UI copy: lowercase suffixes `$15k`, `$99.8k`, `$1.2m`, `$3.4b`.
enum CompactFormat {
    static func usd(_ value: Double?) -> String {
        guard let value else { return "—" }
        let absV = abs(value)
        let sign = value < 0 ? "-" : ""
        if absV >= 1_000_000_000 {
            return "\(sign)$\(Self.compactNumber(absV / 1_000_000_000))b"
        }
        if absV >= 1_000_000 {
            return "\(sign)$\(Self.compactNumber(absV / 1_000_000))m"
        }
        if absV >= 1_000 {
            return "\(sign)$\(Self.compactNumber(absV / 1_000))k"
        }
        return "\(sign)$\(String(format: "%.0f", absV))"
    }

    /// STOCK Act-style bracket floors/ceilings: `$15k`, `$50k`, `$500k`, `$1m`.
    static func usdBracket(_ value: Int) -> String {
        usd(Double(value))
    }

    /// Display-only integer grouping (`22,293`). Storage/API stay bare numbers.
    /// Always full digits with thousand separators — no k/m abbreviation for counts.
    static func count(_ value: Int?) -> String {
        guard let value else { return "—" }
        return value.formatted(.number.grouping(.automatic))
    }

    /// District ordinal for display: `1` → `1st`, `2` → `2nd`, `3` → `3rd`, `11` → `11th`.
    /// Non-numeric values pass through unchanged. Display-only.
    static func districtOrdinal(_ raw: String?) -> String {
        guard let raw = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else {
            return ""
        }
        guard raw.range(of: #"^\d+(?:st|nd|rd|th)?$"#, options: [.regularExpression, .caseInsensitive]) != nil else {
            return raw
        }
        let digits = String(raw.prefix(while: \.isNumber))
        guard let n = Int(digits), n > 0 else { return raw }
        let suffix: String
        let mod100 = n % 100
        if (11...13).contains(mod100) {
            suffix = "th"
        } else {
            switch n % 10 {
            case 1: suffix = "st"
            case 2: suffix = "nd"
            case 3: suffix = "rd"
            default: suffix = "th"
            }
        }
        return "\(n)\(suffix)"
    }

    /// Drop trailing `.0` so `$1.0m` → `$1m`, keep `$1.2m` / `$15k`.
    private static func compactNumber(_ value: Double) -> String {
        if value == value.rounded(.towardZero) || abs(value - value.rounded()) < 0.05 {
            return String(format: "%.0f", value.rounded())
        }
        return String(format: "%.1f", value)
    }
}

struct DetailSection<Content: View>: View {
    let title: String
    let content: Content

    init(_ title: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.caption.weight(.bold))
                .foregroundStyle(.secondary)
                .textCase(.uppercase)
            content
        }
        .padding(16)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16))
        .background(AppTheme.panel, in: RoundedRectangle(cornerRadius: 16))
        .overlay(AppTheme.border(cornerRadius: 16))
    }
}

struct DetailRow: View {
    let label: String
    let value: String

    init(_ label: String, _ value: String) {
        self.label = label
        self.value = value
    }

    var body: some View {
        HStack(alignment: .top) {
            Text(label)
                .foregroundStyle(.secondary)
            Spacer(minLength: 18)
            Text(value)
                .multilineTextAlignment(.trailing)
                .fontWeight(.medium)
        }
        .font(.subheadline)
    }
}

struct NoticeView: View {
    let message: String

    var body: some View {
        Text(message)
            .font(.footnote)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12))
            .background(AppTheme.panel, in: RoundedRectangle(cornerRadius: 12))
            .overlay(AppTheme.border(cornerRadius: 12))
    }
}

struct FeedFreshnessView: View {
    let isOffline: Bool
    let lastRefresh: Date?
    let notice: String?
    let onRetry: () -> Void

    var body: some View {
        if isOffline || notice != nil || lastRefresh != nil {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Image(systemName: isOffline ? "wifi.slash" : "clock.arrow.circlepath")
                    .foregroundStyle(isOffline ? .orange : .secondary)
                VStack(alignment: .leading, spacing: 3) {
                    if let notice {
                        Text(notice)
                            .font(.footnote)
                    }
                    if let lastRefresh {
                        Text("Updated \(lastRefresh.formatted(.relative(presentation: .named)))")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer()
                if notice != nil {
                    Button("Retry", action: onRetry)
                        .buttonStyle(.bordered)
                        .clipShape(Capsule())
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12))
            .background(AppTheme.panel, in: RoundedRectangle(cornerRadius: 12))
            .overlay(AppTheme.border(cornerRadius: 12))
        }
    }
}

@MainActor
enum DisplayFormatters {
    static let inputDate: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    static let shortDate: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .none
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        return formatter
    }()

    static let longDate: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .long
        formatter.timeStyle = .none
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        return formatter
    }()

    static let currency: NumberFormatter = {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = "USD"
        formatter.maximumFractionDigits = 0
        return formatter
    }()
}

@MainActor
extension Optional where Wrapped == String {
    var shortDate: String {
        guard let self, !self.isEmpty else { return "Unavailable" }
        return Self.format(self, using: DisplayFormatters.shortDate)
    }

    var longDate: String {
        guard let self, !self.isEmpty else { return "Unavailable" }
        return Self.format(self, using: DisplayFormatters.longDate)
    }

    private static func format(_ value: String, using output: DateFormatter) -> String {
        let raw = String(value.prefix(10))
        guard let date = DisplayFormatters.inputDate.date(from: raw) else { return value }
        return output.string(from: date)
    }
}

@MainActor
extension ClientTrade {
    /// Compact bracket label, e.g. `$15k - $50k`, `$500k - $1m`.
    var amountLabel: String {
        guard let min = transaction.amountMin else { return "Undisclosed" }
        let low = CompactFormat.usdBracket(min)
        guard let max = transaction.amountMax else { return "\(low)+" }
        let high = CompactFormat.usdBracket(max)
        return "\(low) - \(high)"
    }
}

extension String {
    /// Product labels: Buy / Sell / Exchange. Storage codes remain P|S|E; B is a buy alias.
    var label: String {
        switch self {
        case "S": return "Sell"
        case "B", "P": return "Buy"
        case "E": return "Exchange"
        default: return self
        }
    }

    var tint: Color {
        switch self {
        case "S": return .red
        case "B", "P": return .green
        default: return .blue
        }
    }
}

extension ClientCommand.Status {
    var tint: Color {
        switch self {
        case .queued: return .orange
        case .running: return .blue
        case .succeeded: return .green
        case .failed: return .red
        case .canceled: return .secondary
        }
    }
}

enum AppToolbarPlacement {
    static var trailing: ToolbarItemPlacement {
        #if os(iOS)
        return .topBarTrailing
        #else
        return .automatic
        #endif
    }
}

extension View {
    @ViewBuilder
    func neverAutocapitalized() -> some View {
        #if os(iOS)
        self.textInputAutocapitalization(.never)
        #else
        self
        #endif
    }

    @ViewBuilder
    func tickerAutocapitalized() -> some View {
        #if os(iOS)
        self.textInputAutocapitalization(.characters)
        #else
        self
        #endif
    }

    @ViewBuilder
    func urlKeyboard() -> some View {
        #if os(iOS)
        self.keyboardType(.URL)
        #else
        self
        #endif
    }

    @ViewBuilder
    func inlineNavigationTitle() -> some View {
        #if os(iOS)
        self.navigationBarTitleDisplayMode(.inline)
        #else
        self
        #endif
    }
}

// MARK: - Sign-in controls (one implementation, used by Settings + the menu)

/// Shared metrics so the Apple and Google buttons are pixel-identical in
/// height and corner radius. The owner's complaint was that the two buttons
/// looked like different controls; the only reliable way to keep them matched
/// is to have one place that owns the numbers.
enum SignInControlMetrics {
    /// `SignInWithAppleButton` honors an explicit `.frame(height:)`, so both
    /// buttons are driven off this one value.
    static let height: CGFloat = 50
    /// 8pt continuous — the radius Apple's own control clips to when we
    /// `.clipShape` it, so the Google outline traces the same silhouette.
    static let cornerRadius: CGFloat = 8
}

/// Google's four-color "G", drawn with `Canvas` rather than shipped as an
/// asset so it is resolution-independent and cannot be re-tinted.
///
/// WHY A CANVAS AND NOT AN `Image`: a template/SF-Symbol image inside a
/// `Button` label inherits the button's foreground style, which inside a
/// `Form` row or a tinted `TabView` resolves to the app accent — that is
/// exactly the "all blue, no G" failure the owner reported. `context.stroke`
/// / `context.fill` take explicit `.color(...)` shadings that no ancestor
/// style can override, so the mark renders in Google's palette everywhere.
/// Moved here (was `private struct GoogleMark` in `SettingsView.swift`) so
/// the Settings tab and the header menu draw the identical mark.
struct GoogleGMark: View {
    var body: some View {
        Canvas { context, size in
            let blue = Color(red: 0x42 / 255, green: 0x85 / 255, blue: 0xF4 / 255)
            let green = Color(red: 0x34 / 255, green: 0xA8 / 255, blue: 0x53 / 255)
            let yellow = Color(red: 0xFB / 255, green: 0xBC / 255, blue: 0x05 / 255)
            let red = Color(red: 0xEA / 255, green: 0x43 / 255, blue: 0x35 / 255)
            let center = CGPoint(x: size.width / 2, y: size.height / 2)
            let radius = size.width * 0.42
            let lineWidth = size.width * 0.18

            func arc(_ start: Double, _ end: Double, _ color: Color) {
                var path = Path()
                path.addArc(
                    center: center,
                    radius: radius,
                    startAngle: .degrees(start),
                    endAngle: .degrees(end),
                    clockwise: false
                )
                context.stroke(
                    path,
                    with: .color(color),
                    style: StrokeStyle(lineWidth: lineWidth, lineCap: .butt)
                )
            }

            // Clockwise from the crossbar: blue right edge, green bottom,
            // yellow left, red top — the canonical Google mark ordering.
            arc(-35, 20, blue)
            arc(20, 120, green)
            arc(120, 220, yellow)
            arc(220, 325, red)

            // The blue crossbar that turns the ring into a "G".
            context.fill(
                Path(CGRect(
                    x: size.width * 0.48,
                    y: size.height * 0.42,
                    width: size.width * 0.42,
                    height: size.width * 0.16
                )),
                with: .color(blue)
            )
        }
        // The button already carries the accessibility label; the mark itself
        // is decoration and must not become a second VoiceOver stop.
        .accessibilityHidden(true)
        .allowsHitTesting(false)
    }
}

/// Google-branded sign-in button, visually matched to `SignInWithAppleButton`
/// (same height, same 8pt continuous radius, same full width).
///
/// Colors are Google's published identity values, not approximations:
/// light = `#FFFFFF` surface / `#747775` 1pt border / `#1F1F1F` label,
/// dark  = `#131314` surface / `#8E918F` border / `#E3E3E3` label.
///
/// WHY THE TINT ARMOR: this control has to render identically inside a `Form`
/// row and inside a plain `VStack` on a screen whose `TabView` sets
/// `.tint(.blue)`. Three independent things can repaint a button label with
/// the accent color — the automatic button style, the enclosing row's tint,
/// and hierarchical (`.secondary`-style) foreground resolution. So we neutralize
/// all three at once: `.buttonStyle(.plain)` removes the style substitution,
/// `.tint` overrides the tint channel the bar/row bridge reads, and every
/// foreground style is a CONCRETE `Color` (never bare `.primary`/`.secondary`,
/// which are hierarchical styles that resolve against whatever the current
/// foreground style happens to be).
struct GoogleSignInButton: View {
    let isLoading: Bool
    let action: () -> Void

    @Environment(\.colorScheme) private var colorScheme

    private var surface: Color {
        colorScheme == .dark
            ? Color(red: 0x13 / 255, green: 0x13 / 255, blue: 0x14 / 255)
            : Color.white
    }

    private var border: Color {
        colorScheme == .dark
            ? Color(red: 0x8E / 255, green: 0x91 / 255, blue: 0x8F / 255)
            : Color(red: 0x74 / 255, green: 0x77 / 255, blue: 0x75 / 255)
    }

    private var labelColor: Color {
        colorScheme == .dark
            ? Color(red: 0xE3 / 255, green: 0xE3 / 255, blue: 0xE3 / 255)
            : Color(red: 0x1F / 255, green: 0x1F / 255, blue: 0x1F / 255)
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                GoogleGMark()
                    .frame(width: 18, height: 18)
                // Google's guidelines require this exact string, so the
                // in-flight state is a trailing spinner rather than a
                // "Opening Google…" label swap.
                Text("Sign in with Google")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(labelColor)
                if isLoading {
                    ProgressView()
                        .controlSize(.small)
                        .tint(labelColor)
                }
            }
            .frame(maxWidth: .infinity)
            .frame(height: SignInControlMetrics.height)
            .background(
                surface,
                in: RoundedRectangle(cornerRadius: SignInControlMetrics.cornerRadius, style: .continuous)
            )
            .overlay(
                RoundedRectangle(cornerRadius: SignInControlMetrics.cornerRadius, style: .continuous)
                    .stroke(border, lineWidth: 1)
            )
            .contentShape(
                RoundedRectangle(cornerRadius: SignInControlMetrics.cornerRadius, style: .continuous)
            )
        }
        .buttonStyle(.plain)
        .tint(labelColor)
        .foregroundStyle(labelColor)
        .disabled(isLoading)
        .accessibilityLabel("Sign in with Google")
    }
}

/// The app's ONE sign-in implementation: Sign in with Apple (native),
/// Sign in with Google (`ASWebAuthenticationSession`), and an email
/// magic-link row — used by both the Settings tab and the header quick menu.
///
/// Previously the Google + magic-link flows existed only in `SettingsView`
/// and the quick menu punted with a "More Sign-In Options" button that
/// switched tabs. That is why the owner described sign-in as living in
/// "multiple illogical places". Consolidating also fixes a silent-failure
/// bug: the quick menu never rendered `store.watchlistNotice`, so every
/// sign-in error there was invisible. This panel always renders it.
struct SignInPanel: View {
    /// Fires after any path actually establishes a session — the quick menu
    /// uses it to dismiss itself.
    var onSignedIn: () -> Void = {}

    @EnvironmentObject private var store: CongressTradeStore
    @Environment(\.colorScheme) private var colorScheme
    @State private var isAuthenticatingWithGoogle = false
    @State private var magicEmail = ""
    /// Raw nonce for the in-flight Sign in with Apple request, set by the
    /// button's request-configuration closure and consumed on completion.
    /// See `Store/AppleSignIn.swift`.
    @State private var currentAppleNonce: String?
    @FocusState private var magicEmailFocused: Bool

    var body: some View {
        VStack(spacing: 12) {
            SignInWithAppleButton(.signIn) { request in
                // Apple only ever returns `fullName` on the very first
                // authorization for this app, so ask for it up front.
                request.requestedScopes = [.fullName, .email]
                let nonce = AppleSignInNonce.generate()
                currentAppleNonce = nonce
                request.nonce = nonce
            } onCompletion: { result in
                handleAppleCompletion(result)
            }
            .signInWithAppleButtonStyle(colorScheme == .dark ? .white : .black)
            .frame(maxWidth: .infinity)
            .frame(height: SignInControlMetrics.height)
            .clipShape(
                RoundedRectangle(cornerRadius: SignInControlMetrics.cornerRadius, style: .continuous)
            )
            .accessibilityLabel("Sign in with Apple")

            GoogleSignInButton(isLoading: isAuthenticatingWithGoogle) {
                startGoogleSignIn()
            }

            HStack(spacing: 8) {
                // `Text(verbatim:)`, NOT a String title: a String placeholder
                // becomes a `LocalizedStringKey`, and SwiftUI's markdown pass
                // auto-links anything email-shaped — which painted
                // "you@example.com" in link blue and was a large part of the
                // owner's "weird all blue text" report. verbatim skips that
                // processing and keeps the standard placeholder grey (adding
                // a foreground style here instead renders visibly darker than
                // a normal placeholder).
                TextField("", text: $magicEmail, prompt: Text(verbatim: "you@example.com"))
                    .urlKeyboard()
                    .neverAutocapitalized()
                    .autocorrectionDisabled()
                    .focused($magicEmailFocused)
                    .submitLabel(.done)
                    .onSubmit { sendMagicLink() }
                Button("Email Link") { sendMagicLink() }
                    .font(.subheadline.weight(.medium))
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .disabled(magicEmail.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }

            // The one place every sign-in failure surfaces. Settings had this;
            // the quick menu did not, which is how a failing Apple sign-in
            // could look like a button that simply does nothing.
            if let notice = store.watchlistNotice, !notice.isEmpty {
                Text(notice)
                    .font(.caption)
                    .foregroundStyle(Color.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .listRowInsets(EdgeInsets(top: 10, leading: 16, bottom: 10, trailing: 16))
        .onChange(of: store.signedIn) { _, isSignedIn in
            // Every path (Apple, Google, a magic link opened while this view
            // is on screen) lands here once the bootstrap resolves a user —
            // one callback instead of three flow-specific ones.
            if isSignedIn { onSignedIn() }
        }
    }

    // MARK: Apple

    /// Sign in with Apple fails on the DEVICE, before any network call, when
    /// no Apple ID is signed into iCloud — and iOS reports that dismissal as
    /// `.canceled`, indistinguishable from a real user cancel. Genuine cancels
    /// must stay silent (Apple HIG), but the configuration-shaped codes get
    /// copy that names the actual next step instead of surfacing
    /// "AuthorizationError error 1000", which tells the owner nothing.
    private func handleAppleCompletion(_ result: Result<ASAuthorization, Error>) {
        if case .failure(let error) = result,
           let authError = error as? ASAuthorizationError {
            switch authError.code {
            case .canceled:
                return
            case .unknown, .failed, .notHandled, .invalidResponse:
                store.setAccountNotice(
                    "Sign in with Apple needs an Apple ID signed in on this device.  Open iOS Settings, sign in to your iPhone, then try again."
                )
                currentAppleNonce = nil
                return
            // Deliberately a plain `default`, not `@unknown default`. The rest
            // of `ASAuthorizationError.Code` is the passkey/credential-manager
            // family (`.matchedExcludedCredential`, `.credentialImport`,
            // `.deviceNotConfiguredForPasskeyCreation`, …) which this button's
            // ID-token flow never raises, and Apple keeps adding to it — an
            // `@unknown default` warns on every SDK bump that lands a new code
            // even though the handling is unchanged: hand it to the store and
            // let the normal error path speak.
            default:
                break
            }
        }
        Task {
            await store.handleAppleSignIn(result, rawNonce: currentAppleNonce)
            currentAppleNonce = nil
        }
    }

    // MARK: Google

    /// Browser-based OAuth round trip. Honors the configured API base URL
    /// (`CONGRESS_TRADE_API_BASE_URL`) so non-prod backends get the same flow.
    /// `AuthPresentationContext` intentionally still lives in
    /// `SettingsView.swift` — it is a UIKit presentation-anchor shim with no
    /// SwiftUI state, shared by reference from here.
    private func startGoogleSignIn() {
        guard !isAuthenticatingWithGoogle else { return }

        var components = URLComponents(
            url: store.api.origin.appendingPathComponent("auth/google/start"),
            resolvingAgainstBaseURL: false
        )
        components?.queryItems = [URLQueryItem(name: "client", value: "ios")]
        guard let authURL = components?.url else {
            store.setAccountNotice("Google sign-in is not configured for this build.")
            return
        }
        isAuthenticatingWithGoogle = true

        let session = ASWebAuthenticationSession(
            url: authURL,
            callbackURLScheme: "congresstrade"
        ) { callbackURL, error in
            isAuthenticatingWithGoogle = false
            if let error {
                if let authError = error as? ASWebAuthenticationSessionError,
                   authError.code == .canceledLogin {
                    return
                }
                store.setAccountNotice("Google sign-in failed: \(error.localizedDescription)")
                return
            }
            guard let callbackURL else {
                store.setAccountNotice("Google sign-in did not return a session.")
                return
            }
            // Expected URL: congresstrade://auth?token=XYZ
            guard let components = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false),
                  let token = components.queryItems?.first(where: { $0.name == "token" })?.value,
                  !token.isEmpty else {
                store.setAccountNotice("Google sign-in did not return a usable session token.")
                return
            }
            // `saveSessionToken` writes its own failure notice; the discard is
            // deliberate rather than an ignored error.
            _ = store.saveSessionToken(token)
        }

        session.presentationContextProvider = AuthPresentationContext.shared
        session.start()
    }

    // MARK: Magic link

    private func sendMagicLink() {
        magicEmailFocused = false
        let email = magicEmail
        guard !email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        Task { await store.requestMagicLink(email: email) }
    }
}

// MARK: - Legal footer (bottom of every tab)

/// Quiet legal links row pinned to the bottom of every tab. Same destinations
/// as the Settings tab's About section, so there is one set of URLs to keep
/// current. Deliberately low-contrast and small: it is a compliance surface,
/// not navigation.
///
/// Rendered as `Button`s over `openURL` rather than `Link`s because a `Link`
/// paints its label with the accent color, and this row must read grey inside
/// a `TabView` that sets `.tint(.blue)`.
struct LegalFooterLinks: View {
    @Environment(\.openURL) private var openURL

    private struct Destination: Identifiable {
        let id: String
        let title: String
        let url: URL
    }

    /// Built with `compactMap` rather than force-unwrapped literals so a typo
    /// in a URL drops one link instead of crashing the app at the bottom of
    /// every tab.
    private var destinations: [Destination] {
        let raw: [(id: String, title: String, url: String)] = [
            (id: "privacy", title: "Privacy", url: "https://Congress.Trade/privacy-policy"),
            (id: "terms", title: "Terms", url: "https://Congress.Trade/terms-of-service"),
            (id: "pricing", title: "Pricing", url: "https://Congress.Trade/pricing"),
            (id: "support", title: "Support", url: "mailto:congress.trade@jays.services"),
        ]
        return raw.compactMap { entry in
            guard let url = URL(string: entry.url) else { return nil }
            return Destination(id: entry.id, title: entry.title, url: url)
        }
    }

    var body: some View {
        HStack(spacing: 0) {
            ForEach(Array(destinations.enumerated()), id: \.element.id) { index, destination in
                if index > 0 {
                    Text("  ·  ")
                        .foregroundStyle(Color.secondary)
                }
                Button(destination.title) { openURL(destination.url) }
                    .buttonStyle(.plain)
                    .foregroundStyle(Color.secondary)
            }
        }
        .font(.caption2)
        .frame(maxWidth: .infinity, alignment: .center)
        .padding(.top, 18)
        .padding(.bottom, 6)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Legal links")
    }
}

// MARK: - Premium explainer (low-pressure, readable signed out)

/// One-screen explanation of what Premium actually unlocks. Explicitly NOT a
/// hard sell: no countdown, no scarcity copy, no interstitial that has to be
/// defeated — "Not Now" is the largest control on the screen and the whole
/// explanation is readable while signed out.
///
/// Every bullet maps to a real server-side gate (source PDFs, CSV export,
/// the 2-subscription delivery quota) — see `SubscribeView` and the Premium
/// checks in `app/src/client/*`. The push line is deliberately hedged: device
/// registration works today, but the APNs fan-out has not shipped
/// (`app/docs/client-mobile-api.md`), and promising alerts that cannot arrive
/// is exactly the kind of thing that makes the rest of the screen untrusted.
struct PremiumInfoSheet: View {
    @Binding var isPresented: Bool

    @EnvironmentObject private var store: CongressTradeStore
    @Environment(\.openURL) private var openURL
    @State private var showSubscribe = false

    private struct Benefit: Identifiable {
        let id: String
        let systemImage: String
        let title: String
        let detail: String?
    }

    // `private` because `Benefit` is private — an internal stored property
    // cannot expose a private type.
    private let benefits: [Benefit] = [
        .init(
            id: "pdf",
            systemImage: "doc.text",
            title: "Source Filing PDFs",
            detail: "open the original disclosure straight from Congress"
        ),
        .init(
            id: "csv",
            systemImage: "square.and.arrow.down",
            title: "Full CSV Exports",
            detail: "the whole filtered database, not just the page on screen"
        ),
        .init(
            id: "delivery",
            systemImage: "antenna.radiowaves.left.and.right",
            title: "Two Delivery Methods",
            detail: "live SSE stream or signed webhook to a server you run"
        ),
        .init(
            id: "push",
            systemImage: "bell.badge",
            title: "Trade Disclosure Alerts",
            detail: "starts sending when the alert service goes live"
        ),
    ]

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 18) {
                Text("Premium adds the paid-data pieces on top of everything the app already shows for free.")
                    .font(.subheadline)
                    .foregroundStyle(Color.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                VStack(alignment: .leading, spacing: 14) {
                    ForEach(benefits) { benefit in
                        HStack(alignment: .firstTextBaseline, spacing: 12) {
                            Image(systemName: benefit.systemImage)
                                .font(.body)
                                .foregroundStyle(Color.secondary)
                                .frame(width: 22)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(benefit.title)
                                    .font(.subheadline.weight(.semibold))
                                if let detail = benefit.detail {
                                    Text(detail)
                                        .font(.caption)
                                        .foregroundStyle(Color.secondary)
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                            }
                        }
                    }
                }

                Spacer(minLength: 12)

                // Price sits with the CTA, not with the benefits: it is the
                // last thing read before deciding, and keeping the bottom
                // block together avoids a large dead band mid-screen.
                VStack(spacing: 10) {
                    Text("1-month free trial, then $5/month or $50/year.")
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(Color.secondary)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: .infinity)

                    if store.isPremium {
                        Text("You already have Premium.")
                            .font(.subheadline.weight(.semibold))
                    } else if store.signedIn {
                        Button {
                            // Do NOT dismiss first: this view owns the sheet
                            // presentation, and tearing it down in the same
                            // update destroys the presentation host, leaving
                            // a button that appears to do nothing.
                            showSubscribe = true
                        } label: {
                            Label("Subscribe with Apple", systemImage: "apple.logo")
                                .font(.subheadline.weight(.semibold))
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 12)
                        }
                        .buttonStyle(.borderedProminent)
                        .clipShape(
                            RoundedRectangle(cornerRadius: SignInControlMetrics.cornerRadius, style: .continuous)
                        )
                    } else {
                        // Signed out: explain, never gate the explanation and
                        // never bounce them into a sign-in wall. A subscription
                        // has to attach to an account, so the Apple CTA would
                        // dead-end here.
                        Text("Sign in first — a subscription attaches to your account.")
                            .font(.caption)
                            .foregroundStyle(Color.secondary)
                    }

                    if let url = store.api.upgradeURL {
                        Button("See Pricing on Congress.Trade") { openURL(url) }
                            .font(.footnote)
                            .buttonStyle(.plain)
                            .foregroundStyle(Color.secondary)
                    }

                    Button {
                        isPresented = false
                    } label: {
                        Text("Not Now")
                            .font(.subheadline.weight(.semibold))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 12)
                    }
                    .buttonStyle(.bordered)
                    .clipShape(
                        RoundedRectangle(cornerRadius: SignInControlMetrics.cornerRadius, style: .continuous)
                    )
                }
            }
            .padding(20)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(AppTheme.background)
            .navigationTitle("Premium")
            .inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { isPresented = false }
                }
            }
            .sheet(isPresented: $showSubscribe) {
                SubscribeView()
                    .environmentObject(store)
            }
        }
    }
}

// MARK: - Trade disclosure alerts (the one push control in the app)

/// Single source of truth for the push on/off row — replaces the old
/// "Push Notifications (APNs)" wording everywhere. "APNs" is an
/// implementation detail the owner should never have had to read.
///
/// The control collapses three orthogonal pieces of state into one switch:
/// the iOS permission (`UNAuthorizationStatus`), the APNs token, and the
/// backend `register_device` row (signed-in only). Two rules keep it honest:
///
/// 1. When the permission is `.denied`, iOS will never re-prompt, so an
///    interactive `Toggle` would silently snap back and read as broken. That
///    state renders as a static row plus a jump to iOS Settings instead.
/// 2. There is no client wrapper for the backend's `unregister_device`
///    command yet, so switching OFF cannot be honored locally. Rather than
///    animate a switch that changes nothing, OFF routes to iOS Settings —
///    the surface that genuinely controls it — and the row re-reads the real
///    permission when the app comes back to the foreground.
struct TradeDisclosureAlertsToggle: View {
    @EnvironmentObject private var store: CongressTradeStore
    @EnvironmentObject private var pushManager: PushNotificationManager
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase
    /// Set for the moment between "user asked to turn it off" and coming back
    /// from iOS Settings, so the caption explains where the switch actually is.
    @State private var awaitingSystemSettings = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if pushManager.authorizationStatus == .denied {
                HStack(alignment: .firstTextBaseline) {
                    labelStack
                    Spacer(minLength: 12)
                    Button("Open iOS Settings") { openSystemSettings() }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                }
            } else {
                Toggle(isOn: alertsBinding) {
                    labelStack
                }
                if needsRetry {
                    Button("Retry") {
                        Task { await pushManager.syncTokenWithBackend(api: store.api, force: true) }
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                }
            }
        }
        // `PushNotificationManager` samples the OS permission only in `init()`.
        // Returning from iOS Settings is the one moment it can have changed
        // under us, so re-read it or the row shows a stale answer until the
        // next cold launch.
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            awaitingSystemSettings = false
            Task { await pushManager.checkPermissionStatus() }
        }
    }

    private var labelStack: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("Trade Disclosure Alerts")
                .font(.body)
            Text(caption)
                .font(.caption)
                .foregroundStyle(captionColor)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var alertsBinding: Binding<Bool> {
        Binding(
            get: { pushManager.isAuthorized },
            set: { wantsOn in
                if wantsOn {
                    Task {
                        await pushManager.requestAuthorization()
                        // `register_device` is signed-in only and 401s
                        // otherwise, so only sync once both are true.
                        if pushManager.isAuthorized, store.signedIn {
                            await pushManager.syncTokenWithBackend(api: store.api)
                        }
                    }
                } else {
                    awaitingSystemSettings = true
                    openSystemSettings()
                }
            }
        )
    }

    /// One short sentence-case line — never a paragraph.
    private var caption: String {
        if awaitingSystemSettings { return "turn alerts off in iOS Settings" }
        switch pushManager.authorizationStatus {
        case .denied:
            return "turned off in iOS Settings"
        case .notDetermined, .ephemeral:
            return "not enabled yet"
        default:
            break
        }
        if !store.signedIn { return "sign in to finish enabling" }
        if pushManager.isRegistering { return "registering this device…" }
        if pushManager.lastError != nil { return "registration failed — tap Retry" }
        if pushManager.isBackendSynced { return "registered — alerts start when the service goes live" }
        return "permission granted — waiting for sync"
    }

    private var captionColor: Color {
        if pushManager.authorizationStatus == .denied { return Color.secondary }
        if needsRetry { return .red }
        if pushManager.isBackendSynced && store.signedIn { return .green }
        return Color.secondary
    }

    private var needsRetry: Bool {
        pushManager.isAuthorized
            && store.signedIn
            && pushManager.lastError != nil
            && !pushManager.isRegistering
    }

    private func openSystemSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        openURL(url)
    }
}

// MARK: - Filter activity

/// Inline "updating…" strip shown while a filter/search change is still in
/// flight. Filter applies can take seconds, and with no indicator the owner
/// reasonably concluded the controls were broken.
///
/// The row keeps its height whether or not it is active and animates opacity
/// only, so appearing/disappearing never shoves the content below it.
struct FilterActivityIndicator: View {
    let isActive: Bool

    var body: some View {
        HStack(spacing: 6) {
            ProgressView()
                .controlSize(.mini)
            Text("Updating…")
                .font(.caption)
                .foregroundStyle(Color.secondary)
        }
        .frame(height: 16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .opacity(isActive ? 1 : 0)
        .animation(.easeInOut(duration: 0.15), value: isActive)
        .accessibilityHidden(!isActive)
        .accessibilityLabel("Updating results")
    }
}

// MARK: - Header chrome (subtle icon buttons + hamburger account menu)

/// Subtle header circle button used for the ⓘ / export-arrow controls on
/// Trades and Trends: no tinted stroke (the SF Symbol's own `.circle` glyph
/// already reads as a circle) and a grey, non-accent glyph.
///
/// On iOS 26 the toolbar wraps each of these in its own glass capsule with
/// system metrics, so `minWidth`/`minHeight` no longer sets the hit area —
/// it is retained purely so the glyph is not clipped at large Dynamic Type
/// (and still matters if a pre-glass toolbar is ever rendered).
struct HeaderIconButton: View {
    let systemImage: String
    let accessibilityLabel: String
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                // `.title3` (not a fixed point size) so the "slightly larger"
                // glyph still scales with Dynamic Type.
                .font(.title3.weight(.semibold))
                // `Color.secondary` — the CONCRETE secondaryLabel grey — and
                // NOT bare `.secondary`. `.secondary` is a HierarchicalShapeStyle
                // meaning "level 2 of the current foreground style", and inside
                // a toolbar Button the current style is the app tint, so it
                // renders as blue at ~55% opacity. That is why an earlier pass
                // at "make these grey" changed nothing visible: the modifier
                // was working exactly as specified, it just never referred to
                // grey. Measured, the old blue was 1.88:1 against the glass
                // capsule (below the WCAG 3:1 floor for UI components); this
                // grey is 5.31:1.
                .foregroundStyle(Color.secondary)
                .frame(minWidth: 34, minHeight: 34)
                .contentShape(Circle())
        }
        // Belt-and-braces: `.tint` is the channel the bar-button bridge reads,
        // so this holds even if a future OS re-tints the label from outside.
        .tint(Color.secondary)
        .accessibilityLabel(accessibilityLabel)
    }
}

/// Header hamburger button (top-right on Trades/Trends) opening
/// `AccountQuickMenu` — mobile-web parity with `.acct-hamburger` /
/// `#acctMobileMenu` in `app/src/ui/dashboardHtml.ts`.
///
/// The menu is a LARGE SHEET, not the 290pt popover it used to be: it is now
/// a real settings surface (account, alerts, CSV export, Premium, theme), and
/// a popover could neither fit that nor host the sheets those rows present.
/// See the note on `AccountQuickMenu` about why the child sheets live inside
/// the menu rather than on this button.
struct HamburgerMenuButton: View {
    @EnvironmentObject private var store: CongressTradeStore
    @EnvironmentObject private var pushManager: PushNotificationManager
    @State private var showMenu = false

    var body: some View {
        Button {
            showMenu = true
        } label: {
            Image(systemName: "line.3.horizontal")
                .font(.title3.weight(.semibold))
                // Concrete grey — see the note in `HeaderIconButton`.
                .foregroundStyle(Color.secondary)
                .frame(minWidth: 34, minHeight: 34)
                .contentShape(Circle())
        }
        .tint(Color.secondary)
        .accessibilityLabel("Menu")
        .sheet(isPresented: $showMenu) {
            AccountQuickMenu(isPresented: $showMenu)
                // Sheets inherit the environment, but re-injecting is cheap
                // insurance: an @EnvironmentObject miss is a hard crash.
                .environmentObject(store)
                .environmentObject(pushManager)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
    }
}

/// The header menu — a full settings surface, not a dropdown.
///
/// It used to be a 290pt popover offering only Apple sign-in, a theme picker
/// and billing, punting everything else to the Settings tab. That is what the
/// owner meant by settings living "in multiple illogical places": CSV export
/// was a separate toolbar icon, push lived in the Settings tab, Google/email
/// sign-in lived somewhere else again. This sheet now carries account,
/// alerts, export, Premium and theme in one reachable place.
///
/// WHY THE CHILD SHEETS LIVE HERE AND NOT ON THE BUTTON: a sheet modifier
/// belongs to the view it is attached to, so a row that dismisses this menu
/// and raises a sheet in the same update destroys its own presentation host
/// and the sheet never appears — the old popover's "Upgrade to Premium"
/// button had exactly that bug. Every row below therefore only sets its flag;
/// nothing sets `isPresented = false` on the way to a sheet.
struct AccountQuickMenu: View {
    @EnvironmentObject private var store: CongressTradeStore
    @Environment(\.openURL) private var openURL
    @AppStorage("app_color_scheme") private var appColorScheme = "system"
    @Binding var isPresented: Bool
    @State private var showPremiumInfo = false
    @State private var showExport = false
    @State private var isOpeningManageSubscription = false
    @State private var manageSubscriptionError: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    accountSection
                }

                // Alerts / export / Premium share one section on purpose: as
                // three separate sections the inset-grouped gaps made a short
                // menu look mostly empty, and they are the same kind of thing
                // — the account-level switches this menu exists to expose.
                Section {
                    TradeDisclosureAlertsToggle()

                    // Owner asked for CSV export to be reachable from this
                    // menu rather than as its own toolbar icon. `ExportCSVSheet`
                    // (defined alongside the Trades tab) does its own
                    // signed-in / Premium gating and exports the CURRENT
                    // global Trades filter state, so it behaves identically
                    // whether it is opened from here or from that tab.
                    Button {
                        showExport = true
                    } label: {
                        Label("Export CSV", systemImage: "arrow.down.circle")
                    }

                    billingRow
                }

                Section {
                    // No "Theme" caption and no explanation of what Light and
                    // Dark do: the icons and labels are self-evident and the
                    // owner explicitly asked for the words to go.
                    ThemeSegmentControl(selection: $appColorScheme)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 2)
                        .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                }

                Section {
                    // Short disclaimer line — mobile-web parity with `.site-footer`.
                    Text("Congress.Trade is an educational tool for public STOCK Act disclosures. Not financial advice — dollar figures are estimates from disclosed brackets.")
                        .font(.caption2)
                        .foregroundStyle(Color.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    LegalFooterLinks()
                }
                .listRowBackground(Color.clear)
            }
            .scrollContentBackground(.hidden)
            .background(AppTheme.background)
            .navigationTitle("Account")
            .inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { isPresented = false }
                }
            }
            .sheet(isPresented: $showPremiumInfo) {
                PremiumInfoSheet(isPresented: $showPremiumInfo)
                    .environmentObject(store)
            }
            .sheet(isPresented: $showExport) {
                ExportCSVSheet()
                    .environmentObject(store)
                    .presentationDetents([.medium])
                    .presentationDragIndicator(.visible)
            }
        }
    }

    @ViewBuilder
    private var accountSection: some View {
        if store.signedIn, let user = store.signedInUser {
            HStack(spacing: 12) {
                if let picture = user.picture, let url = URL(string: picture) {
                    AsyncImage(url: url) { phase in
                        switch phase {
                        case .success(let image):
                            image.resizable().scaledToFill()
                        default:
                            Image(systemName: "person.crop.circle.fill")
                                .resizable()
                                .foregroundStyle(Color.secondary)
                        }
                    }
                    .frame(width: 44, height: 44)
                    .clipShape(Circle())
                } else {
                    Image(systemName: "person.crop.circle.fill")
                        .font(.system(size: 40))
                        .foregroundStyle(Color.secondary)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(user.name?.isEmpty == false ? user.name! : user.email)
                        .font(.body.weight(.semibold))
                        .lineLimit(1)
                    Text(user.email)
                        .font(.caption)
                        .foregroundStyle(Color.secondary)
                        .lineLimit(1)
                    Text(store.entitlementLabel)
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(.blue)
                }
            }
            .padding(.vertical, 4)
            .accessibilityElement(children: .combine)

            Button(role: .destructive) {
                Task { await store.signOut() }
            } label: {
                Label(
                    store.isLoggingOut ? "Signing Out…" : "Sign Out",
                    systemImage: "rectangle.portrait.and.arrow.right"
                )
            }
            .disabled(store.isLoggingOut)
        } else {
            // The same panel the Settings tab renders — one sign-in
            // implementation, so Apple/Google/email behave identically here.
            SignInPanel(onSignedIn: { isPresented = false })
        }
    }

    @ViewBuilder
    private var billingRow: some View {
        if store.isPremium {
            Button {
                Task { await openManageSubscription() }
            } label: {
                HStack {
                    Label("Manage Subscription", systemImage: "creditcard")
                    if isOpeningManageSubscription {
                        Spacer()
                        ProgressView()
                    }
                }
            }
            .disabled(isOpeningManageSubscription)
            .accessibilityHint(
                store.entitlementSource == "apple"
                    ? "Opens the App Store subscriptions page"
                    : "Opens the Congress.Trade billing portal"
            )
            if let manageSubscriptionError {
                Text(manageSubscriptionError)
                    .font(.caption2)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
        } else {
            Button {
                showPremiumInfo = true
            } label: {
                Label("Upgrade to Premium", systemImage: "sparkles")
            }
        }
    }

    /// Routes by `entitlementSource` — see `Store/ManageSubscription.swift`.
    /// Only dismisses the menu once a URL is actually opened; a failure stays
    /// put and shows `manageSubscriptionError` inline instead of silently
    /// closing on a dead link.
    private func openManageSubscription() async {
        manageSubscriptionError = nil
        isOpeningManageSubscription = true
        defer { isOpeningManageSubscription = false }
        switch await store.resolveManageSubscriptionURL() {
        case .url(let url):
            isPresented = false
            openURL(url)
        case .failed(let message):
            manageSubscriptionError = message
        }
    }
}

// MARK: - Theme segment (pictographic, matches web + ST console)

/// Light / Dark / System control with SF Symbol icons — same pattern as
/// Congress.Trade `theme-seg` and Socratic console (Sun / Moon / Monitor).
/// Labels use Title Case per `/Users/jay/apps/FLEET-UI-COPY.md`.
struct ThemeSegmentControl: View {
    @Binding var selection: String

    private struct Option: Identifiable {
        let id: String
        let label: String
        let systemImage: String
    }

    private let options: [Option] = [
        .init(id: "light", label: "Light", systemImage: "sun.max"),
        .init(id: "dark", label: "Dark", systemImage: "moon"),
        .init(id: "system", label: "System", systemImage: "desktopcomputer"),
    ]

    var body: some View {
        HStack(spacing: 0) {
            ForEach(options) { option in
                Button {
                    selection = option.id
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: option.systemImage)
                            .font(.system(size: 13, weight: .semibold))
                        Text(option.label)
                            .font(.caption.weight(selection == option.id ? .semibold : .medium))
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 7)
                    .frame(maxWidth: .infinity)
                    .foregroundStyle(selection == option.id ? Color.primary : Color.secondary)
                    .background {
                        if selection == option.id {
                            RoundedRectangle(cornerRadius: 8, style: .continuous)
                                .fill(Color(uiColor: .secondarySystemGroupedBackground))
                                .shadow(color: .black.opacity(0.08), radius: 1, y: 1)
                        }
                    }
                    .overlay {
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .stroke(
                                selection == option.id ? Color(uiColor: .separator) : Color.clear,
                                lineWidth: 1
                            )
                    }
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Set Theme To \(option.label)")
                .accessibilityAddTraits(selection == option.id ? [.isSelected] : [])
            }
        }
        .padding(3)
        .background(Color(uiColor: .tertiarySystemFill), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(Color(uiColor: .separator).opacity(0.6), lineWidth: 1)
        )
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Theme")
    }
}
