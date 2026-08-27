import { exists } from "node:fs/promises"
import { join } from "node:path"
import type { Plugin } from "@opencode-ai/plugin"

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
      if (event.type !== "message.updated") return
      const { info } = event.properties
      if (info.role !== "user") return
      if (info.id === lastStagedMessageID) return
      lastStagedMessageID = info.id
      if (!(await exists(join(directory, ".git")))) return

      // Skip subagent turns: only real user turns in the main session should
      // trigger staging, otherwise staging happens mid-turn whenever the main
      // agent spawns a subagent. When the session cannot be resolved, skip
      // rather than risk staging at the wrong moment.
      const reply = await client.session
        .get({ path: { id: info.sessionID } })
        .catch(() => undefined)
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
        return
      }
      if (SUBAGENT_TITLE.test(title)) return

      await $`git add .`.cwd(directory).quiet()
    },
  }
}