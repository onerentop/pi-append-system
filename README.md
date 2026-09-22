# pi-append-system

A [pi](https://pi.dev) extension that manages the rules in pi's native **`APPEND_SYSTEM.md`** from a command: add, edit, delete, toggle individual rules on/off, and a global switch. Changes are written to `APPEND_SYSTEM.md` and take effect on **`/reload`**.

> **2.0 changed the mechanism.** 1.x injected a live `dynamic_append` section (no `/reload`, extension-only). 2.x writes pi's canonical `APPEND_SYSTEM.md` instead — a stronger prompt position that survives even without the extension, at the cost of needing `/reload`. If you want the old real-time behavior, pin `@v1`.

## Why

`APPEND_SYSTEM.md` is pi's standard way to append text to the system prompt. Editing it by hand works, but you can't toggle a rule off without deleting it, and you can't keep a set of alternatives around. This extension adds a small structured layer on top: each rule has an enabled flag, and the **enabled** ones are concatenated into `APPEND_SYSTEM.md` on every change.

```text
/append-system add "Never force-push to main"
/append-system off 2        # park a rule without deleting it
/reload                     # apply
```

## Install

```bash
pi install git:github.com/onerentop/pi-append-system@v2
```

Pin an exact release with `@v2.0.0`. To move to a newer tag, re-run the install with the new ref — it fetches and resets the clone:

```bash
pi install git:github.com/onerentop/pi-append-system@v2.1.0
```

Project-local install (writes `.pi/settings.json`, shared with your team):

```bash
pi install -l git:github.com/onerentop/pi-append-system@v2
```

Try it without installing:

```bash
pi -e git:github.com/onerentop/pi-append-system
```

> **Upgrading from a hand-installed copy?** If you previously dropped `append-system.ts` into `~/.pi/agent/extensions/`, delete it first, or pi will load both and suffix the duplicate command as `/append-system:2`.

## Commands

| Command | What it does |
| --- | --- |
| `/append-system` | List every rule and the global switch |
| `/append-system add "text"` | Add a rule and enable it. Without text, opens an editor |
| `/append-system edit N` | Rewrite rule N, or open the editor prefilled to read it in full |
| `/append-system rm N [N...]` | Delete one or more rules |
| `/append-system on [N...]` | With numbers: enable those rules. Without: turn injection on globally |
| `/append-system off [N...]` | With numbers: disable those rules. Without: turn injection off globally |
| `/append-system clear` | Delete all rules (asks for confirmation) |
| `/append-system help` | Usage summary |

Aliases: `list` = `ls`, `remove`/`delete` = `rm`. **Every mutating command needs `/reload` (or a new session) to take effect** — the notification reminds you.

```text
$ /append-system ls

Rules (inject: on) — 2 total, 2 active
  1. [on ] Never force-push to main
  2. [on ] Always answer in Chinese

rm N delete · on/off N toggle one · on/off global switch · edit N edit/view · /reload to apply
```

`off` without arguments keeps your rules in the ledger but clears `APPEND_SYSTEM.md`, so you can park a rule set and bring it back with `on`. In the list, `[on ]`/`[off]` is the per-rule state and `inject:` is the global switch.

## How it works

Two files under your agent directory (`~/.pi/agent/` by default):

| File | Role |
| --- | --- |
| `append-system.json` | **Ledger** — every rule with its enabled flag. Source of truth, edited by the commands |
| `APPEND_SYSTEM.md` | **Rendered output** — the enabled rules concatenated (`\n\n` between them). This is pi's native file |

On every change the extension rewrites `APPEND_SYSTEM.md` from the enabled rules (both files are written atomically via temp-file + rename). pi reads `APPEND_SYSTEM.md` once at session start into the system prompt's `addendum` section, so a change lands after `/reload`.

When nothing is enabled (all rules off, global off, or cleared), `APPEND_SYSTEM.md` is **removed** so pi's addendum is empty.

The extension registers only a command plus a `session_start` status-bar sync. It installs **no** per-turn hook and does not alter the prompt at runtime — it is purely an editor for `APPEND_SYSTEM.md`.

### File ownership

The extension owns `APPEND_SYSTEM.md`. The first time it writes, if a hand-written `APPEND_SYSTEM.md` already exists, it is backed up to `APPEND_SYSTEM.md.bak` before being taken over (you'll get a warning). After that, the file is regenerated from the ledger on every change — don't hand-edit it, edit rules through the commands (or edit `append-system.json`, which is read fresh on every command).

### Gotcha: project-scope precedence

pi's `APPEND_SYSTEM.md` discovery is **either/or**: if the current project has a trusted `.pi/APPEND_SYSTEM.md`, pi uses it and **ignores** the global `~/.pi/agent/APPEND_SYSTEM.md` this extension writes. If your rules don't seem to apply, check for a project-level file.

### Language

Command output, errors and the list follow your system locale: `zh*` gets Simplified Chinese, everything else (including an unset `LANG`) gets English. Rule content is never translated. Checked in order: `LC_ALL`, `LC_MESSAGES`, `LANG`.

## Uninstall

```bash
pi remove git:github.com/onerentop/pi-append-system
```

`APPEND_SYSTEM.md` and `append-system.json` are left in place. Since `APPEND_SYSTEM.md` is pi's native file, your rules **keep working** after uninstall (that's the point of writing the canonical file) — delete both manually if you want them gone.

## Development

```bash
npm install
npm test        # unit tests + integration tests against pi's real loader
npm run check   # tsc --noEmit
```

`test/unit.test.mjs` mocks the extension API and covers command parsing, rendering `APPEND_SYSTEM.md`, the backup-on-takeover safety, and locale switching. `test/render.test.mjs` loads the package through pi's own `discoverAndLoadExtensions` and then uses pi's `DefaultResourceLoader` to verify pi actually reads the rendered `APPEND_SYSTEM.md` into its append system prompt. Tests isolate state via `PI_CODING_AGENT_DIR`, so they never touch your real configuration.

Ships as `.ts` and runs as-is on Node's native type stripping — no build step.

## Scope and safety

This extension reads and writes two files under your pi agent directory (`append-system.json`, `APPEND_SYSTEM.md`) and registers one command plus a status-bar sync. It installs no per-turn hook, runs no subprocesses, and makes no network requests. Zero runtime dependencies — `@earendil-works/pi-coding-agent` is a peer provided by pi.

## License

MIT
