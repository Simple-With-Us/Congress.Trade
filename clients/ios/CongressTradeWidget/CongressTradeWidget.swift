import Foundation
import SwiftUI
import WidgetKit

// This extension reads the public client contract directly.  It deliberately
// owns small value types rather than loading the app's SwiftData model graph.
struct WidgetTrade: Codable, Identifiable {
    let id: String
    let member: Member?
    let asset: Asset?
    let transaction: Transaction?
    let filing: Filing?

    struct Member: Codable {
        let name: String?
    }

    struct Asset: Codable {
        let name: String?
        let ticker: String?
    }

    struct Filing: Codable {
        let filedDate: String?
        let firstSeenAt: String?
    }

    struct Transaction: Codable {
        let date: String?
        let type: String?
        let amountMin: Double?
        let amountMax: Double?

        private enum CodingKeys: String, CodingKey { case date, type, amountMin, amountMax }

        init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            date = try? values.decode(String.self, forKey: .date)
            type = try? values.decode(String.self, forKey: .type)
            amountMin = Self.amount(values, .amountMin)
            amountMax = Self.amount(values, .amountMax)
        }

        private static func amount(_ values: KeyedDecodingContainer<CodingKeys>, _ key: CodingKeys) -> Double? {
            let value: Double?
            if let number = try? values.decode(Double.self, forKey: key) {
                value = number
            } else if let text = try? values.decode(String.self, forKey: key) {
                value = Double(text.trimmingCharacters(in: .whitespacesAndNewlines))
            } else {
                value = nil
            }
            guard let value, value.isFinite, value >= 0 else { return nil }
            return value
        }
    }

    private enum CodingKeys: String, CodingKey { case id, member, asset, transaction, filing }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        guard !id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw DecodingError.dataCorruptedError(forKey: .id, in: values, debugDescription: "Missing trade identity")
        }
        member = try? values.decode(Member.self, forKey: .member)
        asset = try? values.decode(Asset.self, forKey: .asset)
        transaction = try? values.decode(Transaction.self, forKey: .transaction)
        filing = try? values.decode(Filing.self, forKey: .filing)
    }

    var symbol: String { Self.clean(asset?.ticker) ?? Self.clean(asset?.name) ?? "Undisclosed asset" }
    var memberName: String { Self.clean(member?.name) ?? "Unnamed filer" }
    var assetName: String? { Self.clean(asset?.ticker) == nil ? nil : Self.clean(asset?.name) }

    fileprivate var direction: TradeDirection {
        switch transaction?.type?.uppercased() {
        case "B", "P": return .buy
        case "S": return .sell
        case "E": return .exchange
        default: return .unknown
        }
    }

    var amountText: String {
        let lower = transaction?.amountMin
        let upper = transaction?.amountMax
        if let lower, let upper, upper >= lower {
            return lower == upper ? Self.dollars(lower) : "\(Self.dollars(lower))–\(Self.dollars(upper))"
        }
        if let lower, upper == nil { return "\(Self.dollars(lower))+" }
        if let upper, lower == nil { return "Up to \(Self.dollars(upper))" }
        return "Amount unavailable"
    }

    var deepLink: URL {
        var url = URLComponents()
        url.scheme = "congresstrade"
        url.host = "trade"
        url.queryItems = [URLQueryItem(name: "trade", value: id)]
        return url.url ?? WidgetEntry.feedURL
    }

    var disclosureDateText: String {
        let filed = WidgetDate.day(filing?.filedDate)
        let added = WidgetDate.day(filing?.firstSeenAt)
        return filed != "—" || added == "—" ? "Filed \(filed)" : "Filed — · Added \(added)"
    }

    var accessibleDescription: String {
        "\(symbol), \(direction.title), \(memberName), \(amountText).  Traded \(WidgetDate.day(transaction?.date)).  Filed \(WidgetDate.day(filing?.filedDate))."
    }

    private static func clean(_ value: String?) -> String? {
        guard let text = value?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return nil }
        return text
    }

    // Hoisted so a five-row render does not rebuild a NumberFormatter per amount.
    private static let currencyFormatter: NumberFormatter = {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.locale = Locale(identifier: "en_US")
        return formatter
    }()

    private static func dollars(_ value: Double) -> String {
        currencyFormatter.maximumFractionDigits = value.rounded() == value ? 0 : 2
        return currencyFormatter.string(from: NSNumber(value: value)) ?? "Amount unavailable"
    }
}

