import AuthenticationServices
import SwiftUI
import UIKit
import UserNotifications

/// Writes Light / Dark / System onto every window **and** presented sheet
/// so a theme change restyles an already-open Account popup. `.preferredColorScheme`
/// on the WindowGroup does not reach a sheet that was presented while Dark
/// was active — Light/System look like no-ops until the sheet is dismissed.
enum AppAppearance {
    private static var windowObserver: NSObjectProtocol?

    /// Sepia was removed (owner 2026-08-21: "too dark of a color that
    /// doesn't look like old fashioned paper", only half-themed and ugly).
    /// A visitor who had it selected still has `"sepia"` sitting in
    /// `UserDefaults` under `app_color_scheme` — rewrite that to `"light"`
    /// the moment it is seen, everywhere the raw pref is read, so it stops
    /// failing validation on every launch instead of just falling through to
    /// an unstyled/undefined case once.  Every other read of this pref
    /// funnels through `paint`, `colorScheme(for:)`, or `CTPalette.resolved`
    /// below, so migrating here covers all of them.
    static func migratedPref(_ pref: String) -> String {
        guard pref == "sepia" else { return pref }
        UserDefaults.standard.set("light", forKey: "app_color_scheme")
        return "light"
    }

    static func apply(_ pref: String) {
        paint(pref)
        // Sheet windows can appear a beat after the tap.  Paint again on the
        // next turn and whenever a window becomes visible.
        DispatchQueue.main.async { paint(pref) }
        if windowObserver == nil {
            windowObserver = NotificationCenter.default.addObserver(
                forName: UIWindow.didBecomeVisibleNotification,
                object: nil,
                queue: .main
            ) { _ in
                let pref = UserDefaults.standard.string(forKey: "app_color_scheme") ?? "light"
                paint(pref)
            }
        }
    }

    private static func paint(_ pref: String) {
        let pref = migratedPref(pref)
        let style: UIUserInterfaceStyle
        switch pref {
        case "light": style = .light
        case "dark": style = .dark
        default: style = .unspecified
        }
        for scene in UIApplication.shared.connectedScenes {
            guard let windowScene = scene as? UIWindowScene else { continue }
            for window in windowScene.windows {
                window.overrideUserInterfaceStyle = style
                window.rootViewController?.applyInterfaceStyleRecursively(style)
            }
        }
    }

    static func colorScheme(for pref: String) -> ColorScheme? {
        switch migratedPref(pref) {
        case "light": return .light
        case "dark": return .dark
        default: return nil
        }
    }
}

enum CTPalette: String {
    case light, dark

    static func resolved(pref: String, system: ColorScheme) -> CTPalette {
        switch AppAppearance.migratedPref(pref) {
        case "dark": return .dark
        case "light": return .light
        default: return system == .dark ? .dark : .light
        }
    }

    /// Cool light page (#eff3f8) or night navy — never mix.
    var background: Color {
        switch self {
        case .light: return Color(red: 0.937, green: 0.953, blue: 0.973)
        case .dark: return Color(red: 0.031, green: 0.047, blue: 0.090)
        }
    }

    var card: Color {
        switch self {
        case .light: return Color.white
        case .dark: return Color(red: 0.071, green: 0.106, blue: 0.188)
        }
    }

    var panel: Color {
        switch self {
        case .light: return Color.white.opacity(0.92)
        case .dark: return Color(red: 0.071, green: 0.106, blue: 0.188).opacity(0.72)
        }
    }
}

private struct CTPaletteKey: EnvironmentKey {
    static let defaultValue: CTPalette = .light
}

extension EnvironmentValues {
    var ctPalette: CTPalette {
        get { self[CTPaletteKey.self] }
        set { self[CTPaletteKey.self] = newValue }
    }
}

struct CTPaletteInjector: ViewModifier {
    let pref: String
    @Environment(\.colorScheme) private var systemScheme

    func body(content: Content) -> some View {
        let palette = CTPalette.resolved(pref: pref, system: systemScheme)
        return content.environment(\.ctPalette, palette)
    }
}

private extension UIViewController {
    func applyInterfaceStyleRecursively(_ style: UIUserInterfaceStyle) {
        overrideUserInterfaceStyle = style
        presentedViewController?.applyInterfaceStyleRecursively(style)
        children.forEach { $0.applyInterfaceStyleRecursively(style) }
    }
}

/// Identifiable payload for politician sheets.  `sheet(item:)` captures the
/// member on present so the first tap cannot fire `/member` with a nil/stale id.
struct MemberSheetTarget: Identifiable, Hashable {
    let id: String
    let name: String
    var photoUrl: String?
}

/// Identifiable payload for ticker/company sheets.
struct TickerSheetTarget: Identifiable, Hashable {
    let ticker: String
    var id: String { ticker }
}

enum AppTheme {
    static var background: Color {
        Color(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(red: 0.031, green: 0.047, blue: 0.090, alpha: 1.0)
                : UIColor(red: 0.937, green: 0.953, blue: 0.973, alpha: 1.0)
        })
    }

    static var card: Color {
        Color(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(red: 0.071, green: 0.106, blue: 0.188, alpha: 1.0)
                : UIColor.white
        })
    }

    static var panel: Color {
        Color(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(red: 0.071, green: 0.106, blue: 0.188, alpha: 0.72)
                : UIColor(white: 1.0, alpha: 0.92)
        })
    }

    static var panelElevated: Color { card }
    static let borderColor = Color(uiColor: .separator)
    static let primaryGradient = LinearGradient(colors: [.blue, .indigo], startPoint: .topLeading, endPoint: .bottomTrailing)

    /// Dark readable ink for filter/header chrome: dropdown chevrons, filter
    /// glyphs, "3 Months" (and other filter words), the exchange arrows.
    static let glyphGrey = Color(uiColor: .label)

    /// Medium grey for the header hamburger + ⓘ icons only.  Owner 2026-09-21
    /// punch list: ~30% lighter than `glyphGrey` (so they no longer read as
    /// near-black text glyphs), iOS `systemGray` — same shade Apple uses for
    /// secondary toolbar controls.  Kept separate from `glyphGrey` because the
    /// filter chevrons still want the dark grey for legibility on the page.
    static let headerIconGrey = Color(uiColor: .systemGray)

    /// Near-black ink for words that are not filter chrome — "Done", "Export
    /// CSV", "Subscribe with Apple", sort-field names, rows-per-page.  Filter
    /// pill labels use `glyphGrey` so they match the chevrons and glyphs.
    /// Concrete `Color` so hierarchical `.primary` cannot pick up the blue tint.
    static let wordInk = Color(uiColor: .label)

    /// Opaque wordmark + sticky filter chrome.  `panel` is 92% white and
    /// `ultraThinMaterial` both composite over the cool page (`#eff3f8`) so
    /// the filter row reads as a blue wash (owner screenshots 2026-08-22).
    /// `card` is solid white in light / navy in dark — the same "light part
    /// at the top" as `header.top` on the website.
    static var headerChrome: Color { card }

    /// Site-footer combined line (web + iOS).  Two spaces around each ·, no trailing period.
    static let siteFooterDisclaimer =
        "Congress.Trade  ·  educational tool for public STOCK Act (2012) disclosures  ·  not financial advice  ·  $ estimated from brackets  ·  independent/private service not affiliated with or endorsed/sponsored by any government agency"

    // Web app aesthetic alignment
    static let houseColor = Color.blue.opacity(0.8)
    static let senateColor = Color.purple.opacity(0.8)
    static let execColor = Color.orange.opacity(0.8)

    /// Buy / net-positive / ahead — matches web `--buy` / `--good` per theme.
    static var semanticPositive: Color {
        Color(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(red: 0x22 / 255.0, green: 0xc5 / 255.0, blue: 0x5e / 255.0, alpha: 1.0)
                : UIColor(red: 0x16 / 255.0, green: 0x65 / 255.0, blue: 0x34 / 255.0, alpha: 1.0)
        })
    }

    /// Sell / net-negative / behind — matches web `--sell`.
    static var semanticNegative: Color {
        Color(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(red: 0xef / 255.0, green: 0x44 / 255.0, blue: 0x44 / 255.0, alpha: 1.0)
                : UIColor(red: 0x99 / 255.0, green: 0x1b / 255.0, blue: 0x1b / 255.0, alpha: 1.0)
        })
    }

    /// Warn / caution / mixed — matches web `--warn` / `--exch` in light mode.
    static var semanticCaution: Color {
        Color(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(red: 0xf5 / 255.0, green: 0x9e / 255.0, blue: 0x0b / 255.0, alpha: 1.0)
                : UIColor(red: 0x9a / 255.0, green: 0x34 / 255.0, blue: 0x12 / 255.0, alpha: 1.0)
        })
    }

    static func border(cornerRadius: CGFloat = 16) -> some View {
        RoundedRectangle(cornerRadius: cornerRadius)
            .stroke(borderColor, lineWidth: 1)
    }
}

