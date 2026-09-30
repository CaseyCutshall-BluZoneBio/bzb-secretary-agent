# =============================================================================
# BZB Scheduling Agent ("Sarah") — Exchange Online setup
# Walkthrough: docs/02-m365-setup.md
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
$VicUpn      = "vic@bluzonebio.com"             # confirm Vic's exact UPN
$CaseyUpn    = "<casey-upn>@bluzonebio.com"     # Full Access to Sarah's mailbox for shadow-mode review
$SarahUpn    = "sarah.johnson@bluzonebio.com"

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
# 2. Tag the two mailboxes — with DIFFERENT attributes on purpose.
#    GUI alternative: Exchange admin center → Recipients → Mailboxes → (mailbox)
#    → Others → Custom attributes.
#
#    Least privilege: the app gets MAIL rights on Sarah only and CALENDAR rights
#    on Vic only. It cannot read Vic's inbox or send as Vic, even with a stolen
#    secret. The booking invite still comes from Vic's calendar: creating an
#    event with attendees is a calendar operation, and Exchange sends the invite.
# -----------------------------------------------------------------------------
Set-Mailbox -Identity $SarahUpn -CustomAttribute10 "SchedAgentMail"
Set-Mailbox -Identity $VicUpn   -CustomAttribute11 "SchedAgentCal"

# -----------------------------------------------------------------------------
# 3. Register the app's service principal in Exchange
# -----------------------------------------------------------------------------
New-ServicePrincipal -AppId $AppId -ObjectId $SpObjectId -DisplayName "BZB Scheduling Agent"

# -----------------------------------------------------------------------------
# 4. Scopes + role assignments (RBAC for Applications)
# -----------------------------------------------------------------------------
New-ManagementScope -Name "SchedAgent-Mail" `
  -RecipientRestrictionFilter "CustomAttribute10 -eq 'SchedAgentMail'"
New-ManagementScope -Name "SchedAgent-Cal" `
  -RecipientRestrictionFilter "CustomAttribute11 -eq 'SchedAgentCal'"

# Sarah: read / draft / move mail, and send
New-ManagementRoleAssignment -App $AppId -Role "Application Mail.ReadWrite"      -CustomResourceScope "SchedAgent-Mail"
New-ManagementRoleAssignment -App $AppId -Role "Application Mail.Send"           -CustomResourceScope "SchedAgent-Mail"
# Vic: read the calendar, write holds and the final event
New-ManagementRoleAssignment -App $AppId -Role "Application Calendars.ReadWrite" -CustomResourceScope "SchedAgent-Cal"

# -----------------------------------------------------------------------------
# 5. Verify — wait 30–60 minutes first; RBAC changes are cached.
#    Expected:
#      Sarah → Mail.ReadWrite + Mail.Send InScope True, Calendars False
#      Vic   → Calendars.ReadWrite InScope True, Mail.* False
#      Brad  → everything False
# -----------------------------------------------------------------------------
Test-ServicePrincipalAuthorization -Identity $AppId -Resource $SarahUpn | Format-Table RoleName, InScope
Test-ServicePrincipalAuthorization -Identity $AppId -Resource $VicUpn   | Format-Table RoleName, InScope
Test-ServicePrincipalAuthorization -Identity $AppId -Resource "brad"    | Format-Table RoleName, InScope

# -----------------------------------------------------------------------------
# AFTER RUNNING (GUI)
#   M365 admin center → Users → Active users → Sarah Johnson → Block sign-in.
#   (Shared mailboxes get an enabled Entra account; nothing should ever log in as Sarah.)
#
# ROLLBACK
#   Get-ManagementRoleAssignment -RoleAssigneeName $AppId | Remove-ManagementRoleAssignment
#   Remove-ManagementScope "SchedAgent-Mail"; Remove-ManagementScope "SchedAgent-Cal"
#   Remove-ServicePrincipal -Identity $AppId
# =============================================================================
