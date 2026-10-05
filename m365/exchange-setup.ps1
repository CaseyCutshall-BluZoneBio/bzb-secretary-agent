# =============================================================================
# BZB Scheduling Agent ("Sarah") — Exchange Online setup
# Walkthrough: docs/02-m365-setup.md
#
# Gives the app MAIL rights on Sarah's mailbox and nothing else. Employees'
# calendars are NOT granted here: each person connects their own calendar by
# signing in to the portal (docs/09-portal.md).
#
# Run in Azure Cloud Shell (portal.azure.com → Cloud Shell → PowerShell).
# Nothing to install: ExchangeOnlineManagement is preinstalled there.
#
# BEFORE RUNNING (Entra admin center, GUI):
#   1. App registrations → New registration → "BZB Scheduling Agent", single tenant, no redirect URI.
#   2. Certificates & secrets → New client secret (12 months; put the rotation date on a calendar).
#   3. API permissions → remove the default User.Read. Grant NOTHING.
#      Any Mail/Calendar *application* permission granted in Entra is tenant-wide
#      and bypasses the scoping below. This list must stay empty.
#   4. Copy two IDs:
#        App registrations → the app → Overview → Application (client) ID → $AppId
#        Enterprise applications → the app → Overview → Object ID       → $SpObjectId
#      The Object ID must come from ENTERPRISE APPLICATIONS. The app
#      registration page shows a different GUID; using it fails later with
#      "not authorized".
# =============================================================================

$AppId       = "<application-client-id>"
$SpObjectId  = "<enterprise-app-object-id>"
$CaseyUpn    = "<casey-upn>@bluzonebio.com"     # Full Access to Sarah's mailbox for shadow-mode review
$SarahUpn    = "sarah.johnson@bluzonebio.com"
$CheckUpns   = @("vic@bluzonebio.com", "brad")  # other mailboxes for the final check: must show nothing in scope

Connect-ExchangeOnline

# -----------------------------------------------------------------------------
# 1. Sarah: shared mailbox (no license)
#    GUI alternative: M365 admin center → Teams & groups → Shared mailboxes → Add.
# -----------------------------------------------------------------------------
# The display name carries the AI disclosure — clients see it in the From line.
New-Mailbox -Shared `
  -Name "Sarah Johnson" `
  -DisplayName "Sarah Johnson (AI Scheduling Assistant)" `
  -PrimarySmtpAddress $SarahUpn `
  -Alias "sarah.johnson"

# Invites never land on Sarah's calendar, but make sure it never auto-responds.
Set-CalendarProcessing -Identity $SarahUpn -AutomateProcessing None

# Casey can open Sarah's mailbox (Drafts, Sent) while reviewing. No Send As for
# anyone: only the app sends as Sarah.
Add-MailboxPermission -Identity $SarahUpn -User $CaseyUpn -AccessRights FullAccess -AutoMapping $true

# -----------------------------------------------------------------------------
# 2. Tag Sarah's mailbox: the only mailbox the app may touch.
#    GUI alternative: Exchange admin center → Recipients → Mailboxes → Sarah
#    → Others → Custom attributes.
# -----------------------------------------------------------------------------
Set-Mailbox -Identity $SarahUpn -CustomAttribute10 "SchedAgentMail"

# -----------------------------------------------------------------------------
# 3. Register the app's service principal in Exchange
# -----------------------------------------------------------------------------
New-ServicePrincipal -AppId $AppId -ObjectId $SpObjectId -DisplayName "BZB Scheduling Agent"

# -----------------------------------------------------------------------------
# 4. Scope + role assignments (RBAC for Applications): read/draft/move mail and
#    send, on Sarah's mailbox only.
# -----------------------------------------------------------------------------
New-ManagementScope -Name "SchedAgent-Mail" `
  -RecipientRestrictionFilter "CustomAttribute10 -eq 'SchedAgentMail'"
New-ManagementRoleAssignment -App $AppId -Role "Application Mail.ReadWrite" -CustomResourceScope "SchedAgent-Mail"
New-ManagementRoleAssignment -App $AppId -Role "Application Mail.Send"      -CustomResourceScope "SchedAgent-Mail"

# -----------------------------------------------------------------------------
# 5. Verify — wait 30–60 minutes first; RBAC changes are cached.
#    Expected:
#      Sarah → Mail.ReadWrite + Mail.Send InScope True
#      everyone else (Vic, Brad, …) → everything False
# -----------------------------------------------------------------------------
Test-ServicePrincipalAuthorization -Identity $AppId -Resource $SarahUpn | Format-Table RoleName, InScope
foreach ($u in $CheckUpns) {
  Test-ServicePrincipalAuthorization -Identity $AppId -Resource $u | Format-Table RoleName, InScope
}

# -----------------------------------------------------------------------------
# AFTER RUNNING (GUI)
#   M365 admin center → Users → Active users → Sarah Johnson → Block sign-in.
#   (Shared mailboxes get an enabled Entra account; nothing should ever log in as Sarah.)
#
# OPTIONAL: app-only calendar access for Vic, only if he must use Sarah before
#   he can sign in to the portal. See docs/02-m365-setup.md, "Optional: app-only
#   calendar access for Vic", which also has the commands to undo it.
#
# ROLLBACK
#   Get-ManagementRoleAssignment -RoleAssigneeName $AppId | Remove-ManagementRoleAssignment
#   Remove-ManagementScope "SchedAgent-Mail"
#   Remove-ServicePrincipal -Identity $AppId
# =============================================================================