extension View {
    func ctThemedForm() -> some View {
        self
            .scrollContentBackground(.hidden)
            .background(AppTheme.background)
            .toolbarBackground(AppTheme.background, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
    }

    func ctThemedRow() -> some View {
        listRowBackground(AppTheme.card)
    }

    /// Paint the navigation bar the same opaque white/navy as `FeedStickyBar`
    /// so the wordmark and the filter pills read as one light header, not a
    /// white island over the cool page.
    func ctSolidFeedHeader() -> some View {
        self
            .toolbarBackground(AppTheme.headerChrome, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
    }
}

// Party animals stay available for compact text annotations (a trade row
// prefix). They are NOT a face fallback — a missing portrait uses initials,
// matching the web avatar, so a Democrat never becomes a donkey on the
// politician sheet.
extension String {
    var partyEmoji: String {
        switch self.lowercased() {
        case "democrat", "dem", "d": return "🫏"
        case "republican", "rep", "r": return "🐘"
        default: return "🦅" // Independent/Other
        }
    }

    /// Two-letter initials from a politician name (`Ro Khanna` → `RK`).
    var nameInitials: String {
        let parts = split(whereSeparator: { $0.isWhitespace }).filter { !$0.isEmpty }
        guard let first = parts.first else { return "?" }
        if parts.count == 1 { return String(first.prefix(2)).uppercased() }
        let last = parts.last!
        return String(first.prefix(1) + last.prefix(1)).uppercased()
    }

    var chamberLabel: String {
        switch self.lowercased() {
        case "house": return "House"
        case "senate": return "Senate"
        case "executive": return "Executive"
        default: return self.capitalized
        }
    }

    /// Same as `chamberLabel`, but for an executive-branch filer with a
    /// curated position on file (`member.title`, sourced server-side from
    /// `shared/executiveTitles.ts`) shows that position instead of the bare
    /// branch name — "President" / "Treasury Secretary", never the literal
    /// word "Executive" (iPad audit P1-4).  Falls back to `chamberLabel`
    /// whenever no title is available, so House/Senate rows and executive
    /// filers with no curated title yet render exactly as before.
    func chamberLabel(title: String?) -> String {
        if self.lowercased() == "executive", let title, !title.isEmpty {
            return title
        }
        return chamberLabel
    }
}

enum MemberPhotoURL {
    /// First usable absolute URL among the API profile, a Directory-row seed,
    /// and any already-loaded roster entry. Relative `/api/photos/...` paths
    /// are ignored: SwiftUI `AsyncImage` cannot resolve them.
    static func resolve(_ candidates: String?...) -> URL? {
        for raw in candidates {
            guard let raw, !raw.isEmpty, let url = URL(string: raw), url.scheme != nil else { continue }
            return url
        }
        return nil
    }
}

/// Headshot with initials underneath (web `memberAvatarHtml`). A broken or
/// missing image leaves the initials — never a party mascot.
struct MemberAvatar: View {
    let photoURL: URL?
    let name: String
    var size: CGFloat = 44

    var body: some View {
        ZStack {
            Text(name.nameInitials)
                .font(.system(size: max(11, size * 0.34), weight: .bold))
                .foregroundStyle(.secondary)
                .frame(width: size, height: size)
                .background(AppTheme.card, in: Circle())
            if let photoURL {
                AsyncImage(url: photoURL) { phase in
                    if case .success(let image) = phase {
                        image.resizable().aspectRatio(contentMode: .fill)
                    }
                }
                .frame(width: size, height: size)
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .overlay(Circle().stroke(AppTheme.borderColor, lineWidth: 1))
        .accessibilityHidden(true)
    }
}

struct MetricTile: View {
    let title: String
    let value: String
    var tint: Color? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(value)
                .font(.subheadline.weight(.bold))
                .foregroundStyle(tint ?? .primary)
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
                            AppTheme.card,
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
/// Fleet UI copy: lowercase suffixes `$15k`, `$99.8k`, `$1.2m`, `$3.4b`, `$3.62t`.
enum CompactFormat {
    static func usd(_ value: Double?) -> String {
        guard let value else { return "—" }
        let absV = abs(value)
        let sign = value < 0 ? "-" : ""
        if absV >= 1_000_000_000_000 {
            // Trillion+ always shows 2 decimal places ("$3.62t") so a mega-cap
            // market cap never falls back to a 4+ digit billions number
            // ("$3622.5b") the way the plain billions branch below would render it.
            return "\(sign)$\(String(format: "%.2f", absV / 1_000_000_000_000))t"
        }
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

    /// Signed money for net-flow readouts: positives carry an explicit `+`
    /// (`net +$1.2m`), negatives keep the `-` `usd` already produces, and zero
    /// stays unsigned (`$0` — "+$0" reads as a gain that isn't there).
    /// `nil` → `—`, same as `usd`.
    ///
    /// This exists so every net/delta call site prints the sign the same way
    /// instead of each screen hand-rolling `value > 0 ? "+" : ""`.
    static func signedUsd(_ value: Double?) -> String {
        guard let value else { return "—" }
        let base = usd(value)
        // `usd` rounds, so a tiny positive can render as "$0" — key the sign
        // off the rendered string, not the raw value, or "+$0" comes back.
        guard value > 0, !base.hasPrefix("-"), base != "$0" else { return base }
        return "+\(base)"
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

// MARK: - Ledger row geometry

/// Two-column ledger layout: a fixed-fraction label column, a gutter, then the
/// value filling the rest — **left-aligned**.
///
/// This replaces `HStack { label; Spacer(); value }`, which pushes the two
/// halves to opposite edges and leaves a measured 52% dead gap mid-row (KO
/// ticker sheet). The web already solved this: `.drawer-kv` in
/// `app/src/ui/dashboardHtml.ts` is `grid-template-columns: 35% 1fr` with the
/// value left-aligned, carrying the owner's note that stacked label-above-value
/// "is impossible to look at without getting a headache".
///
/// Rejected alternatives, recorded so they don't get re-proposed:
/// - **Leader dots** — rejected outright.
/// - **Right-aligned values** — rejected: ragged-left values force the eye to
///   re-find where each number starts on every row.
/// - **Intrinsic label width** (`.frame(maxWidth:)` on the label inside an
///   `HStack`) — sizes each row to its own label, so the value column zig-zags
///   down the section instead of forming a column.
/// - **`containerRelativeFrame`** — measures the enclosing scroll view, not the
///   padded row, so 38% comes out far too wide inside a card.
///
/// A `Layout` is what makes the column *shared*: every row resolves the same
/// fraction of the same proposed width, so the values line up without any
/// cross-row preference plumbing. Both columns are proposed a real width, so
/// long labels **wrap** (to two lines and beyond at accessibility text sizes)
/// rather than truncating.
struct LedgerRowLayout: Layout {
    /// Share of the row given to the label. 38% keeps "Discovered"/"Market Cap"
    /// on one line at default text sizes on the narrowest supported iPhone.
    var labelFraction: CGFloat = 0.38
    /// Hard cap so the label column stops growing on iPad / Mac-idiom widths
    /// where 38% would be a canyon.
    var labelColumnCap: CGFloat = 160
    var gutter: CGFloat = 14

    private struct Columns {
        let label: CGFloat
        let value: CGFloat
    }

    private func columns(for width: CGFloat) -> Columns {
        let usable = max(width, 0)
        let label = min(usable * labelFraction, labelColumnCap)
        return Columns(label: label, value: max(usable - label - gutter, 0))
    }

    /// Layout negotiation also asks with `nil`/infinite widths; fall back to the
    /// two ideal widths so those passes get a sane answer instead of `inf`.
    private func resolvedWidth(_ proposal: ProposedViewSize, _ subviews: Subviews) -> CGFloat {
        if let width = proposal.width, width.isFinite { return max(width, 0) }
        let label = subviews[0].sizeThatFits(.unspecified).width
        let value = subviews[1].sizeThatFits(.unspecified).width
        return label + gutter + value
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout Void) -> CGSize {
        guard subviews.count == 2 else {
            return CGSize(width: resolvedWidth(proposal, subviews), height: 0)
        }
        let width = resolvedWidth(proposal, subviews)
        let columns = columns(for: width)
        let label = subviews[0].dimensions(in: ProposedViewSize(width: columns.label, height: nil))
        let value = subviews[1].dimensions(in: ProposedViewSize(width: columns.value, height: nil))
        let baseline = max(label[.firstTextBaseline], value[.firstTextBaseline])
        // Height is measured from the shared baseline, not from the top edges:
        // a two-line label and a one-line value must still sit on the same
        // first baseline and neither may be clipped below it.
        let height = max(
            baseline - label[.firstTextBaseline] + label.height,
            baseline - value[.firstTextBaseline] + value.height
        )
        return CGSize(width: width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout Void) {
        guard subviews.count == 2 else { return }
        let columns = columns(for: bounds.width)
        let labelProposal = ProposedViewSize(width: columns.label, height: nil)
        let valueProposal = ProposedViewSize(width: columns.value, height: nil)
        let label = subviews[0].dimensions(in: labelProposal)
        let value = subviews[1].dimensions(in: valueProposal)
        let baseline = max(label[.firstTextBaseline], value[.firstTextBaseline])
        subviews[0].place(
            at: CGPoint(x: bounds.minX, y: bounds.minY + baseline - label[.firstTextBaseline]),
            anchor: .topLeading,
            proposal: labelProposal
        )
        subviews[1].place(
            at: CGPoint(x: bounds.minX + columns.label + gutter, y: bounds.minY + baseline - value[.firstTextBaseline]),
            anchor: .topLeading,
            proposal: valueProposal
        )
    }

    /// Republishes the row's shared text baseline. Without this a caller that
    /// aligns something beside a `DetailRow` on `.firstTextBaseline` — e.g. the
    /// disclosure chevron in `TradeDetailView.linkedDetailRow` — would fall back
    /// to the row's bottom edge and sit visibly low.
    func explicitAlignment(
        of guide: VerticalAlignment,
        in bounds: CGRect,
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout Void
    ) -> CGFloat? {
        guard subviews.count == 2, guide == .firstTextBaseline || guide == .lastTextBaseline else {
            return nil
        }
        let columns = columns(for: bounds.width)
        let label = subviews[0].dimensions(in: ProposedViewSize(width: columns.label, height: nil))
        let value = subviews[1].dimensions(in: ProposedViewSize(width: columns.value, height: nil))
        let baseline = max(label[.firstTextBaseline], value[.firstTextBaseline])
        if guide == .firstTextBaseline { return bounds.minY + baseline }
        return bounds.minY + max(
            baseline - label[.firstTextBaseline] + label[.lastTextBaseline],
            baseline - value[.firstTextBaseline] + value[.lastTextBaseline]
        )
    }
}

/// Label/value row shared by every detail sheet. See `LedgerRowLayout` for why
/// the geometry is a column pair rather than an `HStack` with a `Spacer`.
struct DetailRow: View {
    let label: String
    let value: String

    /// The cap scales with Dynamic Type: at accessibility sizes a fixed 160pt
    /// column would wrap even short labels to three lines on a wide screen.
    /// It scales identically for every row, so the columns stay aligned.
    @ScaledMetric(relativeTo: .subheadline) private var labelColumnCap: CGFloat = 160

    init(_ label: String, _ value: String) {
        self.label = label
        self.value = value
    }

    var body: some View {
        LedgerRowLayout(labelColumnCap: labelColumnCap) {
            // No `lineLimit`: the label wraps as far as it needs to. Truncating
            // a label is never acceptable — the reader loses which row they are
            // looking at, which is worse than an extra line.
            Text(label)
                .foregroundStyle(.secondary)
            Text(value)
                .fontWeight(.medium)
        }
        .font(.subheadline)
        .accessibilityElement(children: .combine)
    }
}

struct NoticeView: View {
    let message: String
    /// Optional recovery action.  Trends is the app's first screen and a failed
    /// load leaves it as six "—" tiles, so a notice there with no button is a
    /// dead end until the user guesses at pull-to-refresh.  Callers that sit
    /// under an obvious refresh control can leave this nil.
    var retry: (() -> Void)? = nil

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(message)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let retry {
                Button("Retry", action: retry)
                    .font(.footnote.weight(.semibold))
                    .buttonStyle(.bordered)
                    .clipShape(Capsule())
                    .fixedSize()
                    .accessibilityLabel("Retry")
                    .accessibilityHint(message)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
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
extension String {
    var shortDate: String {
        let raw = String(prefix(10))
        guard let date = DisplayFormatters.inputDate.date(from: raw) else { return self }
        return DisplayFormatters.shortDate.string(from: date)
    }

    var longDate: String {
        let raw = String(prefix(10))
        guard let date = DisplayFormatters.inputDate.date(from: raw) else { return self }
        return DisplayFormatters.longDate.string(from: date)
    }
}

@MainActor
extension Optional where Wrapped == String {
    var shortDate: String {
        guard let self, !self.isEmpty else { return "Unavailable" }
        return self.shortDate
    }

    var longDate: String {
        guard let self, !self.isEmpty else { return "Unavailable" }
        return self.longDate
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
        case "S": return AppTheme.semanticNegative
        case "B", "P": return AppTheme.semanticPositive
        default: return .blue
        }
    }
}

extension ClientCommand.Status {
    var tint: Color {
        switch self {
        case .queued: return AppTheme.semanticCaution
        case .running: return .blue
        case .succeeded: return AppTheme.semanticPositive
        case .failed: return AppTheme.semanticNegative
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

    /// Fills the iPad canvas instead of iPadOS's default "form sheet" card
    /// (a fixed ~830pt-wide box centered in a sea of dimmed background —
    /// the pattern behind every sheet flagged in the iPad audit, P1-1).
    /// Apply this to the content passed to `.sheet` / `.fullScreenCover`.
    /// Regular width class only: on iPhone's compact class this is a no-op,
    /// because `.sheet` there already fills the available width and
    /// `presentationSizing` never runs.
    @ViewBuilder
    func iPadFullWidthSheet() -> some View {
        modifier(IPadFullWidthSheetModifier())
    }
}

private struct IPadFullWidthSheetModifier: ViewModifier {
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    func body(content: Content) -> some View {
        if #available(iOS 18.0, *), horizontalSizeClass == .regular {
            content.presentationSizing(.page)
        } else {
            content
        }
    }
}

// MARK: - Header chrome (subtle icon buttons + hamburger account menu)

/// Header ⓘ / hamburger share `AppTheme.glyphGrey` with the filter pills.

/// Subtle header circle button used for the ⓘ / export-arrow controls on
/// Trades and Trends: no tinted stroke (the SF Symbol's own `.circle` glyph
/// already reads as a circle), grey, a slightly larger glyph, and a tap target
/// smaller than the default ~44pt toolbar hit area.
///
/// Grey is defended twice, because one defence has already failed in shipped
/// builds: `.buttonStyle(.plain)` stops the button style re-applying the
/// inherited tint to its label, and `AppTheme.glyphGrey` is a concrete color that
/// nothing downstream can resolve against the accent.
struct HeaderIconButton: View {
    let systemImage: String
    let accessibilityLabel: String
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                // Owner 2026-09-21 punch list: 15% smaller than the previous
                // `.title3` (≈20pt). `.body` (≈17pt) is the closest stock
                // size and still scales with Dynamic Type.
                .font(.body.weight(.semibold))
                .foregroundStyle(AppTheme.headerIconGrey)
                // minWidth/minHeight (not a fixed frame) so the tap target can
                // grow past 34pt for large Dynamic Type sizes instead of
                // clipping the glyph.
                .frame(minWidth: 34, minHeight: 34)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .tint(AppTheme.headerIconGrey)
        .accessibilityLabel(accessibilityLabel)
    }
}

/// Header hamburger button (top-right on Trades/Trends) opening
/// `AccountQuickMenu` — mobile-web parity with `.acct-hamburger` /
/// `#acctMobileMenu` in `app/src/ui/dashboardHtml.ts`.
///
/// The menu is a full-height sheet, not the old 290pt popover: everything the
/// account surface has to hold (sign-in, alerts, export, Premium, theme, legal)
/// cannot be read through a letterbox, and a popover on iPhone is a
/// compact-adapted sheet anyway.
struct HamburgerMenuButton: View {
    @State private var showMenu = false

    var body: some View {
        Button {
            showMenu = true
        } label: {
            // Owner 2026-09-21 punch list: matches the header ⓘ — medium
            // grey (headerIconGrey, iOS systemGray), 15% smaller than the
            // previous `.title3` (≈20pt).  `.body` is the closest stock size
            // and still scales with Dynamic Type.
            Image(systemName: "line.3.horizontal")
                .font(.body.weight(.semibold))
                .foregroundStyle(AppTheme.headerIconGrey)
                .frame(minWidth: 34, minHeight: 34)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .tint(AppTheme.headerIconGrey)
        .accessibilityLabel("Menu")
        .sheet(isPresented: $showMenu) {
            AccountQuickMenu(isPresented: $showMenu)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
                .presentationBackground(AppTheme.background)
        }
    }
}

/// The account surface behind the header hamburger — everything an account can
/// do, in one full-height sheet: sign in, trade disclosure alerts, CSV export,
/// Premium, theme, legal links, disclaimer.
///
/// It used to be a 290pt popover that could only fit a native Apple button and
/// a "More Sign-In Options" signpost to the Settings tab; Google lived only in
/// Settings, so the two surfaces drifted. Sign-in is now one component
/// (`SignInPanel`) used by both, and this sheet has the room to show it.
struct AccountQuickMenu: View {
    @EnvironmentObject private var store: CongressTradeStore
    @Environment(\.openURL) private var openURL
    @AppStorage("app_color_scheme") private var appColorScheme = "light"
    @Binding var isPresented: Bool
    @State private var showPremiumInfo = false
    @State private var showExportSheet = false
    @State private var showDeleteAccountConfirm = false
    @State private var showBugReportSheet = false
    @State private var isOpeningManageSubscription = false
    @State private var manageSubscriptionError: String?

    /// Listen for the iOS shake gesture (default OFF, gated by
    /// `shake_to_report_enabled` UserDefaults). Posted from
    /// `ShakeDetectorViewController.motionEnded` in App.swift; opens the
    /// same `BugReportSheet` as the account-menu entry so both entry
    /// points converge on one submission path.
    private var shakeListener: some View {
        EmptyView()
            .onReceive(NotificationCenter.default.publisher(for: .shakeToReport)) { _ in
                guard UserDefaults.standard.bool(forKey: "shake_to_report_enabled") else { return }
                showBugReportSheet = true
            }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    accountSection
                } footer: {
                    if let notice = store.watchlistNotice, !notice.isEmpty {
                        Text(notice)
                            .padding(.top, 6)
                    }
                }
                .ctThemedRow()
                .background(shakeListener)

                // Owner 2026-09-21 ask: shake-to-report toggle, default OFF.
                // Lives in its own section so the label + hint read cleanly
                // on the Account sheet, with the existing Report-a-Bug
                // entry below in the danger zone as the alternate entry point.
                Section {
                    ShakeToReportToggle()
                } footer: {
                    Text("When on, shaking the device opens a bug-report sheet. Default is off — turn it on if you want one-gest reporting while testing.")
                }
                .ctThemedRow()

                if store.showsAdminRow {
                    Section {
                        NavigationLink(value: AdminRoute.panel) {
                            Label("Admin", systemImage: "gearshape.2")
                        }
                    }
                    .ctThemedRow()
                }

                Section {
                    TradeDisclosureAlertsToggle()
                }
                .ctThemedRow()

                Section {
                    Button {
                        showExportSheet = true
                    } label: {
                        // Split colour: bare-glyph grey on the icon, dark
                        // legible ink on the word (owner 2026-08-21 — words
                        // must read dark, glyphs can stay the lighter grey).
                        // Without this the row inherits the app-wide
                        // `.tint(.blue)` (App.swift) and renders accent blue.
                        Label {
                            Text("Export CSV").foregroundStyle(AppTheme.wordInk)
                        } icon: {
                            Image(systemName: "arrow.down.circle").foregroundStyle(AppTheme.glyphGrey)
                        }
                    }
                    billingRow
                }
                .ctThemedRow()

                Section {
                    // No "Theme" caption and no explanation of what Light/Dark
                    // do: the three icons say it (owner: "Don't need bunch of
                    // words on that tab").
                    ThemeSegmentControl(selection: $appColorScheme)
                        .listRowInsets(EdgeInsets(top: 10, leading: 16, bottom: 10, trailing: 16))
                }
                .ctThemedRow()

                if store.signedIn || store.hasStoredSessionToken {
                    Section {
                        // Owner 2026-09-21 ask: Report a Bug above Sign Out.
                        // Opens Sentry's User Feedback widget (configured
                        // DSN) so the iOS session breadcrumbs, last-30
                        // console lines, app version, and account email
                        // attach automatically — no back-and-forth needed.
                        Button {
                            presentBugReportSheet()
                        } label: {
                            Label(
                                "Report a Bug",
                                systemImage: "ladybug"
                            )
                        }
                        .accessibilityHint("Opens a feedback sheet. The app attaches the last 30 console lines and your account email so we can reproduce the issue.")
                        Button(role: .destructive) {
                            Task { await store.signOut() }
                        } label: {
                            Label(
                                store.isLoggingOut ? "Signing Out…" : "Sign Out",
                                systemImage: "rectangle.portrait.and.arrow.right"
                            )
                        }
                        .disabled(store.isLoggingOut || store.isDeletingAccount)
                        if store.signedIn {
                            Button(role: .destructive) {
                                showDeleteAccountConfirm = true
                            } label: {
                                Label(
                                    store.isDeletingAccount ? "Deleting Account…" : "Delete Account",
                                    systemImage: "trash"
                                )
                            }
                            .disabled(store.isLoggingOut || store.isDeletingAccount)
                        }
                    }
                    .ctThemedRow()
                }

                Section {
                    // Same stack as website `footer.site-footer`: disclaimer
                    // first, then the link row.  Was reversed here.
                    SiteFooterStack()
                }
                .ctThemedRow()
            }
            .ctThemedForm()
            .modifier(ForcedColorScheme(pref: appColorScheme))
            .modifier(CTPaletteInjector(pref: appColorScheme))
            .navigationTitle("Account")
            .inlineNavigationTitle()
            .navigationDestination(for: AdminRoute.self) { route in
                switch route {
                case .panel:
                    AdminPanelView()
                case .reviewQueue:
                    ReviewQueueView()
                case .reviewDetail(let docId):
                    ReviewDetailView(docId: docId)
                }
            }
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    // Dark legible ink, not the app-wide blue tint (owner
                    // 2026-08-21) — `.foregroundStyle` alone is not enough
                    // here: the toolbar button style re-applies `.tint` over
                    // it, so both must be set (same defensive pattern as
                    // `SignInWithGoogleButton` below).
                    Button("Done") { isPresented = false }
                        .foregroundStyle(AppTheme.wordInk)
                        .tint(AppTheme.wordInk)
                }
            }
        }
        .task { await store.probeAdminAccess() }
        .environment(\.openPremium) { showPremiumInfo = true }
        .sheet(isPresented: $showPremiumInfo) {
            PremiumSheet()
                .environmentObject(store)
        }
        .sheet(isPresented: $showExportSheet) {
            // The existing Trades export sheet, presented as-is.
            ExportCSVSheet()
                .environmentObject(store)
                .presentationDetents([.medium])
                .presentationDragIndicator(.visible)
        }
        .confirmationDialog("Delete Account?", isPresented: $showDeleteAccountConfirm, titleVisibility: .visible) {
            Button("Delete Account", role: .destructive) {
                Task {
                    await store.deleteAccount()
                    if !store.signedIn && !store.hasStoredSessionToken {
                        isPresented = false
                    }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This permanently deletes your account, delivery subscriptions, and personal information.  Apple subscriptions must also be cancelled in Settings → Apple ID → Subscriptions.  This cannot be undone.")
        }
        .sheet(isPresented: $showBugReportSheet) {
            BugReportSheet()
                .environmentObject(store)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
    }

    /// Opens the bug-report sheet. Owner 2026-09-21 ask: bug reports go
    /// through Sentry's User Feedback widget when DSN is configured (the
    /// widget is invoked from inside `BugReportSheet`), so the operator's
    /// Sentry issue already carries app version + last-30 console lines +
    /// current view + account email — no back-and-forth needed.
    private func presentBugReportSheet() {
        showBugReportSheet = true
    }

    @ViewBuilder
    private var accountSection: some View {
        if store.signedIn, let user = store.signedInUser {
            HStack(spacing: 10) {
                Image(systemName: "person.crop.circle.fill")
                    .font(.system(size: 30))
                    .foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 1) {
                    Text(user.name?.isEmpty == false ? user.name! : user.email)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)
                    Text(store.entitlementLabel)
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(.blue)
                }
            }
            .accessibilityElement(children: .combine)
        } else if store.hasStoredSessionToken {
            Text("Session could not be verified.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Button {
                Task { await store.refresh() }
            } label: {
                Label("Retry", systemImage: "arrow.clockwise")
            }
        } else {
            SignInPanel(onSignedIn: { isPresented = false })
                .listRowInsets(EdgeInsets(top: 10, leading: 16, bottom: 10, trailing: 16))
        }
    }

    /// Premium entry point. Manage Subscription routes through
    /// `resolveManageSubscriptionURL` (App Store for Apple; Stripe portal,
    /// then website `/?billing=manage`, for web/Stripe). The not-yet-premium
    /// path opens `PremiumSheet` (what you get, the plans, a way out).
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
                    .font(.caption)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
        } else {
            Button {
                showPremiumInfo = true
            } label: {
                Label("Premium", systemImage: "sparkles")
            }
        }
    }

    /// Routes by `entitlementSource` — see `Store/ManageSubscription.swift`.
    /// A URL (portal, App Store, or website manage fallback) closes the
    /// sheet and opens it.  Offline / remaining failures stay put with
    /// `manageSubscriptionError` instead of a dead App Store link.
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

/// Sentry User Feedback sheet. Owner 2026-09-21 ask: this is the entry
/// point for both the account-menu "Report a Bug" button AND the shake-to-
/// report gesture on mobile (default off, gated by
/// `UserDefaults.shakeToReportEnabled`). Both paths converge here so the
/// Sentry submission carries the same context regardless of entry point.
struct BugReportSheet: View {
    @EnvironmentObject private var store: CongressTradeStore
    @Environment(\.dismiss) private var dismiss
    @State private var comments = ""
    @State private var email = ""
    @State private var submitting = false
    @State private var submitError: String?
    @State private var submitted = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("What happened?", text: $comments, axis: .vertical)
                        .lineLimit(4...10)
                    TextField("Your email (optional)", text: $email)
                        .keyboardType(.emailAddress)
                        .autocapitalization(.none)
                } footer: {
                    Text("The app attaches: version, last 30 console lines, current view, and account email (if signed in). Tap Send to forward to the developer's Sentry.")
                }

                Section {
                    if let err = submitError {
                        Text(err).foregroundStyle(.red)
                    }
                    if submitted {
                        Label("Report sent — thank you.", systemImage: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                    }
                }
            }
            .navigationTitle("Report a Bug")
            .inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(submitted ? "Done" : "Send") {
                        if submitted { dismiss() } else { Task { await submit() } }
                    }
                    .disabled(comments.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || submitting)
                }
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }

    private func submit() async {
        submitting = true
        defer { submitting = false }
        let payload: [String: Any] = [
            "comments": comments,
            "email": email.isEmpty ? (store.signedInUser?.email ?? "guest") : email,
            "app_version": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?",
            "ios_version": ProcessInfo.processInfo.operatingSystemVersionString,
            "device": UIDevice.current.model,
            "view": SentryTelemetry.lastBreadcrumbView ?? "unknown",
            "submitted_at": ISO8601DateFormatter().string(from: Date()),
        ]
        // Send via Sentry's captureUserFeedback if SDK is configured
        // (DSN set in plist + SentryTelemetry.start() ran). Falls back to
        // a no-op + console error log when Sentry is unconfigured, so
        // the button never breaks the surface.
        let delivered = await SentryTelemetry.captureUserFeedback(
            comments: comments,
            email: email.isEmpty ? (store.signedInUser?.email ?? "guest") : email,
            payload: payload
        )
        if delivered {
            submitted = true
        } else {
            submitError = "Couldn't reach the bug-report endpoint. Try again, or email support@congress.trade."
        }
    }
}

/// Owner 2026-09-21 ask: shake-to-report on mobile (default off). Wired
/// once at the App root via `.onShakeToReport` and only fires when the
/// user has opted in via Settings → Account → "Shake to Report Bug".
extension Notification.Name {
    static let shakeToReport = Notification.Name("CT.shakeToReport")
}

/// Settings row for the shake-to-report opt-in toggle. Lives inside
/// AccountQuickMenu below the Appearance row so the user can find it
/// without scrolling past Account actions. Default false; the
/// `ShakeDetectorViewController` reads the same UserDefaults key and
/// stays subscribed only while this is on.
struct ShakeToReportToggle: View {
    @AppStorage("shake_to_report_enabled") private var enabled: Bool = false

    var body: some View {
        Toggle("Shake to Report Bug", isOn: $enabled)
            .accessibilityHint("When on, shaking the device opens a bug-report sheet. Default is off.")
    }
}

// MARK: - Sign-in (one implementation, every surface)

/// The app's single sign-in stack: native Apple button and Google button —
/// plus the account notice, which is the part that was missing.
///
/// Every failure path in `Store/AppleSignIn.swift` already writes
/// `setAccountNotice`, but the hamburger popover rendered no notice at all, so
/// a failed Apple sign-in there did nothing visible and looked like a dead
/// button. The notice is part of this component precisely so no surface can
/// adopt sign-in and forget to show why it failed.
struct SignInPanel: View {
    @EnvironmentObject private var store: CongressTradeStore
    @Environment(\.colorScheme) private var colorScheme
    /// Raw nonce for the in-flight Sign in with Apple request, set by the
    /// button's request-configuration closure and consumed by
    /// `handleAppleSignIn` on completion. See `Store/AppleSignIn.swift`.
    @State private var currentAppleNonce: String?
    @State private var isAuthenticatingWithGoogle = false
    @State private var isAuthenticatingWithApple = false

    /// Fired once a session token has actually been stored — used by sheets
    /// that should close themselves on success.
    var onSignedIn: () -> Void = {}

    private var isAuthenticating: Bool { isAuthenticatingWithApple || isAuthenticatingWithGoogle }

    /// `watchlistNotice` is shared with watchlist/alert/sign-out copy.  Only
    /// authentication results belong under these buttons — otherwise a leftover
    /// `"Signed out."` renders as a red auth error.
    private var authenticationNotice: String? {
        guard let notice = store.watchlistNotice, !notice.isEmpty else { return nil }
        return Self.isAuthenticationNotice(notice) ? notice : nil
    }

    private static func isAuthenticationNotice(_ notice: String) -> Bool {
        let n = notice.lowercased()
        if n.hasPrefix("signed out") { return false }
        if n == "signed in." { return true }
        if n.hasPrefix("enter a session") { return true }
        if n.contains("failed to save session") { return true }
        if n.contains("sign in") || n.contains("sign-in") { return true }
        if n.contains("apple id") || n.contains("identity token") { return true }
        return false
    }

    var body: some View {
        VStack(spacing: 12) {
            ZStack {
                SignInWithAppleButton(.signIn) { request in
                    // Request name + email on first authorization so the backend
                    // can store a display name (email also lands in the JWT).
                    request.requestedScopes = [.fullName, .email]
                    let nonce = AppleSignInNonce.generate()
                    currentAppleNonce = nonce
                    request.nonce = nonce
                } onCompletion: { result in
                    Task {
                        isAuthenticatingWithApple = true
                        defer {
                            isAuthenticatingWithApple = false
                            currentAppleNonce = nil
                        }
                        // `signedIn` only flips after the bootstrap refresh that
                        // `saveSessionToken` kicks off, so success is measured on
                        // the token landing, not on the user object arriving.
                        let hadToken = store.hasStoredSessionToken
                        await store.handleAppleSignIn(result, rawNonce: currentAppleNonce)
                        if store.hasStoredSessionToken, !hadToken { onSignedIn() }
                    }
                }
                .signInWithAppleButtonStyle(colorScheme == .dark ? .white : .black)
                .frame(height: 50)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                .accessibilityLabel("Sign in with Apple")
                .allowsHitTesting(!isAuthenticating)

                if isAuthenticatingWithApple {
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(Color.primary.opacity(colorScheme == .dark ? 0.35 : 0.12))
                    ProgressView()
                        .accessibilityLabel("Signing in with Apple")
                }
            }

            GoogleSignInButton(isBusy: isAuthenticatingWithGoogle) {
                startGoogleSignIn()
            }
            .disabled(isAuthenticating)

            if isAuthenticating {
                Text("Signing in…")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            if let notice = authenticationNotice {
                Text(notice)
                    .font(.footnote)
                    .foregroundStyle(notice == "Signed in." ? Color.secondary : Color.red)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    /// Google OAuth via `ASWebAuthenticationSession`, the app's only copy.
    /// Lived in `SettingsView` before, which is why the hamburger could not
    /// offer Google at all.
    private func startGoogleSignIn() {
        guard !isAuthenticating else { return }

        // Honor the configured API base URL (CONGRESS_TRADE_API_BASE_URL) so
        // non-prod backends get the OAuth round trip too.
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

        let session = ASWebAuthenticationSession(url: authURL, callbackURLScheme: "congresstrade") { callbackURL, error in
            Task { @MainActor in
                GoogleAuthSession.current = nil
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

                if store.saveSessionToken(token) { onSignedIn() }
            }
        }

        session.presentationContextProvider = AuthPresentationContext.shared
        // Must outlive `start()` — see `GoogleAuthSession`.
        GoogleAuthSession.current = session
        if !session.start() {
            GoogleAuthSession.current = nil
            isAuthenticatingWithGoogle = false
            store.setAccountNotice("Google sign-in could not start.")
        }
    }
}

/// Google-branded sign-in button at Apple-button parity: 50pt tall, 8pt
/// continuous radius, full width, multicolor G, and Google's own surface /
/// border / label colors for each appearance (light `#FFFFFF` / `#747775` /
/// `#1F1F1F`, dark `#131314` / `#8E918F` / `#E3E3E3`).
///
/// `.buttonStyle(.plain)` is load-bearing, not decoration: inside a `Form` row
/// the row's accent tint repainted the entire label — mark and text — accent
/// blue, which is the "Google button renders all blue" report.
struct GoogleSignInButton: View {
    var isBusy: Bool = false
    var action: () -> Void

    @Environment(\.colorScheme) private var colorScheme

    private var surface: Color {
        colorScheme == .dark
            ? Color(red: 0x13 / 255, green: 0x13 / 255, blue: 0x14 / 255)
            : .white
    }

    private var stroke: Color {
        colorScheme == .dark
            ? Color(red: 0x8E / 255, green: 0x91 / 255, blue: 0x8F / 255)
            : Color(red: 0x74 / 255, green: 0x77 / 255, blue: 0x75 / 255)
    }

    private var label: Color {
        colorScheme == .dark
            ? Color(red: 0xE3 / 255, green: 0xE3 / 255, blue: 0xE3 / 255)
            : Color(red: 0x1F / 255, green: 0x1F / 255, blue: 0x1F / 255)
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                GoogleMark()
                    .frame(width: 20, height: 20)
                // System font, not the app's Zilla Slab body font: Google's
                // brand guidance is a neutral sans for the button label.
                Text(isBusy ? "Opening Google…" : "Sign in with Google")
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(label)
            }
            .frame(maxWidth: .infinity, minHeight: 50)
            .background(surface, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .stroke(stroke, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .tint(label)
        .disabled(isBusy)
        .accessibilityLabel("Sign in with Google")
    }
}

/// Multicolor "G" mark. Canvas' y-axis points down, so these angles read
/// clockwise on screen: blue at 3 o'clock plus the crossbar, green sweeping the
/// bottom, yellow up the left, red across the top — the Google order.
struct GoogleMark: View {
    var body: some View {
        Canvas { context, size in
            let blue = Color(red: 0x42 / 255, green: 0x85 / 255, blue: 0xF4 / 255)
            let green = Color(red: 0x34 / 255, green: 0xA8 / 255, blue: 0x53 / 255)
            let yellow = Color(red: 0xFB / 255, green: 0xBC / 255, blue: 0x05 / 255)
            let red = Color(red: 0xEA / 255, green: 0x43 / 255, blue: 0x35 / 255)
            let center = CGPoint(x: size.width / 2, y: size.height / 2)
            let radius = size.width * 0.42
            let lw = size.width * 0.18

            func arc(_ start: Double, _ end: Double, _ color: Color) {
                var p = Path()
                p.addArc(
                    center: center,
                    radius: radius,
                    startAngle: .degrees(start),
                    endAngle: .degrees(end),
                    clockwise: false
                )
                context.stroke(p, with: .color(color), style: StrokeStyle(lineWidth: lw, lineCap: .butt))
            }
            arc(-35, 20, blue)
            arc(20, 120, green)
            arc(120, 220, yellow)
            arc(220, 325, red)
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
        .accessibilityHidden(true)
    }
}

// MARK: - Trade disclosure alerts

/// The device-notification switch: "Push Alerts - Trade Filings".
///
/// If not signed in, the switch is disabled and off, displaying "Push alerts are a Premium feature."
/// When signed in:
/// - Toggling on: requests permission if not determined, opens system settings if denied, or sets mode = .filings.
/// - Toggling off: sets mode = .off (and does NOT bounce to system settings).
struct TradeDisclosureAlertsToggle: View {
    @EnvironmentObject private var store: CongressTradeStore
    @EnvironmentObject private var pushManager: PushNotificationManager
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase
    var isCompact: Bool = false
    @State private var newTicker = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Toggle("Push Alerts - Trade Filings", isOn: Binding(
                get: { store.signedIn && pushManager.isAuthorized && store.pushSettings.mode != .off },
                set: { wantsOn in Task { await setEnabled(wantsOn) } }
            ))
            .disabled(!store.signedIn)

            if !store.signedIn {
                Text("Sign in to enable push alerts on this device.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                if pushManager.authorizationStatus == .denied {
                    Button {
                        openSystemNotificationSettings()
                    } label: {
                        Text("turned off for this app in iOS Settings — tap to open")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.leading)
                    }
                    .buttonStyle(.plain)
                } else if !pushManager.isAuthorized {
                    Text("not enabled on this device")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else if pushManager.lastError != nil {
                    HStack(spacing: 8) {
                        Text("registration failed")
                            .font(.caption)
                            .foregroundStyle(.red)
                        Button("Retry") {
                            Task { await pushManager.syncTokenWithBackend(api: store.api, force: true) }
                        }
                        .font(.caption.weight(.semibold))
                        .buttonStyle(.borderless)
                    }
                }

                if !isCompact && pushManager.isAuthorized && store.pushSettings.mode != .off {
                    Picker("Alert Type", selection: modeBinding) {
                        Text("New Filings").tag(PushAlertMode.filings)
                        Text("Watchlist").tag(PushAlertMode.watchlist)
                    }
                    .pickerStyle(.segmented)
                    .accessibilityLabel("Alert Type")

                    if store.pushSettings.mode == .watchlist {
                        PushWatchlistEditor(newTicker: $newTicker)
                    }
                }
            }
        }
        // The status is only trustworthy if it is re-read after the user has
        // been to iOS Settings and come back.
        .task { await pushManager.checkPermissionStatus() }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            Task { await pushManager.checkPermissionStatus() }
        }
    }

    private var modeBinding: Binding<PushAlertMode> {
        Binding(
            get: { store.pushSettings.mode == .watchlist ? .watchlist : .filings },
            set: { mode in
                var next = store.pushSettings
                next.mode = mode
                Task { await store.savePushSettings(next) }
            }
        )
    }

    private func setEnabled(_ on: Bool) async {
        guard store.signedIn else { return }
        if !on {
            var next = store.pushSettings
            next.mode = .off
            await store.savePushSettings(next)
            return
        }

        switch pushManager.authorizationStatus {
        case .notDetermined:
            await pushManager.requestAuthorization()
            if pushManager.isAuthorized {
                var next = store.pushSettings
                if next.mode == .off { next.mode = .filings }
                await store.savePushSettings(next)
                await pushManager.syncTokenWithBackend(api: store.api)
            }
        case .denied:
            openSystemNotificationSettings()
        default:
            var next = store.pushSettings
            if next.mode == .off { next.mode = .filings }
            await store.savePushSettings(next)
            await pushManager.syncTokenWithBackend(api: store.api, force: true)
        }
    }

    private func openSystemNotificationSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        openURL(url)
    }
}

/// Per-ticker watchlist used by phone-push Watchlist mode.
struct PushWatchlistEditor: View {
    @EnvironmentObject private var store: CongressTradeStore
    @Binding var newTicker: String

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if store.watchlist.isEmpty {
                Text("no tickers yet — add a symbol to get watchlist alerts")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.bottom, 8)
            }
            ForEach(Array(store.watchlist.enumerated()), id: \.element) { index, ticker in
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 0) {
                        Text(ticker)
                            .font(.body.weight(.semibold).monospaced())
                        Text("    ")
                            .font(.body.weight(.semibold).monospaced())
                        Text("Minimum:  ")
                            .font(.caption2.weight(.medium))
                            .foregroundStyle(.secondary)

                        Menu {
                            Button {
                                updateMinAmount(for: ticker, min: nil)
                            } label: {
                                Text("None")
                            }
                            ForEach(PushSettings.amountCutoffs, id: \.self) { cutoff in
                                Button {
                                    updateMinAmount(for: ticker, min: cutoff)
                                } label: {
                                    Text(PushSettings.amountLabel(cutoff))
                                }
                            }
                        } label: {
                            Text(PushSettings.amountLabel(rule(for: ticker).minAmount) + "⭥")
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(Color.blue)
                        }
                        .buttonStyle(.plain)

                        Spacer(minLength: 4)

                        Button(role: .destructive) {
                            remove(ticker)
                        } label: {
                            Image(systemName: "minus.circle.fill")
                                .foregroundStyle(.red)
                                .font(.body)
                        }
                        .buttonStyle(.borderless)
                        .accessibilityLabel("Remove \(ticker)")
                    }

                    Picker("Sides", selection: sidesBinding(ticker)) {
                        ForEach(PushAlertSides.allCases) { side in
                            Text(side.label).tag(side)
                        }
                    }
                    .pickerStyle(.segmented)
                    .accessibilityLabel("\(ticker) sides")
                }
                .padding(.vertical, 4)
                .padding(.bottom, index == store.watchlist.count - 1 ? 16 : 5)
            }

            HStack(spacing: 8) {
                TextField("ticker (e.g. NVDA)", text: $newTicker)
                    .tickerAutocapitalized()
                    .autocorrectionDisabled()
                Button("Add") {
                    addTickers()
                }
                .buttonStyle(.borderless)
                .disabled(CongressTradeStore.parseTickers(newTicker).isEmpty)
            }
            .padding(.top, 4)
        }
    }

