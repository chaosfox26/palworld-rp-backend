# Running the server

Two ways to drive the backend: a web panel, and an interactive terminal menu.
Both do the same things, and both sit on top of the same code as the flag-based
commands — there is one implementation of each action, not three.

---

## The admin panel

The panel listens on **127.0.0.1:8787** and is deliberately *not* reachable from
the internet. Caddy proxies only the public app on port 3000, so no request from
outside can reach the panel at all.

That is the point. A public server with an admin login form at a guessable URL
gets credential-stuffed within hours of appearing in certificate transparency
logs. Having no public login form is a stronger position than having a
well-defended one.

### Opening it

From the server itself:

```bash
curl http://127.0.0.1:8787        # confirms it is up
```

From your own computer, forward the port over SSH:

```bash
ssh -L 8787:127.0.0.1:8787 you@your-server
```

Leave that running and open **http://localhost:8787** in your browser. Sign in
with the `ADMIN_TOKEN` from your env file:

```bash
sudo grep ADMIN_TOKEN /etc/palworld-rp-backend/env
```

`palworld-rp menu` → *Open the admin panel* prints both the tunnel command and
the token for you, if you run it with sudo.

> **On this server specifically:** `sshd` is not currently running, and port 22
> is not open in the Contabo panel. See *Enabling SSH* at the bottom.

### What it does

| Tab | What you get |
|---|---|
| **Overview** | Players online, account count, uptime, registration state, and the live state of the backend and Caddy — with restart and stop buttons. |
| **Players** | Every account, who is online, who is banned. Ban with a reason, kick, unban, or delete an account outright. |
| **Settings** | The tunables that are safe to change at runtime, with their bounds and an explanation of each. |
| **Backups** | Trigger a backup and see the ones you already have. |
| **Logs** | The last N lines from the backend or from Caddy. |

Banning disconnects every one of that player's sessions immediately and blocks
re-login. Deleting removes the account and profile and cannot be undone.

### Why some settings are missing

The panel can change chat limits, party size, the local chat radius, password
length, registration and the encryption requirement. It **cannot** change the
admin token, the domain, TLS mode, the listen ports, the data directory, or its
own bind address.

That split is deliberate. The panel runs as the unprivileged service account and
writes overrides to `settings.json` in the data directory, layered over your
root-owned env file:

```
built-in default   <   env file   <   settings.json
```

The service cannot write the env file — that is what stops a compromised backend
from rewriting its own configuration or handing itself a new admin token. The
security-critical values live only in the env file, so changing them requires
root and an editor. Anything in the panel is, at worst, a way to make the server
annoying rather than a way in.

Settings marked **needs restart** are read once at startup. Save them, then use
the Overview tab to restart.

### Service control and privileges

Restart, stop and backup need root, and the service account does not have it. The
installer adds `/etc/sudoers.d/palworld-rp-backend` granting exactly this:

- `systemctl restart|stop|start palworld-rp-backend`
- `systemctl restart|reload|stop|start caddy`
- `/opt/palworld-rp-backend/deploy/backup.sh`

No shell, no editor, no wildcards, no other unit, no arbitrary systemctl verb.
`systemctl edit` and `systemctl link` — which can execute arbitrary code — are
deliberately absent. Every entry is fully qualified with fixed arguments, so
nothing can be smuggled in through an argument.

The installer validates the file with `visudo -c` in a temporary location before
installing it, because a malformed file in `sudoers.d` breaks `sudo` for every
user on the machine.

If you would rather not grant even this, delete the file:

```bash
sudo rm /etc/sudoers.d/palworld-rp-backend
```

The panel keeps working; its service-control buttons report that they are not
permitted.

### Turning the panel off

```bash
sudo sed -i 's/^ADMIN_UI=.*/ADMIN_UI=0/' /etc/palworld-rp-backend/env
sudo systemctl restart palworld-rp-backend
```

### Do not expose it

`ADMIN_UI_BIND` defaults to `127.0.0.1`. Setting it to `0.0.0.0` publishes an
admin login form to the entire internet. The server logs a warning at startup if
you do. Forward the port instead — that is what SSH is for.

---

## The terminal menu

```bash
palworld-rp menu
```

An arrow-key menu over the same actions:

```
  > Status and health
    Full diagnostic (doctor)
    Players and bans
    Open the admin panel
    Show the backend URL
    Back up now
    View logs
    Restart the service
    Update to the latest version
    Quit
```

Arrow keys or `j`/`k` to move, Enter to choose, number keys to jump, `q` to go
back, Ctrl-C to quit.

It degrades rather than breaking: on a terminal without raw mode it falls back to
a numbered prompt, and when output is piped it prints the list and exits instead
of hanging a script forever.

Player management from the menu needs the admin token, so run it with `sudo` or
it will tell you it cannot read the env file.

Every flag-based command still works exactly as before, which is what you want
for scripting:

```bash
palworld-rp status
palworld-rp doctor
palworld-rp backup
palworld-rp url
```

---

## Enabling SSH

The tunnel needs `sshd` running on the server and port 22 reachable. On this
deployment neither is currently true.

```bash
sudo apt install openssh-server
sudo systemctl enable --now ssh
sudo ufw allow OpenSSH
```

Then open port 22 in the **Contabo control panel** as well — its rules drop
everything not explicitly allowed, so the server-side firewall alone is not
enough.

Before you close your console session, open a *second* connection and confirm it
works. Locking yourself out of a remote server is easy and tedious to undo.

Consider key-based authentication and `PasswordAuthentication no` in
`/etc/ssh/sshd_config`. A public server with password SSH will be brute-forced
continuously.