private struct WidgetFeed: Decodable {
    let items: [FailableTrade]

    struct FailableTrade: Decodable {
        let value: WidgetTrade?
        init(from decoder: Decoder) throws { value = try? WidgetTrade(from: decoder) }
    }

    func trades() throws -> [WidgetTrade] {
        var seen = Set<String>()
        let rows = items.compactMap(\.value).filter { seen.insert($0.id).inserted }
        // A valid empty feed clears the cache.  A broken payload must not erase it.
        guard items.isEmpty || !rows.isEmpty else { throw WidgetFeedError.invalidRows }
        return Array(rows.prefix(5))
    }
}

private enum WidgetFeedError: Error { case invalidResponse, invalidRows }

struct WidgetSnapshot: Codable {
    let fetchedAt: Date
    let trades: [WidgetTrade]
}

private enum WidgetCache {
    // An extension-local cache needs no shared-container registration or login.
    private static var url: URL? {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
            .appendingPathComponent("latest-disclosures-v1.json")
    }

    static func load() -> WidgetSnapshot? {
        guard let url, let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(WidgetSnapshot.self, from: data)
    }

    static func save(_ snapshot: WidgetSnapshot) {
        guard let url, let data = try? JSONEncoder().encode(snapshot) else { return }
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: url, options: .atomic)
    }
}

struct WidgetEntry: TimelineEntry {
    let date: Date
    let snapshot: WidgetSnapshot?
    var refreshFailed = false
    var isPreview = false
    var isPlaceholder = false

    static let feedURL = URL(string: "congresstrade://trades")!
    static let staleAfter: TimeInterval = 60 * 60

    var isStale: Bool {
        guard let snapshot else { return false }
        return date.timeIntervalSince(snapshot.fetchedAt) >= Self.staleAfter
    }
}

struct Provider: TimelineProvider {
    func placeholder(in context: Context) -> WidgetEntry {
        WidgetEntry(date: Date(), snapshot: nil, isPlaceholder: true)
    }

    func getSnapshot(in context: Context, completion: @escaping (WidgetEntry) -> Void) {
        if context.isPreview {
            completion(WidgetExamples.entry)
        } else {
            completion(WidgetEntry(date: Date(), snapshot: WidgetCache.load()))
        }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<WidgetEntry>) -> Void) {
        Task {
            let snapshot: WidgetSnapshot?
            let failed: Bool
            do {
                var request = URLRequest(url: URL(string: "https://congress.trade/api/client/v1/feed?limit=5&order=desc")!)
                request.timeoutInterval = 15
                request.cachePolicy = .reloadIgnoringLocalCacheData
                request.setValue("application/json", forHTTPHeaderField: "Accept")
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                    throw WidgetFeedError.invalidResponse
                }
                let feed = try JSONDecoder().decode(WidgetFeed.self, from: data)
                let fresh = WidgetSnapshot(fetchedAt: Date(), trades: try feed.trades())
                WidgetCache.save(fresh)
                snapshot = fresh
                failed = false
            } catch {
                snapshot = WidgetCache.load()
                failed = true
            }
            let now = Date()
            var entries = [WidgetEntry(date: now, snapshot: snapshot, refreshFailed: failed)]
            if let snapshot {
                let staleDate = snapshot.fetchedAt.addingTimeInterval(WidgetEntry.staleAfter)
                if staleDate > now {
                    entries.append(WidgetEntry(date: staleDate, snapshot: snapshot, refreshFailed: failed))
                }
            }
            // WidgetKit controls the actual refresh time.  The second entry labels
            // aging data even when the system postpones the next network refresh.
            completion(Timeline(entries: entries, policy: .after(now.addingTimeInterval(15 * 60))))
        }
    }
}

