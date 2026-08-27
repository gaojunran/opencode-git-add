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

// opencode's magic-context plugin runs its summarizer/sidekick/dreamer work in
// child sessions titled with this prefix.
const MAGIC_CONTEXT_TITLE = /^magic-context-/

export interface GitAddOnNewTurnOptions {
  /**
   * Session titles matching any of these regexes are skipped (no git add).
   * The magic-context child-session prefix `^magic-context-` is always
   * included; entries here are appended to it.
   */
  skipSessionTitlePatterns?: string[]
}

// opencode publishes message.updated before the message's parts are
// persisted, so look them up with a short retry loop.
const PARTS_LOOKUP_ATTEMPTS = 20
const PARTS_LOOKUP_INTERVAL_MS = 50

type PartWithFlags = { type: string; synthetic?: boolean; ignored?: boolean }
type MessageWithParts = { info: { id: string }; parts: PartWithFlags[] }

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// A message counts as an injected (non-user) message when every part carries
// the synthetic or ignored flag. Real user input always has at least one
// unflagged text part.
function isAllSyntheticOrIgnored(parts: PartWithFlags[]): boolean {
  return parts.length > 0 && parts.every((p) => p.synthetic === true || p.ignored === true)
}

// At the start of each new turn (when the user submits a message), stage
// everything the previous turn left behind. The unstaged diff in the editor
// then always shows only the in-progress turn's changes.
export const GitAddOnNewTurn: Plugin = async ({ directory, $, client }, options?: PluginOptions) => {
  let lastStagedMessageID: string | undefined

  const opts = (options ?? {}) as GitAddOnNewTurnOptions
  const skipSessionTitle = [
    MAGIC_CONTEXT_TITLE,
    ...(opts.skipSessionTitlePatterns ?? []).map((p) => new RegExp(p)),
  ]

  return {
    event: async ({ event }) => {
      await journal(`event type=${event.type}`)
      if (event.type !== "message.updated") return
      const { info } = event.properties
      await journal(
        `message.updated role=${info.role} id=${info.id} sessionID=${info.sessionID} summary=${JSON.stringify(info.summary)?.slice(0, 120)}`,
      )
      if (info.role !== "user") return
      if (info.id === lastStagedMessageID) {
        await journal(`skip: duplicate id=${info.id}`)
        return
      }
      lastStagedMessageID = info.id
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
      // agent spawns a subagent. When the session cannot be resolved, skip
      // rather than risk staging at the wrong moment.
      const reply = await client.session
        .get({ path: { id: info.sessionID } })
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
              message: `could not resolve session ${info.sessionID}, skipping git add`,
            },
          })
          .catch(() => {})
        await journal(`skip: no session title for ${info.sessionID}`)
        return
      }
      if (SUBAGENT_TITLE.test(title)) {
        await journal(`skip: subagent session "${title}"`)
        return
      }
      for (const pattern of skipSessionTitle) {
        if (pattern.test(title)) {
          await journal(`skip: session title "${title}" matches ${pattern}`)
          return
        }
      }

      // Skip messages injected into the main session by other plugins (e.g.
      // magic-context progress notices and summaries posted via
      // session.prompt with synthetic/ignored parts). They broadcast a user
      // message.updated too, so without this check they would trigger staging
      // mid-turn. The message's parts are persisted by an event projector that
      // may lag the message.updated broadcast, so retry until they appear. If
      // they never do (API failure), skip rather than risk staging at the
      // wrong moment.
      let found: MessageWithParts | undefined
      let lookupError: unknown
      for (let attempt = 0; attempt < PARTS_LOOKUP_ATTEMPTS; attempt++) {
        try {
          // The message was just created, so it is in the newest page.
          // Fetching the whole history is unnecessary for long sessions.
          const res = await client.session.messages({ path: { id: info.sessionID }, query: { limit: 50 } })
          const list = (res?.data ?? []) as MessageWithParts[]
          found = list.find((m) => m.info.id === info.id)
          if (found && found.parts.length > 0) break
          await sleep(PARTS_LOOKUP_INTERVAL_MS)
        } catch (e) {
          lookupError = e
          break
        }
      }
      if (lookupError) {
        await journal(`skip: could not verify message parts (${String(lookupError)})`)
        return
      }
      if (!found || found.parts.length === 0) {
        await journal(`skip: message parts not confirmed (found=${Boolean(found)})`)
        return
      }
      if (isAllSyntheticOrIgnored(found.parts)) {
        await journal(`skip: injected synthetic/ignored message id=${info.id}`)
        return
      }

      await journal(`git add . (dir=${directory})`)

      await $`git add .`.cwd(directory).quiet()
    },
  }
}