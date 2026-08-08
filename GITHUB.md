# Getting this onto GitHub

Written for someone who has never used GitHub before, on Windows, publishing a
public repo. About 15 minutes.

We'll use **GitHub Desktop** — it's a normal Windows app with buttons, it
installs Git for you, and it handles login through your browser so there are no
access tokens to generate or paste. The command-line route is at the bottom if
you'd rather.

---

## Step 1 — Make a GitHub account

1. Go to **https://github.com/signup**
2. Enter your email, pick a password, pick a username.
   - The username becomes part of your repo's address:
     `https://github.com/chaosfox26/palworld-rp-backend`
   - Pick something you're happy putting in your mod's install instructions.
3. Verify your email when the message arrives.
4. Free plan is fine. Public repos are unlimited.

**Turn on two-factor authentication** while you're there
(Settings → Password and authentication). GitHub requires it for contributors
anyway, and this account will control the code your players install.

---

## Step 2 — Install GitHub Desktop

1. Download from **https://desktop.github.com**
2. Run the installer.
3. Open it and click **Sign in to GitHub.com**. Your browser opens, you approve,
   it returns to the app.
4. When it asks for your name and email for commits, the defaults are fine.

---

## Step 3 — Find your project folder

The project lives in a folder called `palworld-rp-backend`. The quickest way to
find it: in your Claude conversation, click any of the file cards I shared, then
use the option to show it in Explorer. Navigate up until you see the
`palworld-rp-backend` folder itself.

It should contain `server.js`, `README.md`, and folders named `src`, `deploy`,
`test` and `scripts`.

**Copy this folder somewhere permanent first** — for example
`C:\Users\Chara\Documents\palworld-rp-backend`. Don't work directly out of the
Claude outputs folder; it's a working directory, not a home for your project.

---

## Step 4 — Generate the lockfile

A lockfile pins dependencies to exact versions, so every install gets identical
code rather than whatever is newest that day. Without one the installer prints a
warning and resolves versions fresh — it still works, it is just not repeatable.

Use **`npm shrinkwrap`**, not plain `npm install`. The reason is specific: npm
strips `package-lock.json` out of every package it builds, including the one it
builds when installing from a git URL — so an `npx github:...` install would
never see it. `npm-shrinkwrap.json` is the publishable equivalent that npm does
ship, and `npm ci` accepts it.

