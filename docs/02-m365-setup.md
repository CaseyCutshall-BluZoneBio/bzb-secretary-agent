# 1 · Microsoft 365 setup

**Result:** a shared mailbox for Sarah, and an app that can mail as Sarah and use Vic's calendar, and nothing else in the tenant.

You need Global Admin (or Application Admin + Exchange Admin). Allow about an hour, most of it waiting for Exchange to apply the scoping.

## 0. One question for Vic first

With a shared mailbox, **the calendar invite comes from Vic's calendar**. All the back-and-forth email still comes from Sarah. This is how a human assistant with delegate access works, and it's the design here.

Confirm with Vic that "never send from my address" means correspondence, not the invite. If he wants the invite to come from Sarah too, stop: that needs a Teams application access policy and a different booking path (see `docs/08-decisions.md`, D2).

## 1. App registration (Entra admin center)

1. **Entra ID → App registrations → New registration**
   - Name: `BZB Scheduling Agent`
   - Supported account types: *this organizational directory only*
   - No redirect URI
2. **Certificates & secrets → New client secret**, with a 12-month expiry. Copy the **Value** now; it's shown once. Put the expiry date on your calendar (rotation: `docs/07-runbook.md`).
3. **API permissions:** remove the default `User.Read`. **Grant nothing.**
   > Any Mail or Calendar *application* permission added here applies to every mailbox in the tenant, and overrides the Exchange scoping in step 3. The list must stay empty.
4. Write down:
   - **Tenant ID** and **Application (client) ID**, from the app's Overview
   - **Object ID**, from **Enterprise applications** → `BZB Scheduling Agent` → Overview. This is a different GUID from anything on the app registration page.

## 2. Shared mailbox (GUI or script)

Either:
- **M365 admin center → Teams & groups → Shared mailboxes → Add**
  - Name `Sarah Johnson (AI Scheduling Assistant)`
  - Email `sarah.johnson@bluzonebio.com`

or let the script create it (step 3).

Then **Users → Active users → Sarah Johnson → Block sign-in.** Nothing should ever log in as Sarah.

## 3. Scope the app to Sarah's mail + Vic's calendar (Cloud Shell)

Entra can't limit an app to specific mailboxes; only Exchange's *RBAC for Applications* can, and it's configured in PowerShell. You don't need to install anything:

1. Open **portal.azure.com → Cloud Shell → PowerShell**.
2. Upload `m365/exchange-setup.ps1` with the upload button, or paste it in.
3. Fill in the five variables at the top and run it. If you created the mailbox in the GUI, skip the `New-Mailbox` line.

The script:

| Step | Effect |
|---|---|
| `New-Mailbox -Shared` | Sarah's mailbox, display name with the AI disclosure |
| `Set-CalendarProcessing -AutomateProcessing None` | Sarah's calendar never auto-responds |
| `Add-MailboxPermission … FullAccess` | You can open Sarah's mailbox (Drafts/Sent) during review. No Send As for anyone |
| `CustomAttribute10 = SchedAgentMail` on Sarah<br>`CustomAttribute11 = SchedAgentCal` on Vic | Two different tags, so the two scopes can be different |
| `New-ServicePrincipal` | Registers the app in Exchange |
| Two `New-ManagementScope` + three role assignments | `Mail.ReadWrite` + `Mail.Send` on Sarah only; `Calendars.ReadWrite` on Vic only |

## 4. Verify (after 30–60 minutes)

Run the three `Test-ServicePrincipalAuthorization` lines at the end of the script:

| Mailbox | Expected `InScope` |
|---|---|
| Sarah | `Application Mail.ReadWrite` True, `Application Mail.Send` True, Calendars False |
| Vic | `Application Calendars.ReadWrite` True, Mail False |
| Brad (anyone else) | all False |

If Vic shows Mail as True, or Brad shows anything True, **stop and fix it before continuing.**

## 5. Values for the next steps

| Value | Goes into |
|---|---|
| Tenant ID | n8n Graph credential, `accessTokenUrl` |
| Application (client) ID | n8n Graph credential, `clientId` |
| Client secret value | n8n Graph credential, `clientSecret` |
| Vic's exact UPN (lowercase) | `db/003_seed.sql` |
| Your UPN | `alert_address` setting |

## Adding another employee later

1. Tag their mailbox with `Set-Mailbox <upn> -CustomAttribute11 "SchedAgentCal"`. That puts their calendar in scope; wait for RBAC to refresh, then re-run the verify step.
2. Insert their row into `sched.employees` (copy Vic's and change it).

Their mail is never in scope. Sarah only ever reads her own mailbox.
