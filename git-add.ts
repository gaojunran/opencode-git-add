import { access, appendFile } from "node:fs/promises"
import { execFile } from "node:child_process"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import type { Plugin, PluginInput, PluginOptions } from "@opencode-ai/plugin"

// Debug journal: every event the hook sees, with the decision taken.
// Safe to leave on; it only appends a few lines per event to a /tmp file.
const LOGFILE = "/tmp/opencode-git-add.log"
async function journal(line: string) {
  await appendFile(LOGFILE, `${new Date().toISOString()} ${line}\n`).catch(() => {})
}

// Dedup memory for message ids we already staged. The chat.message /
// prompt hooks fire exactly once per submission, so this is
// belt-and-suspenders — but it costs nothing and guards against future core
// changes. Ids are recorded only AFTER every skip check passes, so skipped
// messages can never poison the dedup state (a single "last seen" slot plus
// early recording is what caused spurious mid-turn staging in v0.6.0).
const STAGED_ID_LIMIT = 500

export interface GitAddOnNewTurnOptions {
  /**
   * Session titles matching any of these regexes are skipped (no git add).
   * Built-in subagent/injected-message skipping is structural and does not
   * rely on titles — child sessions are detected via their parentID in the
   * session DB, and injected messages via their synthetic/ignored parts — so
   * this option is only for your own title-based rules. Empty by default.
   */
  skipSessionTitlePatterns?: string[]
}

// ---------------------------------------------------------------------------
// v1 lane (opencode 1.x) — unchanged from v0.9.0
// ---------------------------------------------------------------------------

type PartWithFlags = { type: string; synthetic?: boolean; ignored?: boolean }

// A message counts as an injected (non-user) message when every part carries
// the synthetic or ignored flag. Real user input always has at least one
// unflagged text part. An empty parts array is treated as injected too:
// there is nothing to inspect, so skip rather than risk staging mid-turn.
function isInjected(parts: PartWithFlags[]): boolean {
  return parts.length === 0 || parts.every((p) => p.synthetic === true || p.ignored === true)
}

// At the start of each new turn (when the user submits a message), stage
// everything the previous turn left behind. The unstaged diff in the editor
// then always shows only the in-progress turn's changes.
//
// Trigger: the "chat.message" hook, which opencode fires exactly once per
// prompt submission — before the message is persisted and before any tool
// runs, and never again for later updates of the same message row. The
// previous trigger ("message.updated" for role=user) was fragile: opencode
// re-broadcasts that event whenever it recomputes a message's diff summary,
// and plugin-injected synthetic messages broadcast it too — the two combined
// into spurious mid-turn staging (fixed in v0.7.0; see README).
// Staging is a convenience, not a gate: git failures (most commonly a
// concurrent process holding .git/index.lock, which exits 128) must never
// kill the user's message. Retry briefly for lock contention, then give up,
// journal the real stderr and let the turn proceed.
const STAGING_ATTEMPTS = 3
const STAGING_RETRY_DELAY_MS = 500

async function stageChanges(
  $: PluginInput["$"],
  directory: string,
  messageID: string,
): Promise<boolean> {
  for (let attempt = 1; attempt <= STAGING_ATTEMPTS; attempt++) {
    const proc = await $`git add .`.cwd(directory).nothrow().quiet()
    if (proc.exitCode === 0) return true
    const stderr = proc.stderr.toString().trim()
    await journal(
      `git add attempt ${attempt}/${STAGING_ATTEMPTS} failed (dir=${directory}) exit=${proc.exitCode} stderr=${stderr} id=${messageID}`,
    )
    if (attempt < STAGING_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, STAGING_RETRY_DELAY_MS))
    }
  }
  return false
}

