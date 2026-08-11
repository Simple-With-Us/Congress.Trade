import AuthenticationServices
import SwiftUI
import UserNotifications

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

    /// Kept for existing call sites; the table itself lives in `DisplayLabel`.
    var chamberLabel: String { DisplayLabel.chamber(self) }
}

// MARK: - Canonical display labels for raw DB enums

/// The ONE place a raw storage value becomes owner-facing text.
///
/// Before this existed the same four vocabularies were being re-spelled at
/// every call site — chamber in two files, transaction side in `String.label`,
/// and market cap / asset class as bare `.capitalized`, which is why the app
/// showed "Mega" where the website shows "Mega Cap" and "Etf" where it should
/// read "ETF". Values that are genuinely unknown fall back to a prettified
/// form of the raw string (`mutual_fund` → "Mutual Fund") rather than leaking
/// a snake_case database token into the UI.
///
/// Every function takes the raw optional and a `fallback` for absent data, so
/// call sites keep their own empty-state copy ("Not Enriched Yet", "—").
enum DisplayLabel {
    /// Transaction side. Storage codes are `P`/`S`/`E`; `B` is a buy alias.
    static func txType(_ raw: String?, fallback: String = "—") -> String {
        guard let key = normalized(raw) else { return fallback }
        switch key.uppercased() {
        case "S": return "Sell"
        case "B", "P": return "Buy"
        case "E": return "Exchange"
        default: return prettified(key)
        }
    }

    static func chamber(_ raw: String?, fallback: String = "—") -> String {
        guard let key = normalized(raw) else { return fallback }
        switch key.lowercased() {
        case "house": return "House"
        case "senate": return "Senate"
        case "executive": return "Executive"
        default: return prettified(key)
        }
    }

    /// Market-cap buckets — website parity with `CAP_NAMES`
    /// (`app/src/ui/dashboardHtml.ts`), including "Unclassified" for the
    /// `unknown` bucket the enrichment job writes when it cannot resolve a cap.
    static func marketCapBucket(_ raw: String?, fallback: String = "—") -> String {
        guard let key = normalized(raw) else { return fallback }
        switch key.lowercased() {
        case "mega": return "Mega Cap"
        case "large": return "Large Cap"
        case "mid": return "Mid Cap"
        case "small": return "Small Cap"
        case "micro": return "Micro Cap"
        case "nano": return "Nano Cap"
        case "unknown": return "Unclassified"
        default: return prettified(key)
        }
    }

    /// Asset class as written by enrichment (`app/src/enrichment/fmp.ts`,
    /// `providers.ts`): exactly `equity` | `etf` | `adr` | `fund`.
    static func assetClass(_ raw: String?, fallback: String = "—") -> String {
        guard let key = normalized(raw) else { return fallback }
        switch key.lowercased() {
        case "equity": return "Equity"
        case "etf": return "ETF"
        case "adr": return "ADR"
        case "fund": return "Fund"
        default: return prettified(key)
        }
    }

    /// Beneficial-owner code on the filing — `self` | `spouse` | `joint` |
    /// `dependent` (`app/src/ui/dashboardHtml.ts` normalizes to exactly these).
    static func owner(_ raw: String?, fallback: String = "—") -> String {
        guard let key = normalized(raw) else { return fallback }
        switch key.lowercased() {
        case "self": return "Self"
        case "spouse": return "Spouse"
        case "joint": return "Joint"
        case "dependent": return "Dependent"
        default: return prettified(key)
        }
    }

    /// Party, bucketed the same way the server's `asPartyBucket` does.
    static func party(_ raw: String?, fallback: String = "—") -> String {
        PartyFilter.bucket(for: raw)?.label ?? fallback
    }

