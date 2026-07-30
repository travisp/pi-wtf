# pi-wtf [![NPM Version](https://img.shields.io/npm/v/pi-wtf)](https://www.npmjs.com/package/pi-wtf)

A small [pi](https://github.com/earendil-works/pi) extension for the moment you realize you messed up.

`/fuck` aborts the current run if needed, rewinds to before the most recent user prompt on the active branch, and restores that prompt into the editor so you can fix it and resubmit.

`/fuck?` does the same recovery, then suggests a conservative typo-only correction and lets you choose whether to use it. Note that this uses your currently configured model.

`/fuck!` destructively rewrites the current session file to remove the most recent user prompt and everything below it, then reloads that same session and restores the prompt into the editor. Note: use this at your own risk! In particular, if you for some reason have the same session file open in multiple processes, the effects may be unpredictable.

_Inspired by the great [thefuck](https://github.com/nvbn/thefuck)._

## Install

Install from npm:

```bash
pi install npm:pi-wtf
```

Install from GitHub:

```bash
pi install git:github.com/travisp/pi-wtf
```

Quick one-off test:

```bash
pi -e git:github.com/travisp/pi-wtf
```

## Usage

Inside pi:

```text
/fuck
/fuck?
/fuck!
```

**What `/fuck` does:**

1. Aborts the current agent run if one is active
2. Finds the most recent real user message on the active branch
3. Rewinds to just before that prompt
4. Restores the prompt into the editor

**What `/fuck?` does:**

Runs the same recovery as `/fuck`, but then checks for typos:
- checks for /command typos directly
- checks for typos by asking the current model

If found, it shows the suggestion and asks if the user wants to use the suggestion instead.

**What `/fuck!` does:**

Runs the same recovery as `/fuck`, but then destructively removes that prompt and its descendant subtree from the current session file.

After `/fuck!` succeeds, or after tree navigation, it becomes unavailable until another real user prompt is sent. It is intended to only be used once to remove a clear mistake, not as general session history editing.

## Why?

If you've ever typed a message out and only realized after you sent it that you messed up (a typoe, a missing word, whatever), found yourself cursing, canceling the run, and then navigating back through the /tree to your last spot, this extension is for you. Since many of these situations are just mistakes and there's no reason to keep history of them, /fuck! allows you to keep a cleaner session tree to navigate, and /fuck? allows you to save a little time when you've made a minor typo that this tool can autocorrect.

It can also be used as a general /rewind style tool when the agent is doing something you don't want and you want to retry with a new message (or just retry).

## Configuration

You can replace the command word globally with `~/.pi/agent/wtf.json`:

```json
{
  "words": ["oops"]
}
```

After restarting or running `/reload`, the registered commands become:

```text
/oops
/oops?
/oops!
```

`words` replaces the defaults; it does not add aliases. Each word must contain only letters, numbers, underscores, or hyphens.

If the config file is missing, invalid, or contains no valid words, pi-wtf falls back to `fuck`.

Recommended alternatives if you work in a joyless environment that doesn't understand humor: oops, doh, ffs.

You can always ask pi to read the README and change the setting itself.

## Limitations

- It works on the **active branch only**
- It does **not** undo file or external side effects
- It does **not** restore prompts with image attachments; use `/tree` for those prompts
- It does **not** work when queued messages exist
- It does **not** work when compaction is running
- The typo command requires the current model to support tool calling and have usable credentials
- The destructive command only works immediately during or after a real user prompt; succeeding or navigating the tree makes it unavailable until another prompt is sent
- The destructive command is **destructive** and rewrites the current session file in place

**IT DOES NOT UNDO FILE SYSTEM OR OTHER EXTERNAL SIDE EFFECTS**

## Improvements under consideration

- undo file changes (or recommending/working with a different extension)
- /unfuck -> undo your /fuck (with the limitation that aborted agent runs can't be truly continued)
- allow it to work with queued messages or compaction (may require upstream changes or patching pi)
- more prompt repair helpers, e.g. `/fuck append ...`, `/fuck s/old/new/`, or `/fuck edit ...`

## Development

Use the Devbox environment, then run the checks:

```bash
devbox shell
npm install
npm run check
```

## License

MIT