    private func rule(for ticker: String) -> TickerAlertRule {
        store.pushSettings.watchlistRules[ticker] ?? .default
    }

    private func updateMinAmount(for ticker: String, min: Int?) {
        var next = store.pushSettings
        var row = next.watchlistRules[ticker] ?? .default
        row.minAmount = min
        next.watchlistRules[ticker] = row
        Task { await store.savePushSettings(next) }
    }

    private func sidesBinding(_ ticker: String) -> Binding<PushAlertSides> {
        Binding(
            get: { rule(for: ticker).sides },
            set: { sides in
                var next = store.pushSettings
                var row = next.watchlistRules[ticker] ?? .default
                row.sides = sides
                next.watchlistRules[ticker] = row
                Task { await store.savePushSettings(next) }
            }
        )
    }

    private func addTickers() {
        let parsed = CongressTradeStore.parseTickers(newTicker)
        var tickers = store.watchlist
        for ticker in parsed where !tickers.contains(ticker) {
            tickers.append(ticker)
        }
        newTicker = ""
        Task { await store.saveWatchlist(tickers.joined(separator: ",")) }
    }

    private func remove(_ ticker: String) {
        let tickers = store.watchlist.filter { $0 != ticker }
        Task { await store.saveWatchlist(tickers.joined(separator: ",")) }
    }
}

