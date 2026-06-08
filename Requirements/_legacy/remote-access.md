# Remote Access Setup — Tailscale + SSH (Key-Based Auth)

> **Goal**: Access your Windows laptop and Claude Code sessions securely from your phone,
> anywhere, without opening any router ports.

## Why This Stack

- **Tailscale** (WireGuard VPN) — your laptop is invisible to the public internet; only
  your enrolled devices can see each other
- **SSH key auth** — no passwords over the wire; your private key never leaves your phone
- Two independent auth layers: Tailscale identity + SSH key

---

## Part 1 — Install Tailscale on the Laptop

1. Download from **tailscale.com/download** → Windows
2. Install and sign in with a Google or GitHub account (free personal plan is fine)
3. Note your laptop's Tailscale IP: shown in the Tailscale tray icon menu (e.g. `100.x.x.x`)
4. Keep Tailscale running in the tray — it starts automatically with Windows by default

---

## Part 2 — Enable OpenSSH Server on Windows 11

1. `Settings → System → Optional Features → View features` → search **OpenSSH Server** → Install
2. Open PowerShell as Administrator:
   ```powershell
   # Start the service now
   Start-Service sshd

   # Make it start automatically on boot
   Set-Service -Name sshd -StartupType Automatic
   ```
3. Verify it's listening:
   ```powershell
   netstat -an | findstr :22
   ```
   You should see `0.0.0.0:22  LISTENING`.

> **Firewall note**: Windows automatically adds a firewall rule for OpenSSH when you install it.
> You do NOT need to open port 22 on your router — Tailscale handles routing internally.

---

## Part 3 — Generate an SSH Key Pair on Your Phone

### iOS — Blink Shell (recommended)
1. Install **Blink Shell** from the App Store ($19.99 one-time, worth it)
2. In Blink: `Settings → Keys → + → Create New Key`
   - Type: **Ed25519** (most secure, smallest key)
   - Name: `phone-key`
3. Copy the **public key** (the `.pub` portion shown in Settings → Keys → phone-key → Copy Public Key)

### Android — Termius (free tier works)
1. Install **Termius** from Play Store
2. `Settings → Keychain → New Key → Generate`
   - Type: Ed25519
3. Export / copy the public key

---

## Part 4 — Authorize the Phone's Public Key on the Laptop

On the laptop, in PowerShell:

```powershell
# Create .ssh folder if it doesn't exist
New-Item -ItemType Directory -Force "$env:USERPROFILE\.ssh"

# Open the authorized_keys file (create if new)
notepad "$env:USERPROFILE\.ssh\authorized_keys"
```

Paste your phone's **public key** on a new line. Save and close.

Then lock down the file permissions (required — SSH rejects world-readable keys):

```powershell
$path = "$env:USERPROFILE\.ssh\authorized_keys"
$acl = Get-Acl $path
$acl.SetAccessRuleProtection($true, $false)
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    $env:USERNAME, "FullControl", "Allow"
)
$acl.SetAccessRule($rule)
Set-Acl $path $acl
```

---

## Part 5 — Disable Password Auth (Critical Security Step)

Edit the SSH server config:

```powershell
notepad "C:\ProgramData\ssh\sshd_config"
```

Find and set (or add) these lines:

```
PasswordAuthentication no
PubkeyAuthentication yes
```

Also comment out or remove these two lines at the bottom of the file if present
(they override your per-user authorized_keys with an admin key file):

```
# Match Group administrators
#        AuthorizedKeysFile __PROGRAMDATA__/ssh/administrators_authorized_keys
```

Restart SSH:

```powershell
Restart-Service sshd
```

---

## Part 6 — Install Tailscale on Your Phone

1. Install **Tailscale** from App Store / Play Store (free)
2. Sign in with the **same account** you used on the laptop
3. Both devices should appear in your Tailscale admin console at **login.tailscale.com**

---

## Part 7 — Connect from Your Phone

### Blink Shell (iOS)
```
ssh your-windows-username@100.x.x.x
```
Replace `100.x.x.x` with your laptop's Tailscale IP.

Save it as a host shortcut in Blink: `Settings → Hosts → + → fill in alias, host, user, key`.

### Termius (Android)
- New Host → fill in Tailscale IP, username, select your key from Keychain

---

## Part 8 — Navigate to the Project and Start Claude Code

Once connected via SSH:

```bash
cd /c/Shaky/Projects/TradeAnalyzer_Minimax
claude
```

> **Note**: Claude Code CLI must already be installed on the laptop. The SSH session runs
> in your Windows environment, so all your local files, Git history, and npm tools are
> available exactly as in a local terminal.

---

## Keeping the Laptop Awake

SSH sessions drop if the laptop sleeps. Prevent it:

```powershell
# Prevent sleep while plugged in (run once, persists)
powercfg /change standby-timeout-ac 0
```

Or set it in `Settings → System → Power → Screen and sleep → When plugged in, put my PC to sleep → Never`.

---

## Optional: Auto-Start SSH on Login

Already handled by `Set-Service -Name sshd -StartupType Automatic` in Part 2.
The SSH server starts with Windows — no manual step needed after a reboot.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Connection refused` | Check `Get-Service sshd` — must show `Running` |
| `Permission denied (publickey)` | Re-check `authorized_keys` permissions (Part 4); check sshd_config has no override |
| Phone can't reach laptop IP | Confirm Tailscale is running on both devices and both appear in the admin console |
| Claude Code command not found | Add Claude Code's install path to your Windows `PATH`; or use the full path |
| Session drops after a few minutes | Disable laptop sleep (see above); add `ServerAliveInterval 60` in Blink/Termius host settings |

---

## Ideas to Flesh Out

- [ ] Remote monitoring of Batch Jobs (daily briefs, IV capture) from phone without full SSH session
- [ ] Phone-friendly read-only view via the app's local HTTP API (port 7432) tunneled over Tailscale
- [ ] Push notifications to phone when a Batch Job completes or Daily Brief is ready
- [ ] Triggering a Daily Brief run remotely (lightweight API call vs full SSH)
- [ ] Auto-wake / Wake-on-LAN so laptop doesn't need to stay on 24/7
