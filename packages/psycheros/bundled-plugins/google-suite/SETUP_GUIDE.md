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
3. Application type: **Desktop app** (not Web application).
4. Name: Psycheros (or whatever).
5. Click **Create**.
6. A dialog appears with your **Client ID** and **Client Secret** — copy both.

> **Note:** Desktop app type automatically allows loopback redirect URIs. You do
> NOT need to manually add redirect URIs.

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
in "Testing" status. Click **Advanced → Go to Psycheros (unsafe)**. This only
appears because you're using your own OAuth client, not a Google-verified app.

**Timezone issues with task due dates:** If tasks appear overdue by one day,
check that your system timezone matches your Google account timezone. The plugin
uses UTC date components for task due dates to avoid midnight-UTC shifting.
