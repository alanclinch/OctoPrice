# Copying OctoAgile Advisor to another computer

## Where the project is on Alan's Windows computer

The project folder is:

```text
C:\Projects\OctoPrice
```

Open File Explorer and paste that path into its address bar. The folder holds
the source code, `README.md`, `AI_START_HERE.md`, `AI_HANDOFF.md`, `AGENTS.md`,
`CLAUDE.md`, `docs/`, `migrations/` and the other project files. Start a new AI
with `AI_START_HERE.md`; it links to the other documents and the relevant code.
The documentation handoff is on the `dev` branch, not necessarily `main`.

## What to copy

Copy the project folder to a private, trusted location on the new computer.
Include the hidden `.git` folder if you want its local history and branches.
In File Explorer, hidden items can be shown from the View menu. Check the
current branch and any uncommitted work before copying, so nothing is missed.

**Review or exclude sensitive and machine-specific items before sharing the
copy with another person or AI:**

- `.octoprice-link.txt` and `.octoprice-dev-link.txt` are invitation-link files
  and may contain usable access credentials. Both existed on the original
  computer when checked on 1 November 2026; do not share their contents.
- `.env`, `.dev.vars`, `.wrangler/`, local `*.sqlite*` files, `data/`, `.tmp/`
  and `apps/server/tmp/` may contain credentials, local databases or personal
  information. `.octoprice-issue-link.sql`, if present, may also contain
  sensitive access information. Some are Git-ignored and some may not be;
  either way, a normal folder copy can include them.
- `node_modules/` and `dist/` are generated. They are not required for the
  handoff; install an appropriate Node.js version and run `npm install` at the
  project root on the new computer to recreate dependencies.

Do not delete any of these from the original computer as part of copying.
If you need a source-only copy, the public GitHub repository can also be cloned
and its `dev` branch checked out; confirm any local uncommitted changes have
been preserved first. GitHub history alone does not include ignored files.

## What is not in the project folder

The live Workers, their schedules and the production D1 database are in
Cloudflare, not in `C:\Projects\OctoPrice`. Managing or restoring them requires
access to the correct Cloudflare account. On the original computer a Wrangler
login configuration existed at the path below when checked on 1 November 2026;
it is outside the project folder and may contain credentials. Do not send or
commit it, and use a normal Cloudflare login on the new computer instead.

```text
C:\Users\alanc\AppData\Roaming\xdg.config\.wrangler\config\default.toml
```

Existing notification subscriptions depend on the original VAPID keys. Their
recoverable location has not been established: check secure records without
exposing or committing the keys. Do not assume Cloudflare Worker secrets can be
read back in plaintext. Do not rotate keys, copy production user data or issue
new invites merely to move the source. See `docs/dormancy.md` for the full
retention and resumption decisions.

The next AI can use its own development and review methods and models; it does
not need this computer's Claude CLI installation or a particular reviewer.