    private static func normalized(_ raw: String?) -> String? {
        guard let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
            return nil
        }
        return trimmed
    }

    /// `mutual_fund` → "Mutual Fund". Only reached for a value none of the
    /// tables above know, so it must never show underscores.
    private static func prettified(_ raw: String) -> String {
        raw
            .replacingOccurrences(of: "_", with: " ")
            .replacingOccurrences(of: "-", with: " ")
            .capitalized
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

    /// Signed money for net-flow style figures: `+$1.2m` / `-$840k` / `$0`.
    ///
    /// Owner: "Net Flow should have a + before it if it is positive and not
    /// only rely on green color" — colour alone fails for the ~8% of men with
    /// red/green colour-vision deficiency, and fails entirely in a screenshot.
    ///
    /// Zero never takes a sign: `+$0` is wrong because zero is neither
    /// positive nor negative. The threshold is half a dollar rather than
    /// exact zero so the sign always agrees with the digits actually shown —
    /// `$0.40` renders as `$0`, so it must not render as `+$0`.
    ///
    /// `nil` still renders as an em dash, which stays distinct from a real
    /// zero: "we have no figure" and "the figure is zero" are different facts.
    static func signedUSD(_ value: Double?) -> String {
        guard let value else { return "—" }
        guard abs(value) >= 0.5 else { return "$0" }
        let magnitude = usd(value)
        return value > 0 ? "+\(magnitude)" : magnitude
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

// MARK: - Ledger rows (label column + left-aligned value)

/// Two-column ledger geometry for every label/value row in the app.
///
/// This is the iOS port of the web's `.drawer-kv` grid
/// (`app/src/ui/dashboardHtml.ts`: `grid-template-columns: 35% 1fr`, value
/// LEFT-aligned, and an explicit refusal to collapse it on mobile). The web
/// carries the owner's reason in its own comment — stacked label-above-value
/// "is impossible to look at without getting a headache" — and the trailing
/// half of that argument applies to `HStack { label; Spacer(); value }` just
/// as hard: on a 390pt sheet a `Spacer()` opens ~52% dead gap between a label
/// and its own value, ~30 times per detail sheet, so the eye has to travel the
/// full width of the screen to pair "First Trade" with its date.
///
/// Two rejected alternatives, recorded so they are not re-proposed:
/// - **Leader dots.** Rejected outright.
/// - **Right-aligning the value.** Rejected: ragged-left values make the eye
///   re-find the start of the value on every single row.
///
/// Geometry: label column = `min(38% of the row, labelMaxWidth)`, a 14pt
/// gutter, and the value taking every remaining point, left-aligned. Rows are
/// joined on `.firstTextBaseline` (not top edges) so a wrapped two-line label
/// still sits on the same line as its value's first line.
struct LedgerRowLayout: Layout {
    var labelFraction: CGFloat = 0.38
    var labelMaxWidth: CGFloat = 160
    var gutter: CGFloat = 14

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard subviews.count >= 2 else {
            return subviews.first?.sizeThatFits(proposal) ?? .zero
        }
        let width = resolvedWidth(proposal, subviews: subviews)
        let cols = columns(width: width)
        let label = subviews[0].dimensions(in: ProposedViewSize(width: cols.label, height: nil))
        let value = subviews[1].dimensions(in: ProposedViewSize(width: cols.value, height: nil))
        let baseline = max(label[.firstTextBaseline], value[.firstTextBaseline])
        let height = max(
            baseline - label[.firstTextBaseline] + label.height,
            baseline - value[.firstTextBaseline] + value.height
        )
        return CGSize(width: width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard subviews.count >= 2 else {
            subviews.first?.place(at: bounds.origin, anchor: .topLeading, proposal: proposal)
            return
        }
        let cols = columns(width: bounds.width)
        let labelProposal = ProposedViewSize(width: cols.label, height: nil)
        let valueProposal = ProposedViewSize(width: cols.value, height: nil)
        let label = subviews[0].dimensions(in: labelProposal)
        let value = subviews[1].dimensions(in: valueProposal)
        let baseline = max(label[.firstTextBaseline], value[.firstTextBaseline])
        subviews[0].place(
            at: CGPoint(x: bounds.minX, y: bounds.minY + baseline - label[.firstTextBaseline]),
            anchor: .topLeading,
            proposal: labelProposal
        )
        subviews[1].place(
            at: CGPoint(
                x: bounds.minX + cols.label + gutter,
                y: bounds.minY + baseline - value[.firstTextBaseline]
            ),
            anchor: .topLeading,
            proposal: valueProposal
        )
    }

    /// An unspecified/infinite proposal (a stack's ideal-size pass) has to
    /// report a natural width, or an enclosing `VStack` shrink-wraps the whole
    /// section to the narrowest row.
    private func resolvedWidth(_ proposal: ProposedViewSize, subviews: Subviews) -> CGFloat {
        if let width = proposal.width, width.isFinite, width > 0 { return width }
        let label = min(subviews[0].sizeThatFits(.unspecified).width, labelMaxWidth)
        let value = subviews[1].sizeThatFits(.unspecified).width
        return label + gutter + value
    }

    private func columns(width: CGFloat) -> (label: CGFloat, value: CGFloat) {
        let target = min(width * labelFraction, labelMaxWidth)
        let label = max(0, min(target, width - gutter))
        return (label, max(0, width - label - gutter))
    }
}

/// One label/value ledger row — the single row primitive for every detail
/// sheet. See `LedgerRowLayout` for the geometry and why `Spacer()` is gone.
///
/// The label is deliberately small/uppercase/secondary and the value is the
/// larger, primary, tabular-figure text: with both columns left-aligned the
/// weight contrast is what separates them, so the row still reads as two
/// fields rather than one sentence.
struct DetailRow<Value: View>: View {
    /// Scales with Dynamic Type so the label column does not force every label
    /// onto two lines at accessibility sizes — still hard-capped at 38% of the
    /// row by `LedgerRowLayout`.
    @ScaledMetric(relativeTo: .caption2) private var labelMaxWidth: CGFloat = 160

    private let label: String
    private let showsChevron: Bool
    private let value: Value

    /// Rich value (party emoji + name, pills, tinted amounts, …).
    init(_ label: String, showsChevron: Bool = false, @ViewBuilder value: () -> Value) {
        self.label = label
        self.showsChevron = showsChevron
        self.value = value()
    }

    var body: some View {
        LedgerRowLayout(labelMaxWidth: labelMaxWidth, gutter: 14) {
            Text(label)
                .font(.caption2.weight(.semibold))
                .tracking(0.4)
                .textCase(.uppercase)
                .foregroundStyle(.secondary)
                // No lineLimit / truncation: a long label at the largest
                // Dynamic Type size must WRAP inside its column, never clip.
                .fixedSize(horizontal: false, vertical: true)
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                value
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.primary)
                    .monospacedDigit()
                    .fixedSize(horizontal: false, vertical: true)
                if showsChevron {
                    Spacer(minLength: 8)
                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(.tertiary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

extension DetailRow where Value == Text {
    /// Plain string value — source-compatible with every existing call site.
    init(_ label: String, _ value: String, showsChevron: Bool = false) {
        self.init(label, showsChevron: showsChevron) { Text(value) }
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
    /// Product labels: Buy / Sell / Exchange. Storage codes remain P|S|E; B is
    /// a buy alias. Kept for existing call sites; the table is `DisplayLabel`.
    var label: String { DisplayLabel.txType(self, fallback: self) }

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

// MARK: - Header chrome (subtle icon buttons + hamburger account menu)

/// Grey, not accent-blue.
///
/// The owner has asked twice for these header glyphs to be grey, and
/// `.foregroundStyle(.secondary)` alone does not deliver it: a `Button` in a
/// `ToolbarItem` is rendered as a bar-button item, whose label inherits the
/// bar's tint — and `MainTabView` sets `.tint(.blue)` on the `TabView`
/// (`App.swift`), which propagates down as the accent colour and wins over a
/// plain foreground style on the label's `Image`.
///
/// Three defences, because the obvious one has already failed in production:
/// 1. `.buttonStyle(.plain)` — opts the label out of the bar-button treatment;
/// 2. `.tint(Color.secondary)` on the `Button` itself — retints whatever still
///    resolves through the accent colour;
/// 3. `.symbolRenderingMode(.monochrome)` + an explicit `.foregroundStyle`
///    on the `Image` — pins the glyph even if it is drawn as a template.
private struct HeaderGlyph: View {
    let systemImage: String

    var body: some View {
        Image(systemName: systemImage)
            // `.title3` (not a fixed point size) so the "slightly larger"
            // glyph still scales with Dynamic Type.
            .font(.title3.weight(.semibold))
            .symbolRenderingMode(.monochrome)
            .foregroundStyle(Color.secondary)
            // minWidth/minHeight (not a fixed frame) so the tap target can
            // grow past 34pt for large Dynamic Type sizes instead of
            // clipping the glyph.
            .frame(minWidth: 34, minHeight: 34)
            .contentShape(Circle())
    }
}

/// Subtle header circle button used for the ⓘ control on Trades and Trends:
/// no tinted stroke (the SF Symbol's own `.circle` glyph already reads as a
/// circle), grey secondary colour, and a tap target smaller than the default
/// ~44pt toolbar hit area. See `HeaderGlyph` for why grey needs three fixes.
struct HeaderIconButton: View {
    let systemImage: String
    let accessibilityLabel: String
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            HeaderGlyph(systemImage: systemImage)
        }
        .buttonStyle(.plain)
        .tint(Color.secondary)
        .accessibilityLabel(accessibilityLabel)
    }
}

/// Header hamburger button (top-right on Trades/Trends) opening
/// `AccountQuickMenu`.
///
/// A large sheet, not the 290pt popover this used to present: the owner wants
/// this menu to "fill most the screen", and everything that used to be
/// scattered across the Settings and Delivery tabs (sign-in, alerts, CSV
/// export, Premium, theme, legal links) now lives inside it.
///
/// The store/push objects are read here and handed to the sheet explicitly —
/// same defensive habit as the existing `ExportCSVSheet` / `SubscribeView`
/// presentations, so the menu cannot come up half-wired.
struct HamburgerMenuButton: View {
    @EnvironmentObject private var store: CongressTradeStore
    @EnvironmentObject private var pushManager: PushNotificationManager
    @State private var showMenu = false

    var body: some View {
        Button {
            showMenu = true
        } label: {
            HeaderGlyph(systemImage: "line.3.horizontal")
        }
        .buttonStyle(.plain)
        .tint(Color.secondary)
        .accessibilityLabel("Menu")
        .sheet(isPresented: $showMenu) {
            AccountQuickMenu(isPresented: $showMenu)
                .environmentObject(store)
                .environmentObject(pushManager)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
    }
}

/// The one place the app keeps account, alerts, export, Premium and theme.
///
/// The owner's complaint was not that any single control was wrong, it was
/// that they were scattered: sign-in on the Settings tab, alerts split between
/// Settings and Delivery, CSV export behind a bare arrow glyph in the Trades
/// toolbar, Premium in a third place. This sheet is the answer — one large
/// surface reachable from the ☰ on every tab, in the order the owner listed:
/// account, Trade Disclosure Alerts, Export CSV, Premium, theme, legal.
///
/// Deliberately NOT a `Form`: `Form`/`List` rows retint their button labels
/// with the accent colour, which is exactly what turned the Google button
/// "all blue" on the Settings tab.
struct AccountQuickMenu: View {
    @EnvironmentObject private var store: CongressTradeStore
    @Environment(\.openURL) private var openURL
    @AppStorage("app_color_scheme") private var appColorScheme = "system"
    @Binding var isPresented: Bool
    @State private var showSubscribe = false
    @State private var showPremiumInfo = false
    @State private var showExport = false
    @State private var isOpeningManageSubscription = false
    @State private var manageSubscriptionError: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    accountSection

                    Divider()

                    TradeDisclosureAlertsToggle()

                    Divider()

                    Button {
                        showExport = true
                    } label: {
                        menuRow("Export CSV", systemImage: "arrow.down.doc")
                    }
                    .buttonStyle(.plain)

                    Divider()

                    billingButton

                    Divider()

                    // No "Theme" caption and no explanation of what light and
                    // dark mean — the three icons say it (owner).
                    ThemeSegmentControl(selection: $appColorScheme)

                    Divider()

                    LegalFooterLinks()

                    // Short disclaimer line — mobile-web parity with `.site-footer`.
                    Text("Congress.Trade is an educational tool for public STOCK Act disclosures.  Not financial advice — dollar figures are estimates from disclosed brackets.")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.horizontal, 20)
                .padding(.top, 8)
                .padding(.bottom, 28)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(AppTheme.background)
            .navigationTitle("Account")
            .inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { isPresented = false }
                }
            }
        }
        .sheet(isPresented: $showSubscribe) {
            SubscribeView()
                .environmentObject(store)
        }
        .sheet(isPresented: $showPremiumInfo) {
            // Signed out, "sign in" simply closes this back to the menu —
            // the sign-in panel is already the first thing on it.
            PremiumInfoSheet(onSignIn: { showPremiumInfo = false })
                .environmentObject(store)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showExport) {
            ExportCSVSheet()
                .environmentObject(store)
                .presentationDetents([.medium])
                .presentationDragIndicator(.visible)
        }
    }

    @ViewBuilder
    private var accountSection: some View {
        if store.signedIn, let user = store.signedInUser {
            VStack(alignment: .leading, spacing: 16) {
                HStack(spacing: 12) {
                    Image(systemName: "person.crop.circle.fill")
                        .font(.system(size: 34))
                        .foregroundStyle(.secondary)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(user.name?.isEmpty == false ? user.name! : user.email)
                            .font(.headline)
                            .lineLimit(1)
                        Text(store.entitlementLabel)
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(.secondary)
                    }
                }
                .accessibilityElement(children: .combine)

                Button(role: .destructive) {
                    Task { await store.signOut() }
                } label: {
                    menuRow(
                        store.isLoggingOut ? "Signing Out…" : "Sign Out",
                        systemImage: "rectangle.portrait.and.arrow.right",
                        tint: .red
                    )
                }
                .buttonStyle(.plain)
                .disabled(store.isLoggingOut)
            }
        } else {
            SignInPanel(onSignedIn: { isPresented = false })
        }
    }

    @ViewBuilder
    private var billingButton: some View {
        if store.isPremium {
            VStack(alignment: .leading, spacing: 8) {
                Button {
                    Task { await openManageSubscription() }
                } label: {
                    HStack {
                        menuRow("Manage Subscription", systemImage: "creditcard")
                        if isOpeningManageSubscription {
                            ProgressView()
                        }
                    }
                }
                .buttonStyle(.plain)
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
            }
        } else {
            Button {
                showPremiumInfo = true
            } label: {
                menuRow("Upgrade to Premium", systemImage: "sparkles")
            }
            .buttonStyle(.plain)
        }
    }

    /// One tappable menu line: glyph, Title Case label, chevron. Colours are
    /// explicit for the same reason `HeaderGlyph`'s are.
    private func menuRow(_ title: String, systemImage: String, tint: Color = .primary) -> some View {
        HStack(spacing: 12) {
            Image(systemName: systemImage)
                .symbolRenderingMode(.monochrome)
                .foregroundStyle(tint == .primary ? Color.secondary : tint)
                .frame(width: 24)
            Text(title)
                .font(.body.weight(.medium))
                .foregroundStyle(tint)
            Spacer(minLength: 12)
            Image(systemName: "chevron.right")
                .font(.caption.weight(.bold))
                .foregroundStyle(.tertiary)
        }
        .contentShape(Rectangle())
    }

    /// Routes by `entitlementSource` — see `Store/ManageSubscription.swift`.
    /// Only dismisses once a URL is actually opened; a failure stays put and
    /// shows `manageSubscriptionError` inline instead of silently closing on a
    /// dead link.
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

// MARK: - Sign in

/// Google's own button chrome, at Apple-button parity.
///
/// The owner's report — "sign in with google has a weird all blue text and
/// doesn't have google symbol or normal google color button" — is a tint
/// problem, not a missing asset: the button already drew a multicolour G, but
/// it lived in a `Form` row, where the row style repaints button labels with
/// the accent colour that `MainTabView`'s `.tint(.blue)` supplies. A custom
/// `ButtonStyle` is used instead of `.buttonStyle(.plain)` alone because a
/// style installed on the button always wins over the list's own.
///
/// Colours are Google's published branding values, not approximations, and
/// they are hard-coded per appearance rather than taken from system materials
/// so the surface stays exactly white (light) / #131314 (dark) in both themes.
struct GoogleSignInButton: View {
    var title: String = "Sign in with Google"
    var isBusy: Bool = false
    var action: () -> Void

    @Environment(\.colorScheme) private var colorScheme

    private var surface: Color { colorScheme == .dark ? Color(hex: 0x131314) : Color(hex: 0xFFFFFF) }
    private var border: Color { colorScheme == .dark ? Color(hex: 0x8E918F) : Color(hex: 0x747775) }
    private var label: Color { colorScheme == .dark ? Color(hex: 0xE3E3E3) : Color(hex: 0x1F1F1F) }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                GoogleGlyph()
                    .frame(width: 20, height: 20)
                Text(isBusy ? "Opening Google…" : title)
                    // Google's spec calls for a 14pt medium label; scaled with
                    // Dynamic Type so it is not the one fixed-size string in
                    // the app.
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(label)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
        }
        .buttonStyle(BrandedSignInButtonStyle(surface: surface, border: border))
        .tint(label)
        .accessibilityLabel("Sign in with Google")
    }
}