// MARK: - Footer + filter chrome

/// Canonical Privacy / Terms / Pricing / Support destinations for every tab.
///
/// SwiftUI `Text("…")` only parses Markdown when the string is a *literal*
/// `LocalizedStringKey`. Concatenated strings render as raw `[label](url)` —
/// that is what the owner screenshot of the tab footer showed. Build the
/// attributed string ourselves so wrapping and taps both work.
enum AppLegal {
    static let supportEmail = "support@congress.trade"

    struct Destination: Identifiable, Equatable {
        let id: String
        let title: String
        let url: URL
    }

    static let destinations: [Destination] = [
        .init(id: "privacy", title: "Privacy", url: URL(string: "https://Congress.Trade/privacy-policy")!),
        .init(id: "terms", title: "Terms", url: URL(string: "https://Congress.Trade/terms-of-service")!),
        // Public URL stays for App Review / legal listings.  In-app taps use
        // `openPremium` (StoreKit) when the environment provides it.
        .init(id: "pricing", title: "Pricing", url: URL(string: "https://Congress.Trade/pricing")!),
        .init(id: "support", title: "Support", url: URL(string: "mailto:\(supportEmail)")!),
    ]

    static let markdown = destinations
        .map { "[\($0.title)](\($0.url.absoluteString))" }
        .joined(separator: "   •   ")

