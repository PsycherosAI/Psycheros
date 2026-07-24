# Google Suite Plugin — Manual Verification Checklist

Walk through this end-to-end before shipping. Estimated time: 45–60 minutes
(includes creating a Google Cloud OAuth client + testing each tool).

You'll need:

- A Google account (any will do — personal Gmail works)
- This Psycheros branch checked out and running
- A terminal to start the daemon

---

## Part 1 — Google Cloud OAuth Client Setup (one-time, external to Psycheros)

Google requires each user to create their own OAuth client. This avoids the
verification treadmill for sensitive scopes. ~5 minutes.

1. Open the [Google Cloud Console](https://console.cloud.google.com/).
2. Create or select a project (any name).
3. **Configure the OAuth consent screen:**
   - APIs & Services → OAuth consent screen
   - User type: **External** (Personal Google accounts can't use Internal)
   - App name: `Psycheros` (or whatever you want — only you will see it)
   - Support email: your email
   - Developer contact: your email
   - Skip "Authorized domains" (not needed for Desktop app)
   - Add the scopes you plan to test:
     - `.../auth/calendar`
     - `.../auth/gmail.modify` (if testing Gmail)
     - `.../auth/drive.file` (if testing Drive)
     - `.../auth/contacts` (if testing Contacts)
     - `.../auth/userinfo.email` (always)
   - Add yourself as a Test User (required while app is in "Testing" status)

4. **Create the OAuth Client ID:**
   - APIs & Services → Credentials → Create Credentials → OAuth client ID
   - Application type: **Desktop app**
   - Name: `Psycheros Local`
   - **Authorized redirect URIs** — add all 21:
     ```
     http://127.0.0.1:8765/callback
     http://127.0.0.1:8766/callback
     http://127.0.0.1:8767/callback
     ... (through 8785)
     ```
     (The plugin's settings UI has a copy-paste list under "Show redirect
     URIs".)
   - Click Create. Copy the **Client ID** and **Client Secret**.

---

## Part 2 — First-time Plugin Discovery

Goal: confirm the bundled plugin shows up correctly in Plugins Settings.

- [ ] Start the daemon: `cd packages/psycheros && deno task dev`
- [ ] Open the web UI: http://localhost:3000
- [ ] Navigate to Settings → Plugins
- [ ] **Verify:** "Google Suite" row appears with:
  - "Built-in" badge (left of the name)
  - "Disabled" status badge
  - "Configure" button present
  - **No** "Remove" button (built-ins can't be uninstalled)
  - **No** "Check for updates" button (bundled — no remote update path)

---

## Part 3 — Credentials + OAuth Flow

Goal: connect a Google account via OAuth.

- [ ] Click "Configure" on the Google Suite row
- [ ] **Verify:** settings page loads with four sections:
  - Google Cloud OAuth Client
  - Connection
  - Services
  - Calendar Label
- [ ] In "Google Cloud OAuth Client":
  - Click "Show redirect URIs" — verify 21 URLs appear (ports 8765–8785)
  - Paste your Client ID → click into Client Secret field → paste secret
  - Click "Save credentials"
  - **Verify:** "Client ID saved. Client secret saved." message appears
  - **Verify:** Both fields show "Status: **set**" in green

- [ ] In "Connection":
  - Click "Connect Account"
  - **Verify:** "Opened your browser to Google..." message appears
  - **Verify:** Browser opens to `accounts.google.com` consent screen
  - On the consent screen:
    - **Verify:** The scopes listed match what you enabled (Calendar, possibly
      Gmail/Drive/Contacts)
    - **Verify:** The redirect URL bar shows
      `http://127.0.0.1:<port>/callback?...`
  - Click "Allow" on the consent screen
  - **Verify:** Browser shows a "Connected" page with a green checkmark
  - Return to Psycheros settings — within 2 seconds the page should auto-refresh
  - **Verify:** Connection section now shows "Connected as
    **your-email@gmail.com**"
  - **Verify:** Granted scopes appear in a collapsible details element

- [ ] **Filesystem verification:**
  - Check `<dataRoot>/.psycheros/plugin-secrets/google-suite.env` — should
    contain:
    ```
    PSYCHEROS_PLUGIN_GOOGLE_SUITE_CLIENT_ID=...
    PSYCHEROS_PLUGIN_GOOGLE_SUITE_CLIENT_SECRET=...
    PSYCHEROS_PLUGIN_GOOGLE_SUITE_REFRESH_TOKEN=...
    ```
  - Check `<dataRoot>/.psycheros/plugin-state/google-suite/config.json` — should
    contain:
    ```json
    {
      "services": {
        "calendar": true,
        "gmail": false,
        "drive": false,
        "contacts": false
      },
      "calendarLabel": "{userName}'s calendar",
      "grantedScopes": ["https://www.googleapis.com/auth/calendar", "..."],
      "connectedEmail": "your-email@gmail.com"
    }
    ```

---

## Part 4 — Enable the Plugin

- [ ] Return to Settings → Plugins
- [ ] Click the enable toggle on the Google Suite row (if there is one — depends
      on existing UI)
  - Or: manually set `"enabled": true` in
    `<dataRoot>/.psycheros/plugin-state/google-suite/config.json` if needed
- [ ] Restart Psycheros: `Ctrl+C` then `deno task dev` again
- [ ] **Verify:** Plugin row now shows "Loaded" status badge
- [ ] **Verify:** Capabilities line shows `tools: 4, promptHooks: 1, routes: 7`
      (Calendar-only after first OAuth; Gmail/Drive/Contacts toggles are off)

---

## Part 5 — Calendar Tools (default-enabled)

Goal: exercise all four Calendar tools + today_schedule hook.

- [ ] **today_schedule hook:**
  - Add at least one event to your Google Calendar for today (any time later
    than now)
  - Open Context Inspector (Settings → Context Inspector, or via the chat
    overlay)
  - Send a message in chat like "hi"
  - **Verify:** Context Inspector **Plugins tab** shows a `today-schedule` card
    with status badge `fired`, non-zero chars used, and expandable output
  - **Verify:** The injected block lists your event with time + summary. Format
    is `${calendarLabel}:` (no date — entity already has today's date from
    situational awareness)
  - **Verify:** `calendarLabel` substitutes `{userName}` from General Settings
    (default label is `"{userName}'s calendar"`)

- [ ] **list_calendar_events:**
  - In chat, ask: "What's on my schedule this week?"
  - **Verify:** Entity calls `list_calendar_events` tool
  - **Verify:** Response lists your upcoming events with title, time, location,
    attendees
  - **Verify:** Meet link indicator (`[Meet]`) appears on events with Google
    Meet

- [ ] **create_calendar_event:**
  - In chat, ask: "Schedule a meeting with Alice tomorrow at 2pm called 'Sync'"
  - **Verify:** Entity calls `create_calendar_event` with appropriate args
  - **Verify:** Response confirms creation with event ID + HTML link
  - **Verify:** Event appears in Google Calendar web UI

- [ ] **update_calendar_event:**
  - In chat, ask: "Move that Sync meeting to 3pm"
  - **Verify:** Entity calls `update_calendar_event` with the event ID from
    prior step + new start time
  - **Verify:** Event's time updates in Google Calendar

- [ ] **delete_calendar_event:**
  - In chat, ask: "Cancel tomorrow's Sync meeting"
  - **Verify:** Entity calls `delete_calendar_event`
  - **Verify:** Event disappears from Google Calendar
  - **Verify:** Entity doesn't blindly delete — it should ideally confirm before
    destructive actions

---

## Part 6 — Service Toggling + Re-OAuth

Goal: verify enabling a new service triggers re-OAuth.

- [ ] In Google Suite settings → Services section, toggle **Gmail** on
- [ ] Click any Save button on the services form
- [ ] **Verify:** "Re-connect required" banner appears in Connection section
- [ ] Click "Connect Account" again
- [ ] **Verify:** Google consent screen now lists BOTH Calendar AND Gmail scopes
- [ ] Approve → return to Psycheros
- [ ] Restart Psycheros
- [ ] **Verify:** Capabilities line shows `tools: 9, promptHooks: 1` (4
      calendar + 5 gmail)
- [ ] **Verify:** Gmail tools work — ask "any unread emails from Alice?" →
      `list_gmail_messages`

---

## Part 7 — Each Additional Service

Repeat a basic read test for each service you enabled:

- [ ] **Drive** (after enabling + re-OAuth):
  - "What files have I created through you?" → `list_drive_files` (likely empty
    initially)
  - "Save my notes from this conversation as a markdown file" →
    `create_drive_file`
  - "Show me what's in that file" → `read_drive_file`

- [ ] **Contacts** (after enabling + re-OAuth):
  - "What's Alice's phone number?" → `list_contacts` then `read_contact` if
    needed
  - "Add Bob as a contact with bob@example.com" → `create_contact`

---

## Part 8 — Disconnect + Reconnect

Goal: confirm disconnect clears tokens but preserves client ID/secret.

- [ ] In Connection section, click "Disconnect"
- [ ] **Verify:** Confirm dialog appears
- [ ] Confirm
- [ ] **Verify:** Section shows "Not connected" again
- [ ] **Filesystem:** `<dataRoot>/.psycheros/plugin-secrets/google-suite.env`
      should have NO refresh_token line; client_id + client_secret should still
      be there
- [ ] **Verify:** Calling a calendar tool now returns clear "not connected"
      error
- [ ] Click "Connect Account" — should work in one click (no need to re-enter
      creds)
- [ ] **Verify:** Flow completes, "Connected as" returns

---

## Part 9 — Failure Modes

Goal: confirm graceful degradation under adverse conditions.

- [ ] **Revoke access manually:**
  - Visit https://myaccount.google.com/permissions
  - Find "Psycheros" (or whatever you named the OAuth client)
  - Click "Remove access"
  - In Psycheros chat, ask "what's on my calendar today?"
  - **Verify:** Entity's tool call returns a clear auth error mentioning the
    revoked token, not a raw stack trace

- [ ] **Stop daemon mid-OAuth flow:**
  - Start "Connect Account"
  - While the consent screen is open in browser, `Ctrl+C` the daemon
  - **Verify:** No zombie listener port (check via `lsof -i :8765` on
    macOS/Linux)
  - **Verify:** Browser tab eventually shows "Connection failed" (can't reach
    callback)

- [ ] **All listener ports occupied (hard to reproduce):**
  - Run 21 dummy listeners on ports 8765–8785
  - Try to connect
  - **Verify:** Settings UI shows clear error about ports being unavailable

- [ ] **Wrong client ID/secret:**
  - Edit `.psycheros/plugin-secrets/google-suite.env`, scramble the
    client_secret
  - Restart, try to connect
  - **Verify:** Consent screen errors with "redirect_uri_mismatch" or similar
  - **Verify:** Listener times out after 5 minutes with clear message

---

## Part 10 — Final Cleanup

- [ ] Disable the plugin in Plugins Settings
- [ ] Restart Psycheros
- [ ] **Verify:** Tools don't appear in Settings → Tools (plugin disabled → no
      tool registration)
- [ ] **Verify:** today_schedule hook doesn't fire (no Plugin Context in Context
      Inspector)
- [ ] **Verify:** Settings still editable (Configure button still works while
      disabled)

---

## Known Gaps / Expected Behavior

These are NOT bugs — they're documented limitations:

- **HTML-only Gmail emails** return no body text. Most senders include
  text/plain alongside HTML so this is rare. If you see it, the
  read_gmail_message result will say "(no text/plain body — this email is
  HTML-only)".

- **`drive.file` scope** means the entity only sees files this app created — NOT
  your entire Drive. The list_drive_files description tells the entity this. If
  you want full Drive access, you'd need to swap to the sensitive `drive`
  scope + go through Google verification.

- **Slides files** can't be read inline (binary export formats only).
  read_drive_file returns metadata + a note pointing to the webViewLink.

- **Files >5 MB** return metadata only — content is omitted to avoid blowing
  entity context.

- **`drive.file` empty initially** — the entity creates its first file via
  `create_drive_file`, then list_drive_files will return it.

- **Drive update with both metadata + content** makes two PATCH calls (Drive
  doesn't support atomic update of both). Slightly slower but functionally
  equivalent.

- **Contacts deletion is permanent** (no trash, unlike Gmail/Drive). The tool
  description warns the entity to confirm with the user.

- **Contacts update is REPLACE not MERGE** for array fields (emails, phones).
  The tool description tells the entity to read-then-append to preserve existing
  entries.

- **`{userName}` substitution** depends on `general-settings.json` having a
  `userName` field. Default is "You". If you see "the user's calendar" in hook
  output, your general settings userName isn't populated yet.

---

## Reporting Issues

If something fails:

1. Check `<dataRoot>/.psycheros/plugin-logs/google-suite.log` — lifecycle
   events + errors land here.
2. Check the daemon's stdout for `[google-suite]` prefixed warnings.
3. File an issue with:
   - The failing step from this checklist
   - Relevant log snippet
   - Whether it's reproducible
