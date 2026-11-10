import SwiftUI

/// Hand off from a member/ticker drawer to the Trades tab with the same filter
/// the web dashboard uses (`fq` / server memberName or ticker params).
struct SeeAllTradesHandoff: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var tabRouter: TabRouter
    @EnvironmentObject private var store: CongressTradeStore

    let totalTrades: Int
    let displayedCount: Int
    let filter: Filter

    enum Filter {
        case politician(String)
        case ticker(String)
    }

    var body: some View {
        if totalTrades > displayedCount {
            Button {
                dismiss()
                tabRouter.selection = .trades
                Task {
                    switch filter {
                    case .politician(let name):
                        await store.setPoliticianFilter(name)
                    case .ticker(let symbol):
                        await store.setAssetFilter(symbol)
                    }
                }
            } label: {
                Text("See all \(CompactFormat.count(totalTrades)) trades →")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.accentColor)
            }
            .buttonStyle(.plain)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16)
            .padding(.top, 4)
            .accessibilityLabel("See all \(totalTrades) trades in the Trades tab")
        }
    }
}