    static var attributed: AttributedString {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        return (try? AttributedString(markdown: markdown, options: options)) ?? AttributedString(markdown)
    }

    /// Pricing is the same digital good as IAP.  Footer taps must open
    /// StoreKit, never Safari checkout (Guideline 3.1.1).
    static func opensSafari(_ destination: Destination) -> Bool {
        destination.id != "pricing"
    }

    static func footerDestinations(includePricing: Bool, canOpenInAppPurchase: Bool) -> [Destination] {
        destinations.filter { destination in
            if destination.id == "pricing" {
                return includePricing && canOpenInAppPurchase
            }
            return true
        }
    }
}

/// Opens the in-app Premium / StoreKit sheet.  Set at the tab root and on
/// Account / Settings so footer Pricing never bounces to Safari checkout
/// (Apple 3.1.1 — same digital good as IAP).
private struct OpenPremiumActionKey: EnvironmentKey {
    static let defaultValue: (() -> Void)? = nil
}

extension EnvironmentValues {
    var openPremium: (() -> Void)? {
        get { self[OpenPremiumActionKey.self] }
        set { self[OpenPremiumActionKey.self] = newValue }
    }
}

/// Website `footer.site-footer` stack: the combined disclaimer, then the
/// Privacy / Terms / Pricing / Support row.  Centered, caption-sized, dim.
struct SiteFooterStack: View {
    var includePricing: Bool = true