private enum WidgetDate {
    // Formatters are hoisted: SwiftUI rebuilds these views per render, and
    // DateFormatter allocation is one of Foundation's costlier paths.
    private static let parser: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.isLenient = false
        return formatter
    }()

    private static let dayDisplay: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        return formatter
    }()

    private static let displayCalendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        // Calendar.timeZone is non-optional; TimeZone(secondsFromGMT:) is not.
        // Same force-unwrap the app's own date helpers use (Models.swift).
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        return calendar
    }()

    static func day(_ raw: String?) -> String {
        guard let raw else { return "—" }
        let text = String(raw.prefix(10))
        guard let date = parser.date(from: text), parser.string(from: date) == text else { return "—" }
        let year = displayCalendar.component(.year, from: date)
        let currentYear = displayCalendar.component(.year, from: Date())
        dayDisplay.dateFormat = year == currentYear ? "MMM d" : "MMM d, yy"
        return dayDisplay.string(from: date)
    }

    private static let refreshDisplay: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US")
        formatter.timeZone = TimeZone(identifier: "America/Chicago")
        return formatter
    }()

    static func refresh(_ date: Date) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = refreshDisplay.timeZone
        refreshDisplay.dateFormat = calendar.isDateInToday(date) ? "h:mm a" : "MMM d, h:mm a"
        return refreshDisplay.string(from: date)
    }
}

private enum TradeDirection {
    case buy, sell, exchange, unknown
    var title: String {
        switch self { case .buy: return "Buy"; case .sell: return "Sell"; case .exchange: return "Exchange"; case .unknown: return "Other" }
    }
    var icon: String {
        switch self { case .buy: return "arrow.up.right"; case .sell: return "arrow.down.right"; case .exchange: return "arrow.left.arrow.right"; case .unknown: return "minus" }
    }
    var color: Color {
        switch self { case .buy: return Self.adaptive(light: UIColor(red: 0.04, green: 0.42, blue: 0.25, alpha: 1), dark: .systemGreen)
        case .sell: return Self.adaptive(light: UIColor(red: 0.75, green: 0.15, blue: 0.17, alpha: 1), dark: .systemRed)
        case .exchange: return .blue
        case .unknown: return .secondary }
    }
    private static func adaptive(light: UIColor, dark: UIColor) -> Color {
        Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? dark : light })
    }
}

private struct DirectionBadge: View {
    let direction: TradeDirection
    var body: some View {
        Label(direction.title, systemImage: direction.icon)
            .font(.system(size: 10, weight: .bold))
            .foregroundStyle(direction.color)
            .padding(.horizontal, 6)
            .padding(.vertical, 3)
            .background(direction.color.opacity(0.12), in: Capsule())
            .fixedSize()
    }
}

struct CongressTradeWidgetEntryView: View {
    @Environment(\.widgetFamily) private var family
    let entry: WidgetEntry
    private let ink = Color(uiColor: .label)
    private let brand = Color.blue

    var body: some View {
        VStack(alignment: .leading, spacing: family == .systemLarge ? 12 : 5) {
            header
            if let trades = entry.snapshot?.trades, !trades.isEmpty {
                if family == .systemSmall {
                    featured(trades[0])
                } else {
                    rows(trades)
                }
            } else {
                emptyState
            }
            footer
        }
        .foregroundStyle(ink)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .containerBackground(for: .widget) {
            Color(uiColor: .systemBackground)
                .overlay(alignment: .top) {
                    Rectangle().fill(brand.opacity(0.8)).frame(height: 3)
                }
        }
        .widgetURL(family == .systemSmall ? entry.snapshot?.trades.first?.deepLink ?? WidgetEntry.feedURL : WidgetEntry.feedURL)
    }