/// 50pt / 8pt-continuous / full-width surface shared with the Apple button, so
/// the two controls are the same size and shape stacked on top of each other.
private struct BrandedSignInButtonStyle: ButtonStyle {
    let surface: Color
    let border: Color

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .frame(maxWidth: .infinity)
            .frame(height: SignInPanel.controlHeight)
            .background(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(surface)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .stroke(border, lineWidth: 1)
            )
            .contentShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            .opacity(configuration.isPressed ? 0.82 : 1)
    }
}

/// Multicolour Google "G". Drawn in a `Canvas` with explicit colours, which is
/// what makes it immune to the accent tint that flattened the old mark.
private struct GoogleGlyph: View {
    var body: some View {
        Canvas { context, size in
            let blue = Color(hex: 0x4285F4)
            let green = Color(hex: 0x34A853)
            let yellow = Color(hex: 0xFBBC05)
            let red = Color(hex: 0xEA4335)
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
                context.stroke(path, with: .color(color), style: StrokeStyle(lineWidth: lineWidth, lineCap: .butt))
            }
            arc(-35, 20, blue)
            arc(20, 120, green)
            arc(120, 220, yellow)
            arc(220, 325, red)
            // The bar that turns the ring into a G.
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

/// The app's ONE sign-in implementation: Apple, Google, email link.
///
/// Previously this existed twice — a full version on the Settings tab and a
/// cut-down one in the header menu that punted Google and email back to
/// Settings — which is a large part of why the owner found "the entire sign in
/// part" confusing. Both surfaces now embed this panel, so the three methods
/// are always offered together, in the same order, at the same size.
///
/// Failures are shown. Sign in with Apple was reported as simply not working,
/// and the header menu is how it was being reached: `handleAppleSignIn` does
/// call `setAccountNotice` on every failure path (`Store/AppleSignIn.swift`),
/// but nothing in the menu ever rendered that notice, so a rejected token or a
/// 503 looked identical to a tap that did nothing.
struct SignInPanel: View {
    /// Called once a session token has been stored — hosts use it to dismiss.
    var onSignedIn: (() -> Void)? = nil

    /// Apple's minimum recommended height, matched by the Google button so the
    /// two controls are indistinguishable in size.
    static let controlHeight: CGFloat = 50

    @EnvironmentObject private var store: CongressTradeStore
    @Environment(\.colorScheme) private var colorScheme
    /// Raw nonce for the in-flight Sign in with Apple request, set by the
    /// button's request-configuration closure and consumed by
    /// `handleAppleSignIn` on completion. See `Store/AppleSignIn.swift`.
    @State private var currentAppleNonce: String?
    @State private var isAuthenticating = false
    @State private var magicEmail = ""
    @FocusState private var magicEmailFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SignInWithAppleButton(.signIn) { request in
                // Name + email on the first authorization so the backend can
                // store a display name — Apple only ever sends `fullName` once.
                request.requestedScopes = [.fullName, .email]
                let nonce = AppleSignInNonce.generate()
                currentAppleNonce = nonce
                request.nonce = nonce
            } onCompletion: { result in
                Task {
                    await store.handleAppleSignIn(result, rawNonce: currentAppleNonce)
                    currentAppleNonce = nil
                    if store.signedIn { onSignedIn?() }
                }
            }
            .signInWithAppleButtonStyle(colorScheme == .dark ? .white : .black)
            .frame(maxWidth: .infinity)
            .frame(height: Self.controlHeight)
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            .accessibilityLabel("Sign in with Apple")

            GoogleSignInButton(isBusy: isAuthenticating) {
                startGoogleSignIn()
            }
            .disabled(isAuthenticating)

            HStack(spacing: 8) {
                TextField("you@example.com", text: $magicEmail)
                    .urlKeyboard()
                    .neverAutocapitalized()
                    .autocorrectionDisabled()
                    .focused($magicEmailFocused)
                    .submitLabel(.done)
                    .onSubmit { magicEmailFocused = false }
                    .padding(.horizontal, 12)
                    .frame(height: Self.controlHeight)
                    .background(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .fill(Color(uiColor: .secondarySystemBackground))
                    )
                Button {
                    magicEmailFocused = false
                    Task { await store.requestMagicLink(email: magicEmail) }
                } label: {
                    Text("Email Link")
                        .font(.subheadline.weight(.semibold))
                        .padding(.horizontal, 14)
                        .frame(height: Self.controlHeight)
                }
                .buttonStyle(.bordered)
                .disabled(magicEmail.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }

            if let notice = store.watchlistNotice, !notice.isEmpty {
                Text(notice)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isStaticText)
            }
        }
    }

