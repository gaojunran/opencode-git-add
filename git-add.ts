import { access, appendFile } from "node:fs/promises"
import { join } from "node:path"
import type { Plugin, PluginOptions } from "@opencode-ai/plugin"

// Debug journal: every event the hook sees, with the decision taken.
// Safe to leave on; it only appends a few lines per event to a /tmp file.
const LOGFILE = "/tmp/opencode-git-add.log"
async function journal(line: string) {
  await appendFile(LOGFILE, `${new Date().toISOString()} ${line}\n`).catch(() => {})
}

// Subagent sessions are titled "<description> (@<agent> subagent)" by
// opencode's task tool — same signal the TUI uses to detect them.
const SUBAGENT_TITLE = /@[\w-]+ subagent\)?$/i

// Dedup memory for message ids we already staged. The chat.message hook
// fires exactly once per submission, so this is belt-and-suspenders — but it
// costs nothing and guards against future core changes. Ids are recorded
// only AFTER every skip check passes, so skipped messages can never poison
// the dedup state (a single "last seen" slot plus early recording is what
// caused spurious mid-turn staging in v0.6.0).
const STAGED_ID_LIMIT = 500

export interface GitAddOnNewTurnOptions {
  /**
   * Session titles matching any of these regexes are skipped (no git add).
   * This is only needed for sessions the injected-message check below cannot
   * see into; every known injected-message source (magic-context, slim and
   * opencode's own task machinery) marks its parts synthetic/ignored and is
   * already skipped by that check. Empty by default.
   */
  skipSessionTitlePatterns?: string[]
}

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
      // chat.message fires there too). Two checks: the title convention, and
      // structurally, any session with a parent — which also covers sessions
      // like magic-context compartments whose titles don't match the
      // convention. When the session cannot be resolved, skip rather than
      // risk staging at the wrong moment.
      const reply = await client.session
        .get({ path: { id: sessionID } })
        .catch(async (e: unknown) => {
          await journal(`session.get failed: ${String(e)}`)
          return undefined
        })
      const title = reply?.data?.title
      if (!title) {
        await client.app
          .log({
            body: {
              service: "opencode-git-add",
              level: "warn",
              message: `could not resolve session ${sessionID}, skipping git add`,
            },
          })
          .catch(() => {})
        await journal(`skip: no session title for ${sessionID}`)
        return
      }
      if (SUBAGENT_TITLE.test(title)) {
        await journal(`skip: subagent session "${title}"`)
        return
      }
      const parentID = (reply?.data as { parentID?: string } | undefined)?.parentID
      if (parentID) {
        await journal(`skip: child session "${title}" (parent=${parentID})`)
        return
      }
      for (const pattern of skipSessionTitle) {
        if (pattern.test(title)) {
          await journal(`skip: session title "${title}" matches ${pattern}`)
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

      await $`git add .`.cwd(directory).quiet()
    },
  }
}