export const GitAddOnNewTurn: Plugin = async ({ directory, $, client }, options?: PluginOptions) => {
  const stagedMessageIDs = new Set<string>()

  const markStaged = (id: string) => {
    stagedMessageIDs.add(id)
    if (stagedMessageIDs.size > STAGED_ID_LIMIT) {
      const oldest = stagedMessageIDs.values().next().value
      if (oldest !== undefined) stagedMessageIDs.delete(oldest)
    }
  }

  const opts = (options ?? {}) as GitAddOnNewTurnOptions
  const skipSessionTitle = (opts.skipSessionTitlePatterns ?? []).map((p) => new RegExp(p))

  return {
    "chat.message": async (input, output) => {
      const id = output.message.id
      const sessionID = input.sessionID
      await journal(`chat.message id=${id} sessionID=${sessionID} parts=${output.parts.length}`)
      if (stagedMessageIDs.has(id)) {
        await journal(`skip: already staged id=${id}`)
        return
      }
      const hasGit = await access(join(directory, ".git")).then(
        () => true,
        () => false,
      )
      if (!hasGit) {
        await journal(`skip: no .git in ${directory}`)
        return
      }

      // Skip subagent turns: only real user turns in the main session should
      // trigger staging, otherwise staging happens mid-turn whenever the main
      // agent spawns a subagent (the task tool prompts the child session, and
      // chat.message fires there too). A session is a subagent when it has a
      // parentID in the session DB — a purely structural signal that also
      // covers child sessions like magic-context compartments, whose titles
      // never follow a convention. Earlier versions also skipped sessions
      // whose title matched "<description> (@<agent> subagent)"; that check
      // is redundant and gone, because the session store contains no
      // subagent session without a parentID. When the session cannot be
      // resolved, skip rather than risk staging at the wrong moment.
      const reply = await client.session
        .get({ path: { id: sessionID } })
        .catch(async (e: unknown) => {
          await journal(`session.get failed: ${String(e)}`)
          return undefined
        })
      const data = reply?.data
      if (!data) {
        await client.app
          .log({
            body: {
              service: "opencode-git-add",
              level: "warn",
              message: `could not resolve session ${sessionID}, skipping git add`,
            },
          })
          .catch(() => {})
        await journal(`skip: no session data for ${sessionID}`)
        return
      }
      const parentID = (data as { parentID?: string }).parentID
      if (parentID) {
        await journal(`skip: child session "${data.title ?? sessionID}" (parent=${parentID})`)
        return
      }
      for (const pattern of skipSessionTitle) {
        if (pattern.test(data.title ?? "")) {
          await journal(`skip: session title "${data.title}" matches ${pattern}`)
          return
        }
      }

      // Skip messages injected into a session by other plugins (e.g.
      // magic-context notices and summaries posted via session.prompt with
      // synthetic/ignored parts). They fire chat.message too — the hook is
      // shared by all API submissions — but their parts arrive inline here,
      // so a single synchronous check decides (no polling, no race).
      if (isInjected(output.parts as PartWithFlags[])) {
        await journal(`skip: injected synthetic/ignored message id=${id}`)
        return
      }

      // Record the id only now — after every skip check has passed.
      markStaged(id)

      await journal(`git add . (dir=${directory})`)

      const staged = await stageChanges($, directory, id)
      if (!staged) {
        await client.app
          .log({
            body: {
              service: "opencode-git-add",
              level: "warn",
              message: `git add . failed after ${STAGING_ATTEMPTS} attempts in ${directory}; continuing without staging`,
            },
          })
          .catch(() => {})
      }
    },
  }
}

// ---------------------------------------------------------------------------
// v2 lane (opencode 2.x) — precise tool-tracked staging
// ---------------------------------------------------------------------------
//
// The 2.x host activates ONLY the module's default export as an object
// `{ id, server, setup }` and calls `setup(context)` once at startup. The
// v1 named-function export is never invoked there (the bug v0.10.0 fixes).
//
// Mechanism (v2): track file paths touched by write/edit/apply_patch tool
// calls through the `execute.after` hook (from ALL sessions — subagent
// writes count as agent changes), then on the next main-session user prompt
// (`prompt` hook) run `git add -- <paths>` limited to exactly those paths,
// and clear the set. Turn with no tracked writes → nothing staged. This is
// deliberately NOT `git add .`: unrelated working-tree changes (e.g. the
// user's own edits) are never touched.
//
// The `prompt` hook fires only for real user submissions — the host does
// not fire it for plugin-injected synthetic messages (live-verified on
// 2.0.21), so no parts-based injected-message check is needed on this lane.