    /// Google OAuth via `ASWebAuthenticationSession`, the one copy in the app.
    /// Honors the configured API base URL (`CONGRESS_TRADE_API_BASE_URL`) so
    /// non-prod backends get the OAuth round trip too. The presentation anchor
    /// lives in `Views/Status/SettingsView.swift` (`AuthPresentationContext`)
    /// because it is UIKit glue, not part of the flow.
    private func startGoogleSignIn() {
        guard !isAuthenticating else { return }

        var components = URLComponents(
            url: store.api.origin.appendingPathComponent("auth/google/start"),
            resolvingAgainstBaseURL: false
        )
        components?.queryItems = [URLQueryItem(name: "client", value: "ios")]
        guard let authURL = components?.url else {
            store.setAccountNotice("Google sign-in is not configured for this build.")
            return
        }
        isAuthenticating = true

        let session = ASWebAuthenticationSession(url: authURL, callbackURLScheme: "congresstrade") { callbackURL, error in
            isAuthenticating = false
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

            if store.saveSessionToken(token) { onSignedIn?() }
        }

        session.presentationContextProvider = AuthPresentationContext.shared
        session.start()
    }
}

// MARK: - Legal footer

/// Privacy / Terms / Pricing / Support, small and grey, for the bottom of
/// every tab (App Store review expects these reachable from inside the app,
/// and the owner asked for them on all tabs rather than buried in Settings).
///
/// Built as a single Markdown `Text` rather than an `HStack` of `Link`s so it
/// wraps to a second line at large Dynamic Type instead of being squeezed or
/// clipped. `.tint` is what colours Markdown links, so it is set explicitly —
/// without it these would be accent-blue like everything else.
struct LegalFooterLinks: View {
    var body: some View {
        Text(
            "[Privacy](https://Congress.Trade/privacy-policy)  •  " +
            "[Terms](https://Congress.Trade/terms-of-service)  •  " +
            "[Pricing](https://Congress.Trade/pricing)  •  " +
            "[Support](mailto:congress.trade@jays.services)"
        )
        .font(.caption2)
        .foregroundStyle(.secondary)
        .tint(Color.secondary)
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 6)
    }
}

