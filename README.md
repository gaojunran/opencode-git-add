# opencode-git-add

An [opencode](https://opencode.ai) plugin that runs `git add .` after every finished conversation turn, in any git repository.

## Motivation

Zed's per-turn agent diff view (the accordion above the agent panel showing what the agent changed in each turn) no longer exists for external ACP-connected agents.

In [zed-industries/zed#54918](https://github.com/zed-industries/zed/issues/54918) ("Agents' turn diffs disappeared from Zed"), the Zed team confirmed this is unlikely to come back. The blocker is at the ACP protocol level: the agent's changes are not attributable to a specific turn, because agents typically write directly through the filesystem and ACP cannot distinguish user edits from agent edits.

The maintainers pointed to [zed-industries/zed#26560](https://github.com/zed-industries/zed/issues/26560) ("Staged and Unstaged diffs") as the viable alternative: a long-requested feature to view unstaged diffs separately in the git panel.

This plugin implements the workflow that makes #26560 usable for reviewing a single turn's changes:

1. When a turn finishes, the plugin immediately stages everything (`git add .`) in the working directory.
2. The staged set now represents the work of completed turns; the unstaged diff in Zed only ever contains changes made since the last turn ended.
3. So at any moment, the unstaged diff view shows exactly what the current turn has changed so far — the per-turn review surface that the agent panel diff used to provide.

### Who is this for

The plugin fits jujutsu users naturally: jj has no staging area, so staging has no meaning there and auto-running `git add .` interferes with nothing — the plugin simply leaves a clean snapshot boundary between turns.

Plain git users who rely on the staging area should be aware: if you curate commits by selectively staging files (e.g. `git add <file>` before committing only some changes), this plugin will destroy that workflow, because everything gets staged automatically at the end of every turn. It is only a good fit if you always commit everything at once anyway.

## Why a plugin instead of config

opencode's `opencode.json` has no native hook/event support (see the [config schema](https://opencode.ai/config.json)). Timing hooks like "after each turn" are only possible through the [plugin event system](https://opencode.ai/docs/plugins/#events), which exposes `session.idle`.

## Installation

### npm (this package)

Add it to the `plugin` array in `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-git-add"]
}
```

### Manual

Drop `git-add.ts` into the global plugin directory (applies to all projects), or into a project's `.opencode/plugins/`:

```sh
mkdir -p ~/.config/opencode/plugins
cp git-add.ts ~/.config/opencode/plugins/
```

Restart opencode afterwards — configuration is only loaded at startup. No changes to `opencode.json` are required when installing manually.

## Behavior

- **Trigger:** `session.idle` — fires after each turn completes when the session becomes idle. `git add .` is idempotent, so the extra trigger on session creation is harmless.
- **Guard:** runs only when a `.git` directory exists in the plugin's working directory (this includes jujutsu colocated working copies). Non-git directories are skipped.
- **Action:** `git add .` in the working directory, without recursing into nested projects.

## Verification

`scripts/verify.ts` covers 5 scenarios: plain git repo → changes get staged; colocated jj repo (.git + .jj) → staged; only `.jj` / neither → skipped without error; non-`session.idle` events → no-op. Run with:

```sh
bun scripts/verify.ts
```

## License

MIT