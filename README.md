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

opencode's `opencode.json` has no native hook/event support (see the [config schema](https://opencode.ai/config.json)). Timing hooks like "at the start of each turn" are only possible through the [plugin event system](https://opencode.ai/docs/plugins/#events), which exposes `message.updated`.

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

- **Trigger:** `message.updated` for a user message — i.e. the moment you submit a new prompt and a new turn begins. The plugin stages whatever the previous turn left in the working tree before the agent starts doing anything (the event fires on message creation, ahead of any tool execution).
- **Main sessions only:** subagent sessions are skipped. opencode titles a subagent session `<description> (@<agent> subagent)` (the same signal the TUI uses to detect them), and the plugin resolves the message's session before staging, so turns spawned by the `task` tool mid-turn never trigger a staging. If the session cannot be resolved (e.g. an API hiccup), the plugin skips and logs a warning instead of staging at a wrong moment.
- **No injected messages:** opencode plugins can inject synthetic user messages into a session (e.g. magic-context's progress notices and summary posts), which broadcast the same `message.updated` event as a real user turn. The plugin looks the triggering message up via the session API and skips staging when every part carries the `synthetic` or `ignored` flag — real user input always has at least one unflagged text part.
- **Dedup:** the same user message ID only triggers once (opencode may re-emit an update for the same message, e.g. when its summary changes).
- **Guard:** runs only when a `.git` directory exists in the plugin's working directory (this includes jujutsu colocated working copies). Non-git directories are skipped.
- **Action:** `git add .` in the working directory, without recursing into nested projects.

## Verification

`scripts/verify.ts` covers 15 scenarios: main-session user message in a plain git repo → staged; subagent session (title ending in `(@agent subagent)`) → skipped; session lookup 404 / rejected → skipped without error; a magic-context-style injected message → skipped by the parts check regardless of session title; only `.jj` / neither → skipped; assistant `message.updated` → no-op; duplicate user message id → staged only once; unrelated event types → no-op. Injected-message detection is covered for synthetic-only parts, ignored-only parts, and real user input with plain text parts; a user-configured `skipSessionTitlePatterns` → skipped; messages lookup with parts never appearing / rejected → skipped without error. Run with:

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
