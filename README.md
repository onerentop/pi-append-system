# pi-append-system

A [pi](https://pi.dev) extension that adds, toggles and removes **system-prompt append rules at runtime** — no file editing, no `/reload`.

## The problem

Pi lets you append text to the system prompt through `APPEND_SYSTEM.md`, but that file is read **once at session start**. Once you edit it, nothing changes until you run `/reload` or open a new session. There is also no way to switch a rule off temporarily, and no way to keep more than one alternative rule set around.

This extension replaces that workflow with a command:

```text
/append-system add "Never force-push to main"
```

The rule is in the system prompt on your **very next message**.

## Requirements

pi **0.68.0** or newer — the `systemPromptOptions` field on `before_agent_start` was introduced there. Developed and tested against pi 0.87.0.

## Install

```bash
pi install git:github.com/onerentop/pi-append-system@v1
```

Pin an exact release with `@v1.0.0` instead of `@v1`. To move to a newer tag, re-run the install with the new ref — it fetches and resets the clone, so there is no separate update step:

```bash
pi install git:github.com/onerentop/pi-append-system@v1.1.0
```

Project-local install (writes `.pi/settings.json`, shared with your team):

```bash
pi install -l git:github.com/onerentop/pi-append-system@v1
```

Try it without installing:

```bash
pi -e git:github.com/onerentop/pi-append-system
```

> **Upgrading from a hand-installed copy?** If you previously dropped `append-system.ts` into `~/.pi/agent/extensions/`, delete it first. pi would load both, silently suffix the duplicate command as `/append-system:2`, and have both handlers write the same state file.

## Commands

| Command | What it does |
| --- | --- |
| `/append-system` | List every rule and the global switch |
| `/append-system add "text"` | Add a rule and enable it. Without text, opens an editor |
| `/append-system edit N` | Rewrite rule N. Without text, opens the editor prefilled — useful to read a long rule in full |
| `/append-system rm N [N...]` | Delete one or more rules |
| `/append-system on [N...]` | With numbers: enable those rules. Without: turn injection on globally |
| `/append-system off [N...]` | With numbers: disable those rules. Without: turn injection off globally |
| `/append-system clear` | Delete all rules (asks for confirmation) |
| `/append-system help` | Usage summary |

Aliases: `list` = `ls`, `remove`/`delete` = `rm`.

```text
$ /append-system ls

Append rules (inject: on) — 2 total, 2 active
  1. [on ] Never force-push to main
  2. [on ] Always answer in Chinese

rm N delete · on/off N toggle one · on/off global switch · edit N edit or view full text
```

`off` without arguments keeps your rules but stops injecting them, so you can park a rule set and bring it back later. The status bar shows `append-system: N rule(s)` while rules are active, and `append-system: off (N)` when parked — parked rules are never silently invisible.

In list output, `[on ]`/`[off]` is the per-rule state and `inject:` is the global switch.

## How it works

Rules are injected as a dedicated `dynamic_append` **system-prompt section** during pi's `before_agent_start` hook. Pi diffs prompt sections and sends only the changed ones as a single patch message, so:

- changes take effect on the next message — no `/reload`
- turning a rule off removes it properly (a `null` patch, not an empty tag left behind)
- because it uses a different section than `addendum`, it **stacks with** `APPEND_SYSTEM.md` and `--append-system-prompt` instead of overwriting them

It does not replace the default system prompt, does not touch tools, and does not modify `APPEND_SYSTEM.md`.

### State file

Rules live in `<agentDir>/append-system.json` — by default `~/.pi/agent/append-system.json`:

```json
{
  "enabled": true,
  "items": [
    {
      "text": "Never force-push to main",
      "enabled": true
    },
    {
      "text": "Always answer in Chinese",
      "enabled": true
    }
  ]
}
```

The file is read fresh on every agent start, so a hand-edit applies from your next message — though not mid-tool-loop, since `before_agent_start` fires per user prompt rather than per LLM request. It is an ordinary readable JSON file — hand-edit it, commit it, or manage it from another tool. The extension writes it atomically (temp file + rename) and moves an unparseable file to `append-system.json.bad` rather than overwriting it.

Note that writes replace the whole file, so if two pi processes modify rules simultaneously the last writer wins. Reads always see the latest state.

### Language

Command output, errors and the list view follow your system locale: `zh*` gets Simplified Chinese, everything else (including an unset `LANG`) gets English. Rule content is never translated. Checked in order: `LC_ALL`, `LC_MESSAGES`, `LANG`.

## Uninstall

```bash
pi remove git:github.com/onerentop/pi-append-system
```

The state file at `~/.pi/agent/append-system.json` is left in place — delete it manually if you want the rules gone too.

## Development

```bash
npm install
npm test        # unit tests + integration tests against pi's real loading and rendering path
npm run check   # tsc --noEmit
```

`test/unit.test.mjs` mocks the extension API and covers command parsing, state handling and locale switching. `test/render.test.mjs` loads the package through pi's own `discoverAndLoadExtensions` (which also validates the `pi` manifest) and asserts against pi's real system-prompt construction. Tests isolate state via `PI_CODING_AGENT_DIR`, so they never touch your real configuration.

Built on Node's native TypeScript type stripping — the extension ships as `.ts` and runs as-is, with no build step.

## Scope and safety

This extension only reads and writes one JSON file under your pi agent directory and registers two hooks plus one command. It runs no subprocesses and makes no network requests. It ships with no runtime dependencies — `@earendil-works/pi-coding-agent` is a peer dependency provided by pi.

## License

MIT