    var body: some View {
        VStack(spacing: 16) {
            Text(AppTheme.siteFooterDisclaimer)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 6)
            LegalFooterLinks(includePricing: includePricing)
                .padding(.bottom, 8)
        }
        .frame(maxWidth: .infinity)
    }
}

/// Small grey Privacy / Terms / Pricing / Support row for the bottom of a tab.
///
/// Buttons rather than `Link`s: a `Link` renders in the accent color and this
/// row must stay quiet chrome, not four blue calls to action.
struct LegalFooterLinks: View {
    @Environment(\.openURL) private var openURL
    @Environment(\.openPremium) private var openPremium
    var includePricing: Bool = true

    var body: some View {
        let items = AppLegal.footerDestinations(
            includePricing: includePricing,
            canOpenInAppPurchase: openPremium != nil
        )
        HStack(spacing: 0) {
            ForEach(Array(items.enumerated()), id: \.element.id) { index, destination in
                if index > 0 {
                    Text("   •   ")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .accessibilityHidden(true)
                }
                Button(destination.title) {
                    if destination.id == "pricing" {
                        // Never fall through to Safari /pricing — that is web
                        // Stripe checkout for the same digital good as IAP.
                        openPremium?()
                        return
                    }
                    openURL(destination.url)
                }
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .buttonStyle(.plain)
                    .tint(Color(uiColor: .secondaryLabel))
            }
        }
    }
}