// MARK: - Premium

/// One screen that says what Premium is, with an obvious way out.
///
/// Owner: "probably there should be a pop up that mentions what premium offers
/// in one screen but isn't a hard sell and is easy to move on without signing
/// in or signing up." So: no countdown, no scarcity, no dark-pattern "maybe
/// later" in 9pt grey — "Not Now" is a full-width control the same size as the
/// upgrade one, and the whole sheet reads perfectly well signed out.
///
/// Every claim below is checked against a real server-side gate:
/// - CSV export — `GET /export/transactions.csv` 402s without premium
///   (`app/src/delivery/rest.ts`);
/// - source filing PDFs — `serveDocumentPdf` redirects to `/pricing?feature=pdf`;
/// - webhook / SSE delivery — `create_subscription` requires premium
///   (`app/src/client/commands.ts`), capped at
///   `MAX_SUBSCRIPTIONS_PER_USER = 2` (`app/src/delivery/subscriptions.ts`).
///
/// Push notifications are deliberately NOT listed. `register_device` returns
/// before the premium check in `app/src/client/commands.ts`, so device alerts
/// are free — and the free thing is called out explicitly, because a paywall
/// that claims something you already have is the fastest way to lose trust.
struct PremiumInfoSheet: View {
    /// Signed-out CTA. Hosts route this to wherever their sign-in lives.
    var onSignIn: (() -> Void)? = nil

