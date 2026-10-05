# 1 · Microsoft 365 setup

**Result:** a shared mailbox for Sarah, and an app that can read and send mail **as Sarah and nothing else** in the tenant.

This guide covers Sarah's mail only. Employees' calendars are connected separately, by each person signing in to the portal (`docs/09-portal.md`). The app set up here never gets calendar rights unless you take the optional step at the end.

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

This is a different app from the portal's "BZB Sarah Portal" (`docs/09-portal.md` §1). Keep them separate.

## 2. Shared mailbox (GUI or script)

Either:
- **M365 admin center → Teams & groups → Shared mailboxes → Add**
  - Name `Sarah Johnson (AI Scheduling Assistant)`
  - Email `sarah.johnson@bluzonebio.com`

or let the script create it (step 3).

Then **Users → Active users → Sarah Johnson → Block sign-in.** Nothing should ever log in as Sarah.

## 3. Scope the app to Sarah's mailbox (Cloud Shell)

Entra can't limit an app to specific mailboxes; only Exchange's *RBAC for Applications* can, and it's configured in PowerShell. You don't need to install anything:

1. Open **portal.azure.com → Cloud Shell → PowerShell**.
2. Upload `m365/exchange-setup.ps1` with the upload button, or paste it in.
3. Fill in the variables at the top and run it. If you created the mailbox in the GUI, skip the `New-Mailbox` line.

The script:

| Step | Effect |
|---|---|
| `New-Mailbox -Shared` | Sarah's mailbox, display name with the AI disclosure |
| `Set-CalendarProcessing -AutomateProcessing None` | Sarah's calendar never auto-responds |
| `Add-MailboxPermission … FullAccess` | You can open Sarah's mailbox (Drafts/Sent) during review. No Send As for anyone |
| `CustomAttribute10 = SchedAgentMail` on Sarah | Tags the one mailbox the app may use |
| `New-ServicePrincipal` | Registers the app in Exchange |
| `New-ManagementScope` + two role assignments | `Mail.ReadWrite` + `Mail.Send` on Sarah only |

## 4. Verify (after 30–60 minutes)

Run the `Test-ServicePrincipalAuthorization` lines at the end of the script:

| Mailbox | Expected `InScope` |
|---|---|
| Sarah | `Application Mail.ReadWrite` True, `Application Mail.Send` True |
| Vic | all False |
| Brad (anyone else) | all False |

If Vic or Brad shows anything True, **stop and fix it before continuing.** The app should be able to touch exactly one mailbox.

## 5. Values for the next steps

| Value | Goes into |
|---|---|
| Tenant ID | n8n Graph credential, `accessTokenUrl` |
| Application (client) ID | n8n Graph credential, `clientId` |
| Client secret value | n8n Graph credential, `clientSecret` |
| Vic's exact UPN (lowercase) | `db/003_seed.sql` |
| Your UPN | `alert_address` setting |

## Calendars: the portal, not this app

Each employee, Vic included, connects their own calendar at the portal (`docs/09-portal.md`):

- **Vic:** his row comes from `db/003_seed.sql`. Until he signs in and connects, Sarah can't read his calendar: any request he sends escalates with "I couldn't read your calendar". So have him connect **before you leave `dry_run`** (`docs/05-rollout.md`, Stage 0). Connecting switches his row to delegated access automatically.
- **Everyone else:** add them to the **Sarah users** group in Entra and send them the portal link. They sign in, connect their calendar and set their preferences. No PowerShell, no SQL.

Their mail is never in scope. Sarah only ever reads her own mailbox.

## Optional: app-only calendar access for Vic

Only if Vic has to use Sarah **before** he can sign in to the portal (for example, the portal isn't deployed yet). This gives the app-only secret read/write on Vic's calendar, which the portal path avoids. Undo it once he has connected.

```powershell
# Cloud Shell, after the main script; same $AppId as there
Connect-ExchangeOnline
Set-Mailbox -Identity "vic@bluzonebio.com" -CustomAttribute11 "SchedAgentCal"
New-ManagementScope -Name "SchedAgent-Cal" -RecipientRestrictionFilter "CustomAttribute11 -eq 'SchedAgentCal'"
New-ManagementRoleAssignment -App $AppId -Role "Application Calendars.ReadWrite" -CustomResourceScope "SchedAgent-Cal"
# after 30–60 minutes, expect Calendars.ReadWrite True for Vic only:
Test-ServicePrincipalAuthorization -Identity $AppId -Resource "vic@bluzonebio.com" | Format-Table RoleName, InScope
```

Vic's row already has `calendar_auth = 'app'`, so this works with no database change. **Undo it** after Vic connects at the portal (his row is then `delegated`):

```powershell
Get-ManagementRoleAssignment -RoleAssigneeName $AppId | ? Role -eq "Application Calendars.ReadWrite" | Remove-ManagementRoleAssignment
Remove-ManagementScope "SchedAgent-Cal"
Set-Mailbox -Identity "vic@bluzonebio.com" -CustomAttribute11 $null
```

Don't use this for anyone else; give them the portal.
