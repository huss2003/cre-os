# Connecting Microsoft 365 and Google (read-only) — click-by-click

CRE OS reads mail and calendar. It **never** sends email, changes calendars or deletes anything, and asks only for
read scopes. Until the steps below are done, **Settings → Connections** offers **Use mock data**, which loads clearly
labelled sample emails and meetings.

Before you start, set these server environment variables. Locally they go in `.env.local`; in production use Vercel →
Project → Settings → Environment Variables:

| Variable | Value |
|---|---|
| `APP_URL` | The public address of the app, e.g. `https://cre-os.example.com`. Use `http://localhost:3000` locally. No trailing slash. |
| `TOKEN_ENCRYPTION_KEY` | 32 random bytes, base64. Generate with `openssl rand -base64 32`. Keep it stable: changing it disconnects everyone. |

The redirect (callback) addresses are:
- Microsoft: `<APP_URL>/api/oauth/microsoft/callback`
- Google: `<APP_URL>/api/oauth/google/callback`

---

## A. Microsoft 365 (Entra ID app registration)

1. Go to <https://entra.microsoft.com> and sign in as an administrator of your Microsoft 365 tenant.
2. In the left menu click **Identity → Applications → App registrations**, then **+ New registration**.
3. Fill in the form:
   - **Name:** `CRE OS`
   - **Supported account types:** choose **Accounts in this organizational directory only** for a single company. Choose
     **Accounts in any organizational directory (Multitenant)** if several client companies will connect.
   - **Redirect URI:** platform **Web**, value `<APP_URL>/api/oauth/microsoft/callback`
   - Click **Register**.
4. On the app's **Overview** page, copy:
   - **Application (client) ID** → `MICROSOFT_CLIENT_ID`
   - **Directory (tenant) ID** → `MICROSOFT_TENANT_ID`. Single-tenant only; leave it unset for multitenant, and the app then uses `common`.
5. Click **Certificates & secrets → Client secrets → + New client secret**. Set a description of `CRE OS` and an expiry of 12 or 24 months,
   then click **Add**. Copy the **Value** right away; it is shown only once. Put it in `MICROSOFT_CLIENT_SECRET`.
   Add a calendar reminder to rotate it before it expires.
6. Click **API permissions → + Add a permission → Microsoft Graph → Delegated permissions**. Tick exactly these:
   - `User.Read`
   - `offline_access`
   - `Mail.Read`
   - `Calendars.Read`
   - (optional, only if you will set `MICROSOFT_ENABLE_SELECTED_FILES=1`) `Files.SelectedOperations.Selected`

   Click **Add permissions**. Do **not** add `Mail.Send`, `Mail.ReadWrite` or `Calendars.ReadWrite`. The app refuses to
   start a sign-in if they are requested.
7. Still on **API permissions**, click **Grant admin consent for <your organisation>** → **Yes**. Without this, users
   whose tenant blocks user consent see "Need admin approval".
8. Restart the app with the new variables. Then go to **Settings → Connections → Microsoft 365 → Connect**, sign in, and accept.
   The card shows **Connected**, and the first sync appears within a minute or two. **Sync now** runs it immediately.

**Troubleshooting:**
- `AADSTS50011` (redirect mismatch): the redirect URI must match `APP_URL` exactly, including http/https and the port.
- `AADSTS65001` / "consent revoked" on the card: an admin removed consent. Repeat step 7, then press **Reconnect**.
- The status shows **Expired — reconnect**: the refresh token expired because of a password change or a sign-in policy. Press **Reconnect**.

---

## B. Google (Gmail + Calendar, read-only)

> **Start with manual import.** The recommended first step for Gmail is **Drafts → Inbox triage → Import one email**. Use
> Gmail's ⋮ menu → **Download message** to get a `.eml` file, or use **Show original** and paste the text. That reads only the
> threads you choose and needs no Google verification.
>
> **Restricted-scope caveat:** `gmail.readonly` is a Google **restricted** scope. While the OAuth app is in *Testing*, only
> listed test users (max 100) can connect, and their tokens expire after 7 days. To let other users connect with
> long-lived tokens, the app must pass Google's **OAuth app verification plus an annual third-party security
> assessment (CASA)**. That takes weeks and has a cost. A Google Workspace admin can avoid this for their own domain by
> making the app **Internal**, or by trusting it in the Admin console (Security → API controls → App access control).

1. Go to <https://console.cloud.google.com>, then use the project picker at the top to choose **New project**. Name it `CRE OS` and click **Create**.
2. Click **APIs & Services → Library**. Search for **Gmail API** and click **Enable**. Search for **Google Calendar API** and click **Enable**.
3. Click **APIs & Services → OAuth consent screen**. This is "Google Auth Platform → Branding / Audience" in the newer console.
   - **User type:** pick **Internal** if every user is in your Google Workspace domain. Otherwise pick **External**.
   - App name `CRE OS`, support email, and developer contact email → **Save and continue**.
   - **Scopes → Add or remove scopes:** add `openid`, `.../auth/userinfo.email`,
     `https://www.googleapis.com/auth/gmail.readonly` and `https://www.googleapis.com/auth/calendar.readonly`. Do not add
     `gmail.send`, `gmail.modify`, `gmail.compose`, `https://mail.google.com/` or the full `calendar` scope.
   - **Test users** (External + Testing only): add the Gmail addresses that will connect.
4. Click **APIs & Services → Credentials → + Create credentials → OAuth client ID**.
   - **Application type:** Web application. **Name:** `CRE OS web`.
   - **Authorised redirect URIs → + Add URI:** `<APP_URL>/api/oauth/google/callback`
   - Click **Create**. Copy the **Client ID** into `GOOGLE_CLIENT_ID` and the **Client secret** into `GOOGLE_CLIENT_SECRET`.
5. Restart the app. Then go to **Settings → Connections → Google → Connect**, choose the account, and allow access.
6. For production with External users, open **OAuth consent screen → Publish app**, then submit for verification. Follow
   Google's restricted-scope process: privacy policy URL, demo video and security assessment. Until it is approved, keep using manual import.

**Troubleshooting:**
- `redirect_uri_mismatch`: the URI in step 4 must match `APP_URL` exactly.
- `access_denied`: the user is not a test user (Testing mode), or a Workspace admin blocked the app.
- The status shows **Access revoked — reconnect**: the user removed access at <https://myaccount.google.com/permissions>, or the 7-day testing token expired.

---

## What the app stores
- Tokens are AES-256-GCM encrypted with `TOKEN_ENCRYPTION_KEY`. App users cannot read them; the column is not granted, and they never reach the browser.
- From mail: sender, recipients, subject, a sanitised plain-text excerpt (max 4,000 characters, active content removed),
  and attachment names and sizes only.
- From calendar: title, time, location, attendees, and cancellation or reschedule status.
- **Disconnect** deletes the tokens and sync state, and revokes the Google grant on a best-effort basis. Records that were already imported, such as interactions and
  drafts, stay until you delete them.
