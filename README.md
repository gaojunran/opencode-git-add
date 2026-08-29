# opencode-git-add

An [opencode](https://opencode.ai) plugin that runs `git add .` at the start of every new conversation turn, in any git repository.

## Motivation

Zed's per-turn agent diff view (the accordion above the agent panel showing what the agent changed in each turn) no longer exists for external ACP-connected agents.

In [zed-industries/zed#54918](https://github.com/zed-industries/zed/issues/54918) ("Agents' turn diffs disappeared from Zed"), the Zed team confirmed this is unlikely to come back. The blocker is at the ACP protocol level: the agent's changes are not attributable to a specific turn, because agents typically write directly through the filesystem and ACP cannot distinguish user edits from agent edits.

The maintainers pointed to [zed-industries/zed#26560](https://github.com/zed-industries/zed/issues/26560) ("Staged and Unstaged diffs") as the viable alternative: a long-requested feature to view unstaged diffs separately in the git panel.

This plugin implements the workflow that makes #26560 usable for reviewing a single turn's changes:

1. While a turn is running, the agent's changes accumulate as unstaged changes in the working tree.
2. When the turn finishes, you review its diff in the editor's unstaged diff view — nothing has been touched yet.
3. When you start the next turn, the plugin stages everything at that moment (`git add .`), freezing the previous turn's changes out of the unstaged view.
4. The unstaged diff now holds only the new turn's changes again — the per-turn review surface that the agent panel diff used to provide.

Timing matters: staging happens at the **start** of the next turn, never at the end of the current one. Staging right after a turn finishes would make the changes you want to review disappear into the staged set before you had a chance to look at them.

### Who is this for

The plugin fits jujutsu users naturally: jj has no staging area, so staging has no meaning there and auto-running `git add .` interferes with nothing — the plugin simply leaves a clean snapshot boundary between turns.

Plain git users who rely on the staging area should be aware: if you curate commits by selectively staging files (e.g. `git add <file>` before committing only some changes), this plugin will destroy that workflow, because everything gets staged automatically at the start of every turn. It is only a good fit if you always commit everything at once anyway.

## Why a plugin instead of config

opencode's `opencode.json` has no native hook/event support (see the [config schema](https://opencode.ai/config.json)). Timing hooks like "at the start of each turn" are only possible through the [plugin hook system](https://opencode.ai/docs/plugins/). This plugin uses the `chat.message` hook, which fires exactly once per prompt submission — before the message is persisted and before any tool runs.

## Installation

### npm (this package)

Add it to the `plugin` array in `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-git-add"]
}
```

Optional configuration, as an options tuple (see [plugins docs](https://opencode.ai/docs/plugins/)):

```json
{
  "plugin": [
    [
      "opencode-git-add",
      {
        "skipSessionTitlePatterns": ["^my-plugin-"]
      }
    ]
  ]
}
```

`skipSessionTitlePatterns` takes an array of regex strings; sessions whose title matches any of them are skipped. It is **empty by default** — the injected-message check below already covers every known source (magic-context, slim and opencode's own task machinery all mark their injected parts `synthetic`/`ignored`), so this option is only needed for exotic sessions whose messages cannot be inspected.

### Manual

Drop `git-add.ts` into the global plugin directory (applies to all projects), or into a project's `.opencode/plugins/`:

```sh
mkdir -p ~/.config/opencode/plugins
cp git-add.ts ~/.config/opencode/plugins/
```

Restart opencode afterwards — configuration is only loaded at startup. No changes to `opencode.json` are required when installing manually.

## Behavior

- **Trigger:** the `chat.message` hook — the moment you submit a new prompt and a new turn begins. opencode fires it exactly once per submission, before the message is persisted and before the agent starts doing anything, and never re-fires it when the message row is later updated (e.g. diff-summary recomputation). Earlier versions listened to the `message.updated` bus event instead, which opencode re-broadcasts on every summary update — combined with plugin-injected synthetic messages, that could cause spurious mid-turn staging (fixed in v0.7.0).
- **Main sessions only:** subagent sessions are skipped. Two checks: opencode titles a subagent session `<description> (@<agent> subagent)` (the same signal the TUI uses), and structurally, any session with a parent session is skipped — which also covers child sessions whose titles don't match the convention (e.g. magic-context compartments). If the session cannot be resolved (e.g. an API hiccup), the plugin skips and logs a warning instead of staging at a wrong moment.
- **No injected messages:** opencode plugins can inject user-role messages into a session via the server API (e.g. magic-context's progress notices and summary posts), and those fire `chat.message` too. The hook carries the message's parts inline, so the plugin skips staging synchronously when every part carries the `synthetic` or `ignored` flag (or when there are no parts to inspect) — real user input always has at least one unflagged text part.
- **Dedup:** the same message ID only triggers once, and skipped messages never record into the dedup set, so injected messages cannot interfere with real turns.
- **Guard:** runs only when a `.git` directory exists in the plugin's working directory (this includes jujutsu colocated working copies). Non-git directories are skipped.
- **Action:** `git add .` in the working directory, without recursing into nested projects.

## Verification

`scripts/verify.ts` covers 13 scenarios: main-session user message with real parts in a plain git repo → staged; subagent session title → skipped; session with a `parentID` (task-tool subagents, magic-context compartments) → skipped; session lookup 404 / rejected → skipped without error; only `.jj` → skipped; injected messages (synthetic-only parts, ignored-only parts, empty parts) → skipped; same message id fired twice → staged only once; a skipped synthetic message followed by a real message → still staged (dedup cannot be poisoned); user-configured `skipSessionTitlePatterns` → skipped; mixed synthetic + real parts → staged. Run with:

```sh
bun scripts/verify.ts
```

## License

MIT
## Debugging

The hook journals every event it sees and the decision taken to
`/tmp/opencode-git-add.log` (append-only, safe to leave on). When reporting a
misbehaviour, include that file — it shows exactly which events fired, in what
order, and whether staging ran.