    private var header: some View {
        HStack(spacing: 5) {
            Image(systemName: "building.columns.fill")
                .foregroundStyle(brand)
                .font(.system(size: 12, weight: .semibold))
            Text("Congress.Trade")
                .font(.system(size: family == .systemSmall ? 11 : 13, weight: .bold))
                .lineLimit(1)
            Spacer(minLength: 0)
            if family != .systemSmall {
                Text("Recently Added")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
    }

    private func featured(_ trade: WidgetTrade) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(trade.symbol)
                    .font(.system(size: trade.assetName == nil ? 17 : 22, weight: .bold, design: .rounded))
                    .lineLimit(1)
                    .minimumScaleFactor(0.65)
                Spacer(minLength: 0)
                DirectionBadge(direction: trade.direction)
            }
            Text(trade.memberName)
                .font(.system(size: 12, weight: .medium))
                .lineLimit(1)
            Text(trade.amountText)
                .font(.system(size: 13, weight: .semibold, design: .rounded))
                .lineLimit(1)
                .minimumScaleFactor(0.8)
            VStack(alignment: .leading, spacing: 2) {
                Text("Traded \(WidgetDate.day(trade.transaction?.date))")
                Text(trade.disclosureDateText)
            }
            .font(.system(size: 10))
            .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(trade.accessibleDescription)
        .frame(maxHeight: .infinity, alignment: .center)
    }

