import SwiftUI

/// Directory tab — mirrors web Directory (`loadPeopleDirectory` /
/// multi-token name/state/party search + column sort).
struct PeopleDirectoryView: View {
    @EnvironmentObject private var store: CongressTradeStore
    @State private var searchText = ""
    @FocusState private var searchFocused: Bool
    @State private var selectedMemberId: String?
    @State private var selectedMemberName: String?
    @State private var sortKey: MemberDirectorySearch.SortKey = .trades
    @State private var sortAscending = false

    private var filteredMembers: [MemberDirectoryEntry] {
        let matched = store.members.filter { MemberDirectorySearch.matches($0, query: searchText) }
        return MemberDirectorySearch.sort(matched, key: sortKey, ascending: sortAscending)
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                VStack(spacing: 10) {
                    PeopleSearchField(text: $searchText, focused: $searchFocused)
                        .accessibilityLabel("Search directory by name, state, or party")

                    HStack {
                        Text("\(filteredMembers.count) of \(store.members.count) shown")
                            .font(.caption.weight(.medium))
                            .foregroundStyle(.secondary)
                        Spacer(minLength: 0)
                    }

                    DirectorySortHeader(
                        sortKey: $sortKey,
                        sortAscending: $sortAscending
                    )
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 8)
                .background(AppTheme.background)

                ScrollView {
                    VStack(spacing: 8) {
                        if let notice = store.membersNotice {
                            FeedFreshnessView(
                                isOffline: false,
                                lastRefresh: nil,
                                notice: notice,
                                onRetry: { Task { await store.loadMembersDirectory(force: true) } }
                            )
                        }

                        if store.isLoadingMembers && store.members.isEmpty {
                            ProgressView("Loading Directory…")
                                .padding(.top, 40)
                        } else if filteredMembers.isEmpty {
                            ContentUnavailableView {
                                Label(
                                    searchText.isEmpty ? "No Politicians Yet" : "No Matches",
                                    systemImage: "person.2"
                                )
                            } description: {
                                Text(
                                    searchText.isEmpty
                                        ? "The directory fills in as filings are ingested."
                                        : "Try a name, state (full or CA), party, or “CA Ro”."
                                )
                            }
                            .padding(.top, 40)
                        } else {
                            LazyVStack(spacing: 8) {
                                ForEach(filteredMembers) { member in
                                    Button {
                                        selectedMemberId = member.filerId
                                        selectedMemberName = member.fullName ?? member.filerId
                                    } label: {
                                        PersonRow(member: member)
                                    }
                                    .buttonStyle(.plain)
                                    .accessibilityHint("Opens politician details")
                                }
                            }
                        }

                        // Legal links close out every tab, so they are inside
                        // the scroll content (below the last row) rather than
                        // pinned — pinning would cost a permanent strip of the
                        // list's height on a screen that is nothing but list.
                        LegalFooterLinks()
                    }
                    .padding(.horizontal, 16)
                    .padding(.bottom, 24)
                }
                .scrollDismissesKeyboard(.interactively)
            }
            .background(AppTheme.background)
            .navigationTitle("Directory")
            .navigationBarTitleDisplayMode(.inline)
            .refreshable { await store.loadMembersDirectory(force: true) }
            .task {
                await store.loadMembersDirectory()
            }
            .sheet(isPresented: Binding<Bool>(
                get: { selectedMemberId != nil },
                set: { if !$0 { selectedMemberId = nil } }
            )) {
                if let memberId = selectedMemberId {
                    PoliticianDetailView(memberId: memberId, memberName: selectedMemberName ?? "Politician")
                        .presentationDetents([.medium, .large])
                        .presentationDragIndicator(.visible)
                        .presentationCornerRadius(18)
                }
            }
        }
    }
}

/// Sticky-style sort controls (mirrors web column headings).
private struct DirectorySortHeader: View {
    @Binding var sortKey: MemberDirectorySearch.SortKey
    @Binding var sortAscending: Bool

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(MemberDirectorySearch.SortKey.allCases) { key in
                    Button {
                        if sortKey == key {
                            sortAscending.toggle()
                        } else {
                            sortKey = key
                            sortAscending = key != .trades
                        }
                    } label: {
                        HStack(spacing: 3) {
                            Text(key.label)
                                .font(.caption.weight(.semibold))
                            if sortKey == key {
                                Image(systemName: sortAscending ? "chevron.up" : "chevron.down")
                                    .font(.system(size: 9, weight: .bold))
                            }
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(
                            sortKey == key
                                ? Color.accentColor.opacity(0.16)
                                : Color(uiColor: .secondarySystemBackground),
                            in: Capsule()
                        )
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Sort by \(key.label)")
                    .accessibilityValue(sortKey == key ? (sortAscending ? "Ascending" : "Descending") : "Off")
                }
            }
        }
    }
}

/// One Directory row: avatar, name + chamber/party-state meta, trade count.
private struct PersonRow: View {
    let member: MemberDirectoryEntry

    var body: some View {
        HStack(spacing: 12) {
            avatar

            VStack(alignment: .leading, spacing: 3) {
                Text(member.fullName ?? member.filerId)
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(.primary)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                Text(metaLine)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Spacer(minLength: 4)

            VStack(alignment: .trailing, spacing: 2) {
                Text(CompactFormat.count(member.txCount))
                    .font(.subheadline.weight(.bold))
                Text("trades")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(AppTheme.borderColor.opacity(0.55), lineWidth: 1)
        )
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(member.fullName ?? member.filerId), \(metaLine), \(member.txCount ?? 0) trades")
    }

    private var metaLine: String {
        var parts: [String] = []
        if let chamber = member.chamber, !chamber.isEmpty {
            parts.append(chamber.chamberLabel)
        }
        var partyStateBits: [String] = []
        if let party = member.party, !party.isEmpty {
            partyStateBits.append(party)
        }
        if let state = member.state, !state.isEmpty {
            let district = CompactFormat.districtOrdinal(member.district)
            partyStateBits.append(district.isEmpty ? state : "\(state) - \(district)")
        }
        if !partyStateBits.isEmpty {
            parts.append(partyStateBits.joined(separator: " · "))
        }
        return parts.isEmpty ? "—" : parts.joined(separator: " · ")
    }

    @ViewBuilder
    private var avatar: some View {
        if let photoUrlString = member.photoUrl, let url = URL(string: photoUrlString) {
            AsyncImage(url: url) { phase in
                switch phase {
                case .success(let image):
                    image.resizable().aspectRatio(contentMode: .fill)
                case .failure:
                    emojiTile
                case .empty:
                    ProgressView()
                @unknown default:
                    emojiTile
                }
            }
            .frame(width: 44, height: 44)
            .clipShape(Circle())
            .overlay(Circle().stroke(AppTheme.borderColor, lineWidth: 1))
        } else {
            emojiTile
        }
    }

    private var emojiTile: some View {
        Text((member.party ?? "").partyEmoji)
            .font(.system(size: 20))
            .frame(width: 44, height: 44)
            .background(Color(uiColor: .secondarySystemBackground), in: Circle())
            .overlay(Circle().stroke(AppTheme.borderColor, lineWidth: 1))
    }
}

private struct PeopleSearchField: View {
    @Binding var text: String
    var focused: FocusState<Bool>.Binding

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)
            TextField("Name, state, party… e.g. CA Ro", text: $text)
                .neverAutocapitalized()
                .autocorrectionDisabled()
                .font(.subheadline)
                .focused(focused)
                .submitLabel(.search)
                .onSubmit { focused.wrappedValue = false }
            if !text.isEmpty {
                Button {
                    withAnimation { text = "" }
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}
