# Run once in an elevated PowerShell window on the host computer.
# Only allows the shared canvas port on Windows Private networks.
$ErrorActionPreference = 'Stop'
$name = 'TapNow Studio LAN Collaboration (TCP 3702)'
$existing = Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue
if ($existing) {
    Set-NetFirewallRule -DisplayName $name -Enabled True -Profile Private -Action Allow
} else {
    New-NetFirewallRule -DisplayName $name -Direction Inbound -Protocol TCP -LocalPort 3702 -Action Allow -Profile Private -Description 'Allow local-network collaboration via a 5-digit join code' | Out-Null
}
Get-NetFirewallRule -DisplayName $name | Select-Object DisplayName, Enabled, Action, Profile