    private func rows(_ trades: [WidgetTrade]) -> some View {
        VStack(spacing: family == .systemLarge ? 10 : 6) {
            ForEach(Array(trades.prefix(family == .systemLarge ? 4 : 2).enumerated()), id: \.element.id) { index, trade in
                if index > 0 { Divider() }
                Link(destination: trade.deepLink) {
                    row(trade)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(trade.accessibleDescription)
            }
        }
        .frame(maxHeight: .infinity, alignment: .top)
    }

    private func row(_ trade: WidgetTrade) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 7) {
                Text(trade.symbol)
                    .font(.system(size: family == .systemLarge ? 17 : 15, weight: .bold, design: .rounded))
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                    .layoutPriority(1)
                DirectionBadge(direction: trade.direction)
                Spacer(minLength: 0)
                Text(trade.amountText)
                    .font(.system(size: 11, weight: .semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                    .layoutPriority(1)
            }
            HStack(spacing: 4) {
                Text(trade.memberName)
                    .font(.system(size: 11, weight: .medium))
                    .lineLimit(1)
                if family == .systemLarge, let assetName = trade.assetName {
                    Text("· \(assetName)")
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                if family == .systemMedium {
                    Text(compactFilingDate(trade))
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .fixedSize(horizontal: true, vertical: false)
                }
            }
            if family == .systemLarge {
                Text("Traded \(WidgetDate.day(trade.transaction?.date))  ·  \(trade.disclosureDateText)")
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }

    private func compactFilingDate(_ trade: WidgetTrade) -> String {
        let filed = WidgetDate.day(trade.filing?.filedDate)
        if filed != "—" { return "Filed \(filed)" }
        let added = WidgetDate.day(trade.filing?.firstSeenAt)
        return added == "—" ? "Filed —" : "Added \(added)"
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 6) {
            Image(systemName: entry.refreshFailed ? "wifi.exclamationmark" : "doc.text.magnifyingglass")
                .font(.system(size: 23))
                .foregroundStyle(brand)
            Text(entry.isPlaceholder ? "Latest Disclosures" : entry.refreshFailed ? "Feed Unavailable" : entry.snapshot == nil ? "Loading Disclosures" : "No Disclosures Yet")
                .font(.system(size: 14, weight: .semibold))
            Text(entry.isPlaceholder ? "Fetching public filings" : entry.refreshFailed ? "We’ll try again soon.  Tap to open the feed." : entry.snapshot == nil ? "The public feed will refresh shortly." : "New filings will appear here.")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .lineLimit(3)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }

    private var footer: some View {
        HStack(spacing: 4) {
            if entry.isPreview {
                Text("Sample data · Tap a trade to explore")
            } else if let snapshot = entry.snapshot {
                Image(systemName: entry.refreshFailed || entry.isStale ? "clock.arrow.circlepath" : "arrow.clockwise")
                Text("\(entry.refreshFailed ? "Saved" : entry.isStale ? "Older data" : "Updated") \(WidgetDate.refresh(snapshot.fetchedAt))")
            } else {
                Text(entry.isPlaceholder ? "Public Disclosure Feed" : "Tap to Open Feed")
            }
            Spacer(minLength: 0)
            if family != .systemSmall {
                Image(systemName: "arrow.up.right")
            }
        }
        .font(.system(size: 9, weight: .medium))
        .foregroundStyle(entry.refreshFailed || entry.isStale ? Color.orange : Color.secondary)
        .lineLimit(1)
        .minimumScaleFactor(0.8)
    }
}

// Fictional identities and amounts are restricted to gallery / Xcode previews.
private enum WidgetExamples {
    static var entry: WidgetEntry {
        let data = Data("""
        {"items":[
          {"id":"preview-buy","member":{"name":"Alex Morgan"},"asset":{"ticker":"NVDA","name":"NVIDIA Corporation"},"transaction":{"date":"2026-10-12","type":"B","amountMin":15001,"amountMax":50000},"filing":{"filedDate":"2026-10-18"}},
          {"id":"preview-sell","member":{"name":"Jordan Ellis"},"asset":{"ticker":"MSFT","name":"Microsoft Corporation"},"transaction":{"date":"2026-10-10","type":"S","amountMin":50001,"amountMax":100000},"filing":{"filedDate":"2026-10-18"}},
          {"id":"preview-fund","member":{"name":"Taylor Reed"},"asset":{"name":"Municipal Bond Fund"},"transaction":{"date":"2026-10-09","type":"B","amountMin":1001,"amountMax":15000},"filing":{"filedDate":"2026-10-17"}},
          {"id":"preview-exchange","member":{"name":"Casey Parker"},"asset":{"ticker":"AAPL","name":"Apple Inc."},"transaction":{"date":"2026-10-08","type":"E","amountMin":15001,"amountMax":50000},"filing":{"filedDate":"2026-10-17"}}
        ]}
        """.utf8)
        let trades = (try? JSONDecoder().decode(WidgetFeed.self, from: data).trades()) ?? []
        return WidgetEntry(date: Date(), snapshot: WidgetSnapshot(fetchedAt: Date(), trades: trades), isPreview: true)
    }
}

@main
struct CongressTradeWidget: Widget {
    let kind = "CongressTradeWidget"
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: Provider()) { entry in
            CongressTradeWidgetEntryView(entry: entry)
        }
        .configurationDisplayName("Latest Disclosures")
        .description("See recently added disclosures, who bought or sold, reported amount ranges, and trade and filing dates.  Tap a disclosure for the details.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

#if DEBUG
struct CongressTradeWidget_Previews: PreviewProvider {
    static var previews: some View {
        Group {
            CongressTradeWidgetEntryView(entry: WidgetExamples.entry)
                .previewContext(WidgetPreviewContext(family: .systemSmall))
                .previewDisplayName("Small · Latest Disclosure")
            CongressTradeWidgetEntryView(entry: WidgetExamples.entry)
                .previewContext(WidgetPreviewContext(family: .systemMedium))
                .previewDisplayName("Medium · Latest Two")
            CongressTradeWidgetEntryView(entry: WidgetExamples.entry)
                .previewContext(WidgetPreviewContext(family: .systemLarge))
                .previewDisplayName("Large · Latest Four")
            CongressTradeWidgetEntryView(entry: WidgetEntry(date: Date(), snapshot: nil, refreshFailed: true))
                .previewContext(WidgetPreviewContext(family: .systemSmall))
                .previewDisplayName("Offline · No Cache")
            CongressTradeWidgetEntryView(entry: WidgetEntry(date: Date().addingTimeInterval(7200), snapshot: WidgetExamples.entry.snapshot, refreshFailed: true))
                .previewContext(WidgetPreviewContext(family: .systemMedium))
                .previewDisplayName("Offline · Saved Disclosures")
            CongressTradeWidgetEntryView(entry: WidgetEntry(date: Date(), snapshot: WidgetSnapshot(fetchedAt: Date(), trades: [])))
                .previewContext(WidgetPreviewContext(family: .systemMedium))
                .previewDisplayName("Empty Feed")
        }
    }
}
#endif
