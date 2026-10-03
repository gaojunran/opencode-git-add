# opencode-git-add

An [opencode](https://opencode.ai) plugin that freezes the previous turn's agent changes out of the unstaged diff at the start of every new conversation turn, so the unstaged diff always shows only the in-progress turn's changes.

- **opencode 2.x (v2 lane):** stages **exactly the files agent tools touched** since the last turn — `git add -- <paths>` per project directory, tracked from `write`/`edit`/`apply_patch` tool calls across all sessions (main and subagent).
- **opencode 1.x (v1 lane):** stages everything (`git add .`) at the start of each main-session turn, as in v0.9.0.

## Motivation

Zed's per-turn agent diff view (the accordion above the agent panel showing what the agent changed in each turn) no longer exists for external ACP-connected agents.

In [zed-industries/zed#54918](https://github.com/zed-industries/zed/issues/54918) ("Agents' turn diffs disappeared from Zed"), the Zed team confirmed this is unlikely to come back. The blocker is at the ACP protocol level: the agent's changes are not attributable to a specific turn, because agents typically write directly through the filesystem and ACP cannot distinguish user edits from agent edits.

The maintainers pointed to [zed-industries/zed#26560](https://github.com/zed-industries/zed/issues/26560) ("Staged and Unstaged diffs") as the viable alternative: a long-requested feature to view unstaged diffs separately in the git panel.

This plugin implements the workflow that makes #26560 usable for reviewing a single turn's changes:

1. While a turn is running, the agent's changes accumulate as unstaged changes in the working tree.
2. When the turn finishes, you review its diff in the editor's unstaged diff view — nothing has been touched yet.
3. When you start the next turn, the plugin stages what the previous turn left behind, freezing those changes out of the unstaged view.
4. The unstaged diff now holds only the new turn's changes again — the per-turn review surface that the agent panel diff used to provide.

Timing matters: staging happens at the **start** of the next turn, never at the end of the current one. Staging right after a turn finishes would make the changes you want to review disappear into the staged set before you had a chance to look at them.

### Who is this for

The plugin fits jujutsu users naturally: jj has no staging area, so staging has no meaning there and auto-running `git add` interferes with nothing — the plugin simply leaves a clean snapshot boundary between turns.

Plain git users who rely on the staging area should be aware: if you curate commits by selectively staging files (e.g. `git add <file>` before committing only some changes), this plugin will destroy that workflow, because agent-written files get staged automatically at the start of every turn. It is only a good fit if you always commit everything at once anyway.

## How it works on opencode 2.x (v0.10.0+)

The 2.x host activates plugins through the module's **default export** — an object `{ id, server, setup }` — and calls `setup(context)` once per server startup with a hosted plugin context. (The v0.9.0 named-function export is never invoked on 2.x; v0.10.0 fixes that by shipping both lanes.)

Two hooks drive the v2 lane:

- **Track** — `context.tool.hook("execute.after", ...)`: after every completed `write`/`edit`/`apply_patch` tool call (in any session, subagent included), the touched file paths are recorded in a per-project-directory set. `write`/`edit` contribute `input.path` (relative or absolute); `apply_patch` contributes the result-metadata files list when the host forwards it (`result.metadata.files[].filePath`, authoritative) and otherwise the paths parsed from the patch-text file headers (`*** Update File:` / `*** Add File:` / `*** Delete File:` / `*** Rename File: <a> to <b>` / `*** Move to:` — rename forms count both the old and the new path). Drafts whose `status` is present and not `"completed"` are ignored, as are paths resolving outside the project directory.
- **Stage** — `context.session.hook("prompt", ...)`: fires once per real user prompt submission, before any tool runs. If the current main session's directory has a non-empty tracked set, the plugin runs `git add -- <paths>` (a single pathspec-limited command — this also stages deletions of now-missing files), then clears the set. If the set is empty, nothing runs at all.

Guards on the v2 lane (mirroring the v1 lane): the session is resolved via `context.session.get({ sessionID })` and staging is skipped for child sessions (any session with a `parentID`, e.g. subagents spawned by the task tool — their own prompts never stage) and for sessions whose title matches a configured pattern; the `.git` existence check applies per session directory; and the same message id only ever triggers once. Staging never kills your message: git failures (most commonly `.git/index.lock` contention, exit 128) are retried 3 times with 500ms between attempts, then reported and the turn proceeds anyway.

One documented limitation of precise (path-tracked) staging:

- **bash write is invisible.** Any file changed through a `bash` tool call (or any non-`write`/`edit`/`apply_patch` tool) is not tracked and will not be staged by the next turn — the per-turn boundary then simply does not apply to that file until a later `write`/`edit`/`apply_patch` touches it.

Injected messages are not an issue on this lane: the host fires the `prompt` hook only for real submissions. Plugin injections via `context.session.synthetic` (how magic-context posts its nudges) do **not** fire the hook (live-verified on 2.0.21), and explicit `context.session.prompt` submissions are indistinguishable from a user prompt by design — exactly like an unflagged API submission on the v1 lane.

**Options on 2.x:** the config tuple form (`["opencode-git-add", {...}]`) is not accepted by the 2.0.21 config loader for `file:` specs — declare plugins as plain strings. `context.options` is read when the host provides it, so `skipSessionTitlePatterns` works as soon as (and wherever) the host passes options through; on 1.x it is passed via the options tuple as before.

## Why a plugin instead of config

opencode's `opencode.json` has no native hook/event support (see the [config schema](https://opencode.ai/config.json)). Timing hooks like "at the start of each turn" are only possible through the [plugin hook system](https://opencode.ai/docs/plugins/).

## Installation

### npm (this package)

Add it to the `plugin` array in `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-git-add"]
}
```

Optional configuration on 1.x hosts, as an options tuple (see [plugins docs](https://opencode.ai/docs/plugins/)):

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

`skipSessionTitlePatterns` takes an array of regex strings; sessions whose title matches any of them are skipped. It is **empty by default** — child-session skipping is structural (the session-DB `parentID`), and injected messages are skipped structurally too, so this option is only needed for exotic session-title rules of your own.

### Manual

Drop `git-add.ts` into the global plugin directory (applies to all projects), or into a project's `.opencode/plugins/`:

```sh
mkdir -p ~/.config/opencode/plugins
cp git-add.ts ~/.config/opencode/plugins/
```

Restart opencode afterwards — configuration is only loaded at startup. No changes to `opencode.json` are required when installing manually.

## Behavior

### v2 lane (opencode 2.x) — precise tool-tracked staging

- **Trigger:** the `prompt` hook — fires once per user prompt submission, before the message is processed and before any tool runs (live-verified on 2.0.21).
- **Tracked writes:** `write`/`edit`/`apply_patch` tool calls from **every** session in the project directory, subagents included. (`apply_patch` paths come from the result metadata files when the host forwards them, else from the patch-text file headers — see above.) The set is drained only by a **main-session** prompt (`parentID` absent), so a subagent's writes are staged by the next main-session turn — never mid-turn.
- **Precision:** `git add -- <paths>` — only files the tools actually touched are ever staged; a `git add .` never runs. Files you edited yourself in the working tree stay unstaged.
- **Empty turns stage nothing:** if no tracked writes accumulated since the last staging, the prompt hook returns without running git at all.
- **Dedup:** the same message ID only triggers once.
- **Guard:** runs only when a `.git` directory exists in the session's directory (includes jujutsu colocated working copies). Non-git directories are skipped.
- **Never blocks your message:** git failures are retried up to 3 times with 500ms between attempts, then a warning (`console.warn` + journal) and the turn proceeds anyway. A failed staging keeps the tracked set, so the next main-session prompt retries.
- **Session resolution:** `context.session.get({ sessionID })`; if the session cannot be resolved, staging is skipped with a warning rather than risking a wrong-moment stage.

### v1 lane (opencode 1.x) — unchanged from v0.9.0

- **Trigger:** the `chat.message` hook — exactly once per prompt submission, before the message is persisted and before any tool runs. (The older `message.updated` trigger re-broadcast on every diff-summary recomputation and picked up plugin-injected synthetic messages — that caused spurious mid-turn staging and was fixed in v0.7.0.)
- **Main sessions only:** child sessions are skipped via the session-DB `parentID` — a structural signal that also covers children whose titles never follow a convention (e.g. magic-context compartments).
- **No injected messages:** messages whose parts all carry the `synthetic`/`ignored` flag (or that have no parts) are skipped synchronously.
- **Action:** `git add .` in the plugin's working directory, without recursing into nested projects. (The v1 lane cannot know which files a tool touched, so it stages everything — the per-turn boundary is what matters there.)
- Guard, dedup and never-block semantics: same as the v2 lane, with warnings via `client.app.log`.

## Verification

`scripts/verify.ts` covers 29 scenarios with real git repositories:

- v1 lane (1–14): main-session user message with real parts in a plain git repo → staged; subagent-style session title without a `parentID` → still staged; session with a `parentID` → skipped; session lookup 404 / rejected → skipped without error; only `.jj` → skipped; injected messages (synthetic-only, ignored-only, empty parts) → skipped; same message id fired twice → staged only once; a skipped synthetic message followed by a real one → still staged (dedup cannot be poisoned); user-configured `skipSessionTitlePatterns` → skipped; mixed synthetic + real parts → staged; `git add .` failing while `.git/index.lock` is held → retries, does not throw, and a later turn stages normally.
- v2 lane (15–29): a `write` tracked from a main session is staged by the next prompt **exactly** (a manually edited file is never staged); a subagent's `edit` with an absolute path is tracked, the child's own prompt does not stage, the next main prompt does; a turn with no tracked writes stages nothing; a tool draft with `status` ≠ `"completed"` is not tracked; a path resolving outside the project is not tracked; `apply_patch` patch-text headers are tracked and staged exactly; `apply_patch` with all header forms (update/add/delete/rename-file/move-to — old and new rename sides included); garbage `patchText` (no parseable headers) is not tracked; empty result metadata falls back to `patchText` (journaled `src=patchText`); result metadata files are authoritative over header parsing (journaled `src=metadata`); message-id dedup; title-pattern option via `context.options`; session lookup failure skips without error; no `.git` skips without error; staging failure with a held `index.lock` retries 3 times without throwing, and a later prompt stages normally.

Run with:

```sh
bun scripts/verify.ts
```

## License

MIT

## Debugging

The plugin journals every hook event and the decision taken to
`/tmp/opencode-git-add.log` (append-only, safe to leave on). v2-lane lines are
prefixed `v2 `. When a staging failure is retried, the failing attempt count,
exit code and **git stderr** are journaled too. When reporting a misbehaviour,
include that file — it shows exactly which events fired, in what order,
whether staging ran, and why it failed.