# Changelog

## 2.0.1

- subcommand completions now carry a one-line description each, so typing
  `/append-system ` shows what every subcommand does
- the command description lists all subcommands (`ls add edit rm on off clear
  help`), because pi only shows the command line itself until you type a space —
  extension commands have no `argumentHint` support in pi

## 2.0.0

**BREAKING — the mechanism changed.** The extension now manages pi's native
`APPEND_SYSTEM.md` instead of injecting a live `dynamic_append` section.

- enabled rules are rendered into `<agentDir>/APPEND_SYSTEM.md` (pi's canonical
  addendum channel); changes take effect on `/reload` or a new session
- the per-turn `before_agent_start` hook is gone — the extension no longer alters
  the prompt at runtime, it is purely an editor for `APPEND_SYSTEM.md`
- `append-system.json` stays as the structured ledger (rules + enabled flags);
  the enabled ones are concatenated into `APPEND_SYSTEM.md`
- first-time takeover backs up a pre-existing hand-written `APPEND_SYSTEM.md` to
  `.bak` before writing (an existing `.bak` is never overwritten)
- global `off` / `clear` / all-disabled removes `APPEND_SYSTEM.md`
- every mutating command reminds you to `/reload`

Same command surface (`add|edit|rm|on|off|clear|ls|help`), aliases, bilingual
output, atomic writes, and `.bad` backup of a corrupt ledger.

To keep the previous real-time behavior, pin `@v1`.

## 1.0.1

- restore the original command behavior in two places that were changed during
  the 1.0.0 review pass: out-of-range messages keep the `1-N` wording (which
  reads `1-0` when there are no rules), and repeated indexes count once per
  occurrence instead of being deduplicated

## 1.0.0

Initial release (live `dynamic_append` section injection, real-time, no /reload).

- `/append-system add|edit|rm|on|off|clear|ls|help` — manage system-prompt append rules at runtime
- rules persist in `<agentDir>/append-system.json`, written atomically; an unparseable file is moved aside as `.bad`
- injected as the `dynamic_append` system-prompt section
- bilingual output (Simplified Chinese / English)
- zero runtime dependencies