In the project folder (type `cmd` in Explorer's address bar and press Enter):

```
npm install
npm shrinkwrap
```

That leaves `npm-shrinkwrap.json`. Commit it with everything else. Re-run both
commands whenever you change dependencies.

**No Node on your PC?** You can do it on the server instead:

```bash
cd ~/palworld-rp-backend
npm install && npm shrinkwrap
```

then copy the file back and commit it. Or skip it — the warning is harmless.

---

## Step 5 — Create the repository

In GitHub Desktop:

1. **File → Add local repository**
2. Click **Choose...** and select your `palworld-rp-backend` folder
3. It will say *"This directory does not appear to be a Git repository"* — click
   the **create a repository** link in that message
4. Fill in:
   - **Name:** `palworld-rp-backend`
   - **Description:** `Standalone chat and roleplay profile backend for a Palworld UE4SS mod`
   - **Git ignore:** leave as **None** — the project already has one
   - **License:** leave as **None** — the project already has one
5. Click **Create repository**

You'll now see a list of files ready to commit. Before continuing, **check that
list**:

- `node_modules`, `data/` and `.env` must **not** appear. If any do, stop and
  tell me — the ignore rules aren't being picked up.
- `LICENSE`, `.gitattributes` and `.gitignore` **should** appear.

---

## Step 6 — Commit and publish

1. Bottom left, in the **Summary** box, type: `Initial commit`
2. Click **Commit to main**
3. Click **Publish repository** at the top
4. **Untick "Keep this code private"** — this is the important one. Leaving it
   ticked means your Contabo server can't clone it without extra credentials.
5. Click **Publish repository**

Your code is now at `https://github.com/chaosfox26/palworld-rp-backend`.

Open that URL in a browser and confirm you can see the files while logged out
(try a private window). If you can, the server will be able to clone it.

---

## Step 7 — (Only if you fork or rename)

The repository URL is already set throughout to
`github.com/chaosfox26/palworld-rp-backend`, so there is nothing to edit.

If you ever fork this, rename the repo, or change your GitHub username, update
these and everything follows:

- `package.json` — the `repository.url` field. **This one matters most**: the
  CLI reads it to work out which repo to quote in its own help and messages.
- `deploy/bootstrap.sh` and `deploy/bootstrap.ps1` — the `REPO_URL` default,
  used by the no-Node fallback installer.
- `README.md`, `INSTALL.md`, `DEPLOY.md` — the install commands
- `deploy/palworld-rp-backend.service` — the `Documentation=` line

All at once, from inside the project folder:

```bash
# macOS / Linux
grep -rl chaosfox26 . --exclude-dir=.git | xargs sed -i 's|chaosfox26|new-owner|g'
```

Installing from a fork without editing anything also works:

```bash
npx -y github:new-owner/palworld-rp-backend
```

---

## Step 8 — Install it on the Contabo server

One command, now that the repo is public:

```
npx -y github:chaosfox26/palworld-rp-backend
```

Same on Windows, macOS and Linux. It pulls straight from your repository.

**Nothing goes after the spec.** npm reads the next word as the name of the
program to run, so `... install` makes it launch `/usr/bin/install` and fail with
`install: missing file operand`. With no word, the CLI installs by default.

If Node.js is not installed on the target machine yet, use the self-contained
bootstrap instead — it installs Node itself:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/chaosfox26/palworld-rp-backend/main/deploy/bootstrap.sh)
```

Continue with **DEPLOY.md** for DNS, firewall and migrating your old profiles.

---

## Making changes later

The loop, forever after:

1. Edit files on your PC
2. GitHub Desktop shows what changed — review it, write a short summary, **Commit to main**
3. Click **Push origin**
4. On the server: `palworld-rp update`

That re-fetches your repository and re-runs the installer. Because npx resolves
the branch fresh each time, pushing to `main` is all it takes to ship a change.
(`palworld-rp` was put on your PATH by the install, so you never need to type the
npx spec again — but `npx -y github:chaosfox26/palworld-rp-backend` still works and does the same thing.)

---

## Things to never commit

`.gitignore` handles these automatically, but know why they're excluded:

| Never commit | Why |
|---|---|
| `.env` | Contains your admin token |
| `data/` | Player accounts and password hashes |
| `node_modules/` | Thousands of files; regenerated from `package.json` |
| Backup `.tar.gz` files | Contain password hashes |

**If you ever commit a secret, rotating it is the only real fix.** Deleting the
file in a later commit does not remove it — the old commit is still in history,
and on a public repo it will have been scraped within minutes. For this project
that means generating a new admin token and restarting the service.

---

## Command-line alternative

If you'd rather use Git directly. You'll need Git from **https://git-scm.com**,
and you must create the empty repo on GitHub first
(**https://github.com/new**, name it `palworld-rp-backend`, public, and do
**not** tick any of the "initialize with" boxes).

```bash
cd path/to/palworld-rp-backend

git init
git add .
git status              # confirm no .env, no data/, no node_modules
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/chaosfox26/palworld-rp-backend.git
git push -u origin main
```

Modern Git opens a browser window to authenticate on first push. If it asks for
a password in the terminal instead, that's the old prompt — GitHub no longer
accepts account passwords there, and you'd need a personal access token from
Settings → Developer settings → Personal access tokens. This is exactly the
hassle GitHub Desktop avoids.

---

## Troubleshooting

**"Repository already exists" when publishing.** You already made one with that
name on github.com. Either delete it there (Settings → scroll to the bottom →
Delete this repository) or pick a different name.

**`node_modules` shows up in the file list.** The `.gitignore` isn't being read.
Confirm the file is named exactly `.gitignore` — Notepad likes to save it as
`.gitignore.txt`. In Explorer, turn on **View → File name extensions** to check.

**Push rejected, "failed to push some refs".** The GitHub repo has commits yours
doesn't — usually from ticking "Add a README" when creating it. Easiest fix:
delete the GitHub repo and republish from GitHub Desktop, which creates it
empty.

**Server clone asks for a username and password.** The repo is still private.
On github.com: your repo → **Settings** → **General** → scroll to **Danger
Zone** → **Change visibility** → Public.
