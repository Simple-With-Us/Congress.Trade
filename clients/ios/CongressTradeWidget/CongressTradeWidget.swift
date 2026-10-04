import WidgetKit
import SwiftUI

struct Provider: TimelineProvider {
    func placeholder(in context: Context) -> SimpleEntry {
        SimpleEntry(date: Date(), tradeCount: 5)
    }

    func getSnapshot(in context: Context, completion: @escaping (SimpleEntry) -> ()) {
        let entry = SimpleEntry(date: Date(), tradeCount: 5)
        completion(entry)
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<Entry>) -> ()) {
        var entries: [SimpleEntry] = []
        let currentDate = Date()
        
        let entry = SimpleEntry(date: currentDate, tradeCount: Int.random(in: 1...10))
        entries.append(entry)

        let timeline = Timeline(entries: entries, policy: .atEnd)
        completion(timeline)
    }
}

struct SimpleEntry: TimelineEntry {
    let date: Date
    let tradeCount: Int
}

struct CongressTradeWidgetEntryView : View {
    var entry: Provider.Entry

    var body: some View {
        VStack {
            Text("Congress.Trade")
                .font(.headline)
            Text("\(entry.tradeCount) new trades")
                .font(.subheadline)
        }
        // containerBackground is required for iOS 17+ widgets
        .containerBackground(for: .widget) {
            Color(uiColor: .systemBackground)
        }
    }
}

@main
struct CongressTradeWidget: Widget {
    let kind: String = "CongressTradeWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: Provider()) { entry in
            CongressTradeWidgetEntryView(entry: entry)
        }
        .configurationDisplayName("Latest Trades")
        .description("View the latest trades from Congress.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}