    @EnvironmentObject private var store: CongressTradeStore
    @Environment(\.dismiss) private var dismiss
    @State private var showSubscribe = false

    private struct Benefit: Identifiable {
        let id = UUID()
        let systemImage: String
        let title: String
        let detail: String
    }

    private let benefits: [Benefit] = [
        .init(
            systemImage: "arrow.down.doc",
            title: "Full-History CSV Export",
            detail: "Download every disclosure matching your filters, not just the page on screen."
        ),
        .init(
            systemImage: "doc.text.magnifyingglass",
            title: "Source Filing PDFs",
            detail: "Open the original House or Senate document behind any trade."
        ),
        .init(
            systemImage: "bolt.horizontal",
            title: "Instant Delivery",
            detail: "Up to two webhook or SSE streams that push new disclosures as they land."
        )
    ]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Premium")
                        .font(.title2.weight(.bold))
                    Text("Congress.Trade is free to read.  Premium adds the parts that move data out of the app.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                VStack(alignment: .leading, spacing: 18) {
                    ForEach(benefits) { benefit in
                        HStack(alignment: .top, spacing: 14) {
                            Image(systemName: benefit.systemImage)
                                .font(.title3)
                                .symbolRenderingMode(.monochrome)
                                .foregroundStyle(Color.secondary)
                                .frame(width: 28)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(benefit.title)
                                    .font(.subheadline.weight(.semibold))
                                Text(benefit.detail)
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        .accessibilityElement(children: .combine)
                    }
                }

                Text("Trade Disclosure Alerts on this device are free — they are not part of Premium.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                Text("1-month free trial, then $5/month or $50/year.")
                    .font(.subheadline.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)

                VStack(spacing: 10) {
                    if store.isPremium {
                        Text("You already have Premium.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    } else if store.signedIn {
                        Button {
                            showSubscribe = true
                        } label: {
                            Text("See Subscription Options")
                                .font(.body.weight(.semibold))
                                .frame(maxWidth: .infinity)
                                .frame(height: SignInPanel.controlHeight)
                        }
                        .buttonStyle(.borderedProminent)
                    } else if onSignIn != nil {
                        Button {
                            onSignIn?()
                            dismiss()
                        } label: {
                            Text("Sign In to Subscribe")
                                .font(.body.weight(.semibold))
                                .frame(maxWidth: .infinity)
                                .frame(height: SignInPanel.controlHeight)
                        }
                        .buttonStyle(.borderedProminent)
                    } else {
                        Text("Premium needs a free account.  Sign in from the ☰ menu on any tab.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    Button {
                        dismiss()
                    } label: {
                        Text("Not Now")
                            .font(.body.weight(.semibold))
                            .frame(maxWidth: .infinity)
                            .frame(height: SignInPanel.controlHeight)
                    }
                    .buttonStyle(.bordered)
                }

                LegalFooterLinks()
            }
            .padding(.horizontal, 20)
            .padding(.top, 20)
            .padding(.bottom, 28)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(AppTheme.background)
        .sheet(isPresented: $showSubscribe) {
            SubscribeView()
                .environmentObject(store)
        }
    }
}

// MARK: - Trade Disclosure Alerts

/// Push notifications, named for what they do.
///
/// Owner: remove "Push Notifications (APNs)" and rename the option "Trade
/// Disclosure Alerts" with an on/off toggle. "APNs" is Apple's transport, not
/// a feature, and it appears nowhere in this control.
///
/// The toggle reflects the OS permission, which is the only thing that
/// actually decides whether an alert can reach the phone — so it cannot go out
/// of sync with reality, and it cannot lie. Two honest consequences:
/// - Turning it OFF opens iOS Settings, because an app cannot revoke its own
///   notification permission. The status line says so rather than pretending
///   the flip worked.
/// - Once permission is denied, iOS will never show the system prompt again;
///   re-tapping routes to Settings instead of silently doing nothing.
struct TradeDisclosureAlertsToggle: View {
    @EnvironmentObject private var store: CongressTradeStore
    @EnvironmentObject private var pushManager: PushNotificationManager
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Toggle(isOn: binding) {
                Text("Trade Disclosure Alerts")
                    .font(.body.weight(.medium))
            }
            .tint(.blue)

            // Exactly one short sentence-case line — never a paragraph
            // explaining what a notification is.
            Text(statusLine)
                .font(.caption)
                .foregroundStyle(statusColor)
                .fixedSize(horizontal: false, vertical: true)
        }
        .task { await pushManager.checkPermissionStatus() }
        // Coming back from iOS Settings is the one way this state changes
        // behind the app's back.
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            Task { await pushManager.checkPermissionStatus() }
        }
    }

    private var binding: Binding<Bool> {
        Binding(
            get: { pushManager.isAuthorized },
            set: { wantsOn in
                if wantsOn {
                    turnOn()
                } else {
                    openSystemSettings()
                }
            }
        )
    }

    private func turnOn() {
        switch pushManager.authorizationStatus {
        case .denied:
            openSystemSettings()
        case .notDetermined:
            Task {
                await pushManager.requestAuthorization()
                await syncIfPossible()
            }
        default:
            Task { await syncIfPossible() }
        }
    }

    private func syncIfPossible() async {
        guard pushManager.isAuthorized, store.signedIn else { return }
        await pushManager.syncTokenWithBackend(api: store.api, force: true)
    }

    private func openSystemSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        openURL(url)
    }

    private var statusLine: String {
        switch pushManager.authorizationStatus {
        case .denied:
            return "blocked in iOS Settings — tap to open them"
        case .notDetermined:
            return "off"
        default:
            break
        }
        if !store.signedIn {
            return "sign in to receive alerts on this device"
        }
        if pushManager.isBackendSynced {
            return "on — new disclosures alert this device"
        }
        if pushManager.isRegistering {
            return "registering this device…"
        }
        if pushManager.lastError != nil {
            return "this device could not be registered — toggle again to retry"
        }
        return "on — waiting for this device to register"
    }

    private var statusColor: Color {
        if pushManager.authorizationStatus == .denied { return .orange }
        if pushManager.isBackendSynced { return .green }
        if pushManager.lastError != nil { return .red }
        return .secondary
    }
}