// Minimal local types for the v2 plugin context — the hosted API surface
// this lane touches. Deliberately declared here instead of guessed package
// types: the v2 context is still moving, and these mirror what
// `setup(context)` receives on opencode 2.0.21 (live-verified).

/** A session as returned by `session.get({ sessionID })` (envelope: `{data}` or direct). */
type V2Session = {
  parentID?: string
  title?: string
  location?: { directory?: string }
}

type V2PromptDraft = {
  sessionID: string
  messageID: string
  prompt: { text: string }
  delivery?: string
}

type V2ToolDraft = {
  sessionID: string
  tool: string
  input?: Record<string, unknown>
  status?: string
  // Present on apply_patch drafts when the host forwards the tool result:
  // metadata.files[].filePath is the absolute path of each file the patch
  // actually wrote — the authoritative source over patch-text parsing.
  result?: { metadata?: { files?: Array<{ filePath?: string }> } }
}

export type V2Context = {
  location?: { directory?: string }
  options?: GitAddOnNewTurnOptions
  session?: {
    hook: (name: "prompt", cb: (draft: V2PromptDraft) => Promise<void>) => Promise<unknown>
    get: (input: { sessionID: string }) => Promise<{ data?: V2Session } & V2Session>
  }
  tool?: {
    hook: (name: "execute.after", cb: (draft: V2ToolDraft) => Promise<void>) => Promise<unknown>
  }
}

export type V2PluginModule = {
  id: string
  server: Plugin
  setup: (context: V2Context) => Promise<void>
}

// Tools whose writes are tracked. write/edit carry the path directly in
// input.path; apply_patch carries no path field, so its paths come from the
// patch-text file headers, or from the result metadata files list when the
// host forwards it (authoritative over header parsing — see below).
const TRACKED_TOOLS = new Set(["write", "edit", "apply_patch"])

// apply_patch patch-text file-section headers. Every file section opens
// with one of these lines; `*** Begin Patch` / `*** End Patch` delimit the
// whole block and match neither regex.
const APPLY_PATCH_HEADER = /^\*\*\* (Update File|Add File|Delete File|Move to): (.*)$/
const APPLY_PATCH_RENAME = /^\*\*\* Rename File: (.*) to (.*)$/

function isInside(dir: string, abs: string): boolean {
  const root = resolve(dir)
  return abs === root || abs.startsWith(root + sep)
}

// Resolve a tool input path (absolute or relative to the project dir) and
// make sure it stays inside the project. Returns null for anything else.
function resolveTrackedPath(dir: string, p: string): string | null {
  const abs = isAbsolute(p) ? p : resolve(dir, p)
  return isInside(dir, abs) ? abs : null
}

/**
 * Extract the paths an apply_patch patchText touches: each file-section
 * header (`*** Update File:` / `*** Add File:` / `*** Delete File:`) plus
 * the rename forms — `*** Rename File: <a> to <b>` and the `*** Update
 * File: <a>` block followed by `*** Move to: <b>` — where BOTH the old and
 * the new path count as touched. Returns unique non-empty raw paths, later
 * resolved and validated like write/edit inputs.
 */
function patchTextPaths(patchText: string): string[] {
  const paths = new Set<string>()
  for (const line of patchText.split("\n")) {
    const rename = APPLY_PATCH_RENAME.exec(line)
    if (rename) {
      if (rename[1]) paths.add(rename[1])
      if (rename[2]) paths.add(rename[2])
      continue
    }
    const header = APPLY_PATCH_HEADER.exec(line)
    if (header && header[2]) paths.add(header[2])
  }
  return [...paths]
}

