# Changelog

## 1.0.1

- restore the original command behavior in two places that were changed during
  the 1.0.0 review pass: out-of-range messages keep the `1-N` wording (which
  reads `1-0` when there are no rules), and repeated indexes count once per
  occurrence instead of being deduplicated

## 1.0.0

Initial release.

- `/append-system add|edit|rm|on|off|clear|ls|help` — manage system-prompt append rules at runtime
- rules persist in `<agentDir>/append-system.json`, written atomically (temp file + rename); an unparseable file is moved aside as `.bad` instead of being silently overwritten
- injected as the `dynamic_append` system-prompt section, so changes land on the next message without `/reload`
- stacks with `APPEND_SYSTEM.md` and `--append-system-prompt` instead of overwriting them
- bilingual output (Simplified Chinese / English) selected from `LC_ALL`, `LC_MESSAGES`, `LANG`
- zero runtime dependencies — `@earendil-works/pi-coding-agent` is a peer provided by pi