/// High-contrast "Subscribe with Apple" prominent button.
///
/// In Light mode: solid dark background, white text, white Apple logo.
/// In Dark mode: solid white background, black text, black Apple logo.
struct SubscribeWithAppleProminentButton: View {
    var action: () -> Void
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: "apple.logo")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(colorScheme == .dark ? Color.black : Color.white)
                Text("Subscribe with Apple")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(colorScheme == .dark ? Color.black : Color.white)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 12)
            .background(
                colorScheme == .dark ? Color.white : Color(red: 0.08, green: 0.08, blue: 0.08),
                in: RoundedRectangle(cornerRadius: 12, style: .continuous)
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Subscribe with Apple")
    }
}

/// Spinner that occupies its slot whether or not it is spinning, so a filter
/// strip does not grow a row (and shove everything below it down) the moment a
/// query starts.
struct FilterActivityIndicator: View {
    let isActive: Bool

    var body: some View {
        ProgressView()
            .controlSize(.small)
            .opacity(isActive ? 1 : 0)
            // Constant footprint — the reserved height is the whole point.
            .frame(width: 18, height: 18)
            .accessibilityHidden(!isActive)
            .accessibilityLabel("Updating")
    }
}

/// Pushes Light/Dark into the SwiftUI environment of an already-presented
/// sheet.  `nil` (System) clears the override so the sheet follows the device.
struct ForcedColorScheme: ViewModifier {
    let pref: String

    @ViewBuilder
    func body(content: Content) -> some View {
        if let scheme = AppAppearance.colorScheme(for: pref) {
            content
                .preferredColorScheme(scheme)
                .environment(\.colorScheme, scheme)
        } else {
            content.preferredColorScheme(nil)
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
                    AppAppearance.apply(option.id)
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: option.systemImage)
                            .font(.system(size: 13, weight: .semibold))
                        Text(option.label)
                            .font(.caption.weight(selection == option.id ? .semibold : .medium))
                            .lineLimit(1)
                            .minimumScaleFactor(0.75)
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 7)
                    .frame(maxWidth: .infinity)
                    .foregroundStyle(selection == option.id ? Color.primary : Color.secondary)
                    .background {
                        if selection == option.id {
                            RoundedRectangle(cornerRadius: 8, style: .continuous)
                                .fill(AppTheme.card)
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
        .background(AppTheme.background, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(Color(uiColor: .separator).opacity(0.6), lineWidth: 1)
        )
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Theme")
    }
}
