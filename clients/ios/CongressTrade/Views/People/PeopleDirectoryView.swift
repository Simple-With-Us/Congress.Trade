import SwiftUI

/// Directory tab — mirrors web Directory (`loadPeopleDirectory` /
/// multi-token name/state/party search + column sort).
struct PeopleDirectoryView: View {
    @EnvironmentObject private var store: CongressTradeStore
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @AppStorage("ct_disclaimer_expanded") private var disclaimerExpanded = false
    @State private var searchText = ""
    @FocusState private var searchFocused: Bool
    @State private var selectedMember: MemberSheetTarget?
    @State private var sortKey: MemberDirectorySearch.SortKey = .trades
    @State private var sortAscending = false
    /// 0-indexed page of `filteredMembers`. Purely local: `GET /api/members` is
    /// a full-roster endpoint (379 members, ~13.7KB gzipped, 30-minute KV
    /// cache) with no paging parameters, and the whole point of holding it in
    /// memory is instant search and sort. Paging here is only about not
    /// rendering 379 cards at once — it must never become a request.
    @State private var currentPage = 0
    @State private var pageSize = 50
    @State private var directoryMode: DirectoryMode = .politicians

    private enum DirectoryMode: String, CaseIterable {
        case politicians = "Politicians"
        case assets = "Assets"
    }

    private var filteredMembers: [MemberDirectoryEntry] {
        let matched = store.members.filter { MemberDirectorySearch.matches($0, query: searchText) }
        return MemberDirectorySearch.sort(matched, key: sortKey, ascending: sortAscending)
    }

    private func totalPages(for count: Int) -> Int {
        max(1, Int((Double(count) / Double(pageSize)).rounded(.up)))
    }

    /// Takes the already-clamped page rather than re-deriving it, so the rows,
    /// the pager and the page label can never disagree about which page this
    /// is. Clamping matters because search text can shrink the result set under
    /// the current page at any keystroke, and a stale index would render an
    /// empty list that reads as "no matches".
    private func pageSlice(of members: [MemberDirectoryEntry], page: Int) -> ArraySlice<MemberDirectoryEntry> {
        let start = max(0, page) * pageSize
        guard start < members.count else { return members.prefix(pageSize) }
        return members[start..<min(start + pageSize, members.count)]
    }