// MARK: - Filter activity

/// "It is working, wait" — for the 3-5 seconds a filter change takes.
///
/// Reserves its height whether or not it is active, so appearing and
/// disappearing never shoves the list under the user's thumb mid-tap. That is
/// the whole reason this is a component and not an inline `if isLoading`.
struct FilterActivityIndicator: View {
    let isActive: Bool

    @ScaledMetric(relativeTo: .caption2) private var rowHeight: CGFloat = 18

    var body: some View {
        HStack(spacing: 6) {
            if isActive {
                ProgressView()
                    .controlSize(.mini)
                Text("Updating results…")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(height: rowHeight)
        .frame(maxWidth: .infinity, alignment: .leading)
        .animation(.easeInOut(duration: 0.15), value: isActive)
        .accessibilityHidden(!isActive)
    }
}

// MARK: - Brand lockup

/// Website-parity brand lockup: eagle + bag with CONGRESS / TRADE baked into
/// the light/dark lockup assets. No trailing "Congress.Trade" text.
///
/// Fixed width AND height, deliberately. The Trades tab's logo rendered
/// smaller than the Trends tab's for a purely mechanical reason: a `.principal`
/// toolbar item is centred, so its usable width is the screen minus *twice*
/// the widest side, and Trades carried one more trailing button than Trends.
/// The old `.frame(height: 46).frame(maxWidth: 330)` was flexible, so it
/// quietly scaled down to fit — the same view, two sizes. Pinning both
/// dimensions (the artwork is 1670x334, exactly 5:1) makes the lockup render
/// identically on every tab.
///
/// This holds as long as each tab's bar has at most one leading and one
/// trailing item: 230pt fits the ~275pt a centred principal item gets on the
/// narrowest supported phone. Adding a third toolbar button back to any tab
/// re-creates the bug — that is what the ☰ sheet is for.
struct BrandTitle: View {
    /// ~2mm at 460ppi — opens a sliver of space between the Dynamic Island and
    /// the eagle (owner). Applied as an offset rather than padding so the item
    /// does not grow taller than the bar and get centre-clipped instead.
    var nudgeUp: CGFloat = 6

    private static let lockupHeight: CGFloat = 46
    private static let lockupWidth: CGFloat = 230

    var body: some View {
        Image("BrandLockup")
            .resizable()
            .scaledToFit()
            .frame(width: Self.lockupWidth, height: Self.lockupHeight)
            .offset(y: -nudgeUp)
            .accessibilityLabel("Congress.Trade")
    }
}

// MARK: - Colour helpers

private extension Color {
    /// `0xRRGGBB` literal, for brand colours that must not drift with the
    /// system palette (Google's button surface/border/label).
    init(hex: UInt32) {
        self.init(
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255
        )
    }
}
