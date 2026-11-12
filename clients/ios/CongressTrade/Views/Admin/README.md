# iOS Admin views

These screens compile from files already in the Xcode target so this PR does not edit `project.pbxproj`:

- `Views/Status/SettingsView.swift` — `AdminPanelView`, `ReviewQueueView`, `ReviewDetailView`
- `Views/Components/Components.swift` — hamburger `Admin` row + `navigationDestination`
- `Models.swift`, `APIClient.swift`, `Store/CongressTradeStore.swift`

Native iOS does not store `ADMIN_TOKEN`.  Admin + Review Queue show only when `GET /auth/me` reports `admin.allowed`.  Admin requests reuse the existing session Bearer.

A Mac/Xcode pass can move the Admin UI types into this folder and add the new files to the `CongressTrade` target.  Do not add duplicates while the types still live in `SettingsView.swift`.