function execGit(dir: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd: dir }, (error, _stdout, stderr) => {
      if (error) {
        const err = error as NodeJS.ErrnoException
        const code = typeof err.code === "number" ? err.code : 1
        resolve({ code, stderr: stderr ?? "" })
        return
      }
      resolve({ code: 0, stderr: stderr ?? "" })
    })
  })
}

// Stage exactly the given paths (pathspec-limited — also stages deletions of
// now-missing files). Never lets a git failure kill the user's message.
async function stagePaths(directory: string, paths: string[], messageID: string): Promise<boolean> {
  const rel = paths.map((p) => relative(directory, p))
  for (let attempt = 1; attempt <= STAGING_ATTEMPTS; attempt++) {
    const { code, stderr } = await execGit(directory, ["add", "--", ...rel])
    if (code === 0) return true
    await journal(
      `v2 git add attempt ${attempt}/${STAGING_ATTEMPTS} failed (dir=${directory}) exit=${code} stderr=${stderr.trim()} id=${messageID}`,
    )
    if (attempt < STAGING_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, STAGING_RETRY_DELAY_MS))
    }
  }
  return false
}

/**
 * v2 lane entry point, called by the 2.x host with the hosted plugin context.
 * Registered once per server/project: pending paths accumulate per project
 * directory, and staging is gated on main-session user prompts.
 */
