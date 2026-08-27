import { exists, appendFile } from "node:fs/promises"
import { join } from "node:path"
import type { Plugin } from "@opencode-ai/plugin"

// Debug journal: every event the hook sees, with the decision taken.
// Safe to leave on; it only appends a few lines per event to a /tmp file.
const LOGFILE = "/tmp/opencode-git-add.log"
async function journal(line: string) {
  await appendFile(LOGFILE, `${new Date().toISOString()} ${line}\n`).catch(() => {})
}

// Subagent sessions are titled "<description> (@<agent> subagent)" by
// opencode's task tool — same signal the TUI uses to detect them.
const SUBAGENT_TITLE = /@[\w-]+ subagent\)?$/i

// At the start of each new turn (when the user submits a message), stage
// everything the previous turn left behind. The unstaged diff in the editor
// then always shows only the in-progress turn's changes.
export const GitAddOnNewTurn: Plugin = async ({ directory, $, client }) => {
  let lastStagedMessageID: string | undefined

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
      if (!(await exists(join(directory, ".git")))) {
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

      await journal(`git add . (dir=${directory})`)

      await $`git add .`.cwd(directory).quiet()
    },
  }
}