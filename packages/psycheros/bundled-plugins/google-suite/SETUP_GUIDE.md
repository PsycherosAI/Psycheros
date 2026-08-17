# Google Suite Plugin — Setup Guide for Users

This guide walks you through connecting your Google account to Psycheros so the
entity can see your calendar, manage your email, create files in Drive, manage
contacts, track tasks, and read fitness data.

**Time estimate:** 15–20 minutes (most of it is Google Cloud Console setup).

---

## What the entity gets

Once connected, the entity has six Google services available (each toggleable):

| Service      | What it does                                                                                  | Scope          |
| ------------ | --------------------------------------------------------------------------------------------- | -------------- |
| **Calendar** | See upcoming events, create/update/delete them. Ambient awareness of your schedule each turn. | `calendar`     |
| **Gmail**    | Search, read, send, and label email. No ambient hook (privacy).                               | `gmail.modify` |
| **Drive**    | Create, read, update, delete files. Only sees files this app created (privacy-friendly).      | `drive.file`   |
| **Contacts** | List, read, create, update, delete contacts.                                                  | `contacts`     |
| **Tasks**    | Manage your task list. Ambient awareness of pending tasks each turn.                          | `tasks`        |
| **Fit**      | Read steps, heart rate, sleep, activity from Google Fit. Ambient health snapshot each turn.   | 4 read scopes  |

---

## Step 1: Google Cloud Project + OAuth Consent Screen

1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Click the project dropdown (top bar) → **New Project** → name it whatever →
   Create.
3. Navigate to **APIs & Services → OAuth consent screen**.
4. Set User type to **External** → Create.
5. Fill in:
   - **App name:** Psycheros (or whatever you like — only you see this)
   - **User support email:** your email
   - **Developer contact information:** your email
6. Click **Save and Continue** through the scopes screen (we'll add scopes
   next).
7. Under **Test users**, click **Add Users** → add your own Google account
   email. This is required while the app is in "Testing" status.

> **Publish the app once setup works — don't stay in "Testing".** Google
> **expires the refresh token after 7 days** while the consent screen is in
> "Testing" status, so the plugin silently disconnects and needs re-connecting
> every week. After verifying the connection works, go to **APIs & Services →
> OAuth consent screen → Publish app** to move it to "In production". The "app
> isn't verified" warning still appears (see Troubleshooting) but is safe to
> click through, and refresh tokens then last indefinitely.

## Step 2: Add OAuth Scopes

On the consent screen, under **Data access** or **Scopes**:

Click **Add or Remove Scopes** and add these URLs (search or paste):

```
https://www.googleapis.com/auth/userinfo.email
https://www.googleapis.com/auth/calendar
https://www.googleapis.com/auth/gmail.modify
https://www.googleapis.com/auth/drive.file
https://www.googleapis.com/auth/contacts
https://www.googleapis.com/auth/tasks
https://www.googleapis.com/auth/fitness.activity.read
https://www.googleapis.com/auth/fitness.heart_rate.read
https://www.googleapis.com/auth/fitness.sleep.read
https://www.googleapis.com/auth/fitness.body.read
```

You don't have to add all of them — just the ones for services you want. At
minimum, add `userinfo.email` + `calendar`.

## Step 3: Enable APIs

Go to **APIs & Services → Library** and click **Enable** on each API you want:

- [Google Calendar API](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com)
- [Gmail API](https://console.cloud.google.com/apis/library/gmail.googleapis.com)
- [Google Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com)
- [Google People API](https://console.cloud.google.com/apis/library/people.googleapis.com)
  (for Contacts)
- [Google Tasks API](https://console.cloud.google.com/apis/library/tasks.googleapis.com)
- [Google Fitness API](https://console.cloud.google.com/apis/library/fitness.googleapis.com)

**This step is critical** — adding scopes without enabling the underlying APIs
results in 403 errors. Each link above goes directly to the enable page.

## Step 4: Create OAuth Client ID

1. Go to **APIs & Services → Credentials**.
2. Click **Create Credentials → OAuth client ID**.
3. Application type: **Web application**.
4. Name: Psycheros (or whatever).
5. Under **Authorized redirect URIs**, click **Add URI** and paste:

   ```
   https://YOUR-PSYCHEROS-URL/api/plugins/google-suite/oauth-callback
   ```

   Replace `YOUR-PSYCHEROS-URL` with the URL you use to access this Psycheros
   instance (e.g. `http://192.168.1.100:3000` or `https://echo.example.com`).

6. Click **Create**.
7. A dialog appears with your **Client ID** and **Client Secret** — copy both.

> **Why Web application?** Psycheros runs as a server — the OAuth callback comes
> back through Psycheros's own web server, not a local desktop app. If you
> previously created a Desktop app client, create a new Web app client instead.

## Step 5: Connect in Psycheros

1. Open Psycheros → **Settings → Plugins**.
2. Find **Google Suite** (has a "Bundled" badge).
3. Click **Configure**.
4. Paste your **Client ID** and **Client Secret** → click **Save credentials**.
5. Toggle on the services you want (Calendar, Gmail, Drive, etc.).
6. Click **Connect Account**.
7. Your browser opens to Google's consent screen → approve.
8. The settings page auto-refreshes showing **Connected as
   your-email@gmail.com**.

## Step 6: Restart Psycheros

The plugin needs a restart to register its tools and hooks. Restart the daemon.

## Step 7: Verify

After restart, check the Plugins page — Google Suite should show:

- Status: **Loaded**
- Tools: 6 (one per enabled service)
- Hooks: 1–3 (calendar schedule, pending tasks, fitness snapshot)

Send a message to the entity like "What's on my calendar today?" — it should
respond with your actual events.

---

## Configuration Options

In the Configure page:

| Setting                   | Default            | Description                                                                                           |
| ------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------- |
| Calendar label            | "Today's schedule" | How the entity refers to your calendar in its context. Free-form — use `{userName}` as a placeholder. |
| Calendar lookahead (days) | 1                  | How many days of upcoming events the entity sees. Set to 7 for a week-ahead view.                     |
| Pending tasks cap         | 5                  | Maximum pending tasks shown in ambient context.                                                       |

## Troubleshooting

**"API not enabled" error in settings:** You missed Step 3. Each service needs
its underlying API enabled in the Google Cloud Console. The settings page shows
direct links to enable each one.

**403 "accessNotConfigured":** Same as above — the API is enabled but hasn't
propagated yet. Wait 2–3 minutes and restart.

**Entity doesn't see calendar/tasks in context:** Check Context Inspector →
Plugin Context section. If empty, the hook cache may not have refreshed yet
(5-minute interval). Restart to trigger an immediate refresh.

**OAuth consent screen says "This app isn't verified":** This is normal for apps
in "Testing" status (and for published apps with sensitive scopes that haven't
gone through Google's verification process). Click **Advanced → Go to Psycheros
(unsafe)**. This only appears because you're using your own OAuth client, not a
Google-verified app.

**Connection stops working after about a week:** The consent screen is still in
"Testing" status — Google expires refresh tokens after 7 days for testing apps.
Publish the app (see the note in Step 1), then click **Connect Account** once
more to mint a fresh token. Published-app refresh tokens persist indefinitely
(Google only invalidates them after ~6 months of non-use).

**Timezone issues with task due dates:** If tasks appear overdue by one day,
check that your system timezone matches your Google account timezone. The plugin
uses UTC date components for task due dates to avoid midnight-UTC shifting.