export async function setup(context: V2Context): Promise<void> {
  const pluginDir = context.location?.directory
  const opts = (context.options ?? {}) as GitAddOnNewTurnOptions
  const skipSessionTitle = (opts.skipSessionTitlePatterns ?? []).map((p) => new RegExp(p))

  // directory -> set of absolute paths touched by write/edit tools since the
  // last staging. Filled from ALL sessions (subagent writes count as agent
  // changes); drained only on a main-session prompt in that directory.
  const pendingByDir = new Map<string, Set<string>>()
  // sessionID -> project directory, lazily resolved via session.get.
  const sessionDirs = new Map<string, string>()
  const stagedMessageIDs = new Set<string>()

  const markStaged = (id: string) => {
    stagedMessageIDs.add(id)
    if (stagedMessageIDs.size > STAGED_ID_LIMIT) {
      const oldest = stagedMessageIDs.values().next().value
      if (oldest !== undefined) stagedMessageIDs.delete(oldest)
    }
  }

  const sessionDirectory = async (sessionID: string): Promise<string | undefined> => {
    const cached = sessionDirs.get(sessionID)
    if (cached) return cached
    const reply = await context.session
      ?.get({ sessionID })
      .catch(async (e: unknown) => {
        await journal(`v2 session.get failed: ${String(e)}`)
        return undefined
      })
    const session = (reply as { data?: V2Session } | undefined)?.data ?? reply
    const dir = session?.location?.directory ?? pluginDir
    if (dir) sessionDirs.set(sessionID, dir)
    return dir
  }

  await journal(`v2 setup() invoked dir=${pluginDir ?? "(none)"} options=${JSON.stringify(opts)}`)

  // 1) Track write/edit/apply_patch paths from every session.
  if (context.tool?.hook) {
    await context.tool.hook("execute.after", async (draft: V2ToolDraft) => {
      // status is present on failures; only completed writes count.
      if (draft.status && draft.status !== "completed") return
      if (!TRACKED_TOOLS.has(draft.tool)) return
      const dir = await sessionDirectory(draft.sessionID)
      if (!dir) {
        await journal(`v2 skip track: no directory for session ${draft.sessionID}`)
        return
      }
      // path -> tracking source. write/edit carry input.path directly;
      // apply_patch prefers the result metadata files list (the tool only
      // reports files it actually wrote) and falls back to parsing the
      // patch-text file headers.
      const touched = new Map<string, string>()
      if (draft.tool === "apply_patch") {
        const metaFiles = draft.result?.metadata?.files
        if (Array.isArray(metaFiles) && metaFiles.length > 0) {
          for (const f of metaFiles) {
            if (typeof f?.filePath !== "string" || f.filePath.length === 0) continue
            touched.set(f.filePath, "metadata")
          }
        } else {
          const text = draft.input?.patchText
          if (typeof text === "string" && text.length > 0) {
            for (const p of patchTextPaths(text)) touched.set(p, "patchText")
          }
        }
        if (touched.size === 0) {
          await journal(
            `v2 untracked: apply_patch with no extractable paths, skipped (sessionID=${draft.sessionID})`,
          )
          return
        }
      } else {
        const p = draft.input?.path
        if (typeof p !== "string" || p.length === 0) return
        touched.set(p, "input.path")
      }
      for (const [p, source] of touched) {
        const abs = resolveTrackedPath(dir, p)
        if (!abs) {
          await journal(`v2 skip track: path outside project dir=${dir} path=${p}`)
          continue
        }
        let set = pendingByDir.get(dir)
        if (!set) {
          set = new Set()
          pendingByDir.set(dir, set)
        }
        set.add(abs)
        await journal(
          `v2 track tool=${draft.tool} sessionID=${draft.sessionID} src=${source} dir=${dir} path=${relative(dir, abs)}`,
        )
      }
    })
  }

  // 2) Stage on the next main-session user prompt.
  if (context.session?.hook) {
    await context.session.hook("prompt", async (draft: V2PromptDraft) => {
      const sessionID = draft.sessionID
      const id = draft.messageID
      await journal(`v2 prompt id=${id} sessionID=${sessionID}`)
      if (stagedMessageIDs.has(id)) {
        await journal(`v2 skip: already staged id=${id}`)
        return
      }
      const reply = await context.session
        ?.get({ sessionID })
        .catch(async (e: unknown) => {
          await journal(`v2 session.get failed: ${String(e)}`)
          return undefined
        })
      const data = (reply as { data?: V2Session } | undefined)?.data ?? reply
      if (!data) {
        console.warn(`[opencode-git-add] could not resolve session ${sessionID}, skipping git add`)
        await journal(`v2 skip: no session data for ${sessionID}`)
        return
      }
      // Skip subagent turns — same structural parentID signal as the v1
      // lane; the prompt hook fires in child sessions too (live-verified).
      const parentID = data.parentID
      if (parentID) {
        await journal(`v2 skip: child session "${data.title ?? sessionID}" (parent=${parentID})`)
        return
      }
      for (const pattern of skipSessionTitle) {
        if (pattern.test(data.title ?? "")) {
          await journal(`v2 skip: session title "${data.title}" matches ${pattern}`)
          return
        }
      }
      const dir = data.location?.directory ?? pluginDir
      if (!dir) {
        await journal(`v2 skip: no directory for ${sessionID}`)
        return
      }
      const hasGit = await access(join(dir, ".git")).then(
        () => true,
        () => false,
      )
      if (!hasGit) {
        await journal(`v2 skip: no .git in ${dir}`)
        return
      }
      const set = pendingByDir.get(dir)
      if (!set || set.size === 0) {
        await journal(`v2 skip: nothing to stage in ${dir}`)
        return
      }
      // Record the id only now — after every skip check has passed.
      markStaged(id)

      const paths = [...set]
      await journal(`v2 git add ${paths.length} path(s) in ${dir}: ${paths.map((p) => relative(dir, p)).join(", ")}`)
      const staged = await stagePaths(dir, paths, id)
      if (staged) {
        pendingByDir.delete(dir)
      } else {
        // Keep the set: the next main-session prompt retries (mirrors the
        // v1 lane, where a failing turn leaves the diff unstaged for the
        // next attempt). Never block the message.
        console.warn(
          `[opencode-git-add] git add failed after ${STAGING_ATTEMPTS} attempts in ${dir}; continuing without staging`,
        )
      }
    })
  }
}

export default {
  id: "opencode-git-add",
  server: GitAddOnNewTurn,
  setup,
} satisfies V2PluginModule