    var body: some View {
        // Filtering + sorting the whole roster is not free; do it once per
        // render and hand the same array to the count, the pager and the list.
        let members = filteredMembers
        let pages = totalPages(for: members.count)
        let page = min(currentPage, pages - 1)
        return NavigationStack {
            VStack(spacing: 0) {
                if disclaimerExpanded {
                    DisclaimerBanner()
                        .padding(.horizontal, 16)
                        .padding(.top, 6)
                        .padding(.bottom, 4)
                        .transition(.move(edge: .top).combined(with: .opacity))
                }

                Picker("Directory", selection: $directoryMode) {
                    ForEach(DirectoryMode.allCases, id: \.self) { mode in
                        Text(mode.rawValue).tag(mode)
                    }
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 6)

                if directoryMode == .assets {
                    AssetDirectoryView(wrapsNavigation: false)
                } else {
                    peopleDirectoryList(members: members, page: page, pages: pages)
                }
            }
            .animation(.easeInOut(duration: 0.32), value: disclaimerExpanded)
            .background(AppTheme.background)
            .navigationBarTitleDisplayMode(.inline)
            .ctSolidFeedHeader()
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    HeaderIconButton(
                        systemImage: "info.circle",
                        accessibilityLabel: "About Congress.Trade"
                    ) {
                        DisclaimerColdStart.cancelAutoHide()
                        withAnimation(.easeInOut(duration: 0.32)) {
                            disclaimerExpanded.toggle()
                        }
                    }
                }
                ToolbarItem(placement: .principal) {
                    BrandTitle()
                }
                ToolbarItem(placement: .topBarTrailing) {
                    HamburgerMenuButton()
                }
            }
            .refreshable { await store.loadMembersDirectory(force: true) }
            .task {
                await store.loadMembersDirectory()
            }
            .sheet(item: $selectedMember) { target in
                PoliticianDetailView(
                    memberId: target.id,
                    memberName: target.name,
                    seedPhotoUrl: target.photoUrl
                )
                    .presentationDetents([.medium, .large])
                    .presentationDragIndicator(.visible)
                    .presentationCornerRadius(18)
                    .presentationContentInteraction(.resizes)
                    .iPadFullWidthSheet()
            }
            .onChange(of: searchText) { _, _ in currentPage = 0 }
            .onChange(of: sortKey) { _, _ in currentPage = 0 }
            .onChange(of: sortAscending) { _, _ in currentPage = 0 }
        }
    }

    @ViewBuilder
    private func peopleDirectoryList(members: [MemberDirectoryEntry], page: Int, pages: Int) -> some View {
                ScrollView {
                    VStack(spacing: 8) {
                        PeopleSearchField(text: $searchText, focused: $searchFocused)
                            .accessibilityLabel("Search directory by name, state, or party")

                        HStack {
                            // Truthful by construction: the roster endpoint returns
                            // every member, so both numbers are real totals — no
                            // page limit is ever printed here.
                            Text("\(CompactFormat.count(members.count)) of \(CompactFormat.count(store.members.count)) shown")
                                .font(.caption.weight(.medium))
                                .foregroundStyle(.secondary)
                            Spacer(minLength: 0)
                        }

                        directoryPager(page: page, pages: pages)

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
                        } else if members.isEmpty {
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
                        if horizontalSizeClass == .regular {
                            LazyVGrid(columns: [GridItem(.adaptive(minimum: 320, maximum: 540), spacing: 12)], spacing: 12) {
                                ForEach(pageSlice(of: members, page: page)) { member in
                                    Button {
                                        selectedMember = MemberSheetTarget(
                                            id: member.filerId,
                                            name: member.fullName ?? member.filerId,
                                            photoUrl: member.photoUrl
                                        )
                                    } label: {
                                        PersonRow(member: member)
                                    }
                                    .buttonStyle(.plain)
                                    .accessibilityHint("Opens politician details")
                                }
                            }
                        } else {
                            LazyVStack(spacing: 8) {
                                ForEach(pageSlice(of: members, page: page)) { member in
                                    Button {
                                        selectedMember = MemberSheetTarget(
                                            id: member.filerId,
                                            name: member.fullName ?? member.filerId,
                                            photoUrl: member.photoUrl
                                        )
                                    } label: {
                                        PersonRow(member: member)
                                    }
                                    .buttonStyle(.plain)
                                    .accessibilityHint("Opens politician details")
                                }
                            }
                        }

                            directoryPager(page: page, pages: pages)
                                .padding(.top, 4)
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 8)
                    .padding(.bottom, 24)
                }
                .scrollDismissesKeyboard(.interactively)
    }

    private func directoryPager(page: Int, pages: Int) -> some View {
        PaginationBar(
            currentPage: page,
            totalPages: pages,
            pageSize: pageSize,
            canGoPrevious: page > 0,
            canGoNext: page + 1 < pages,
            onPrevious: { currentPage = max(0, page - 1) },
            onNext: { currentPage = min(pages - 1, page + 1) },
            onPageSize: { size in
                pageSize = size
                currentPage = 0
            },
            sortControls: AnyView(
                SortMenuControl(
                    keys: Array(MemberDirectorySearch.SortKey.allCases),
                    sortKey: $sortKey,
                    sortAscending: $sortAscending,
                    label: { $0.label },
                    defaultAscending: { $0 != .trades }
                )
            )
        )
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
            parts.append(chamber.chamberLabel(title: member.title))
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

    private var avatar: some View {
        MemberAvatar(
            photoURL: MemberPhotoURL.resolve(member.photoUrl),
            name: member.fullName ?? member.filerId,
            size: 44
        )
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
        .background(AppTheme.card, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}
