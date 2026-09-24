# Changelog

## 0.3.0

Requires Pi 0.87.1 or newer.

- Added optional `typoFix.model` and `typoFix.thinking` settings in `~/.pi/agent/wtf.json`, without changing the session's model or thinking level.
- Displayed the provider/model and requested thinking level during typo-correction requests.
- Clarified typo-correction instructions and unified suggestion confirmation for local and model corrections.
- Validated configuration at load time; invalid configuration blocks model requests while preserving prompt recovery and local slash-command correction.
- Routed typo correction through Pi's model registry for transcript normalization and resolved authentication.
- Fixed recovery of unanswered prompts, including the first prompt in a session.
- Handled destructive recovery before Pi has written the session file, with rollback on failed or cancelled reloads.
- Added `/thinking` and `/bug` to local slash-command typo correction.
- Replaced private-method navigation mocks with public SDK session tests and added model-call regression coverage.
- Added TypeScript checking and CI against locked and latest Pi releases.

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

