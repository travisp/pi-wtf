# Changelog

## 0.2.5

Requires Pi 0.84.3 or newer.

- Preserved the recovered conversation position across destructive session reloads, including branched and empty conversations.
- Restored the recovered prompt in the replacement session's editor.
- Repaired surviving parent links when deleting labels that refer to removed entries.
- Unblocked recovery after failed or cancelled compaction.
- Added command-lifecycle regression tests using Pi's navigation and session-file reader.

## 0.2.4

- Updated typo correction to use Pi's effective provider and resolved authentication.
- Made destructive rewrites atomic, permission-preserving, and reversible when session replacement is cancelled or fails.
- Prevented recovery commands from silently dropping image attachments.
- Simplified configuration and session replacement logic.
- Added automated tests and a reproducible Devbox development environment.

## 0.2.3

- Updated direct Pi package imports and peer dependencies from `@mariozechner` to `@earendil-works`.
- Regenerated `package-lock.json` for the new Pi package scope.

