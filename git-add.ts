import { exists } from "node:fs/promises"
import { join } from "node:path"
import type { Plugin } from "@opencode-ai/plugin"

// At the start of each new turn (when the user submits a message), stage
// everything the previous turn left behind. The unstaged diff in the editor
// then always shows only the in-progress turn's changes.
export const GitAddOnNewTurn: Plugin = async ({ directory, $ }) => {
  let lastStagedMessageID: string | undefined

  return {
    event: async ({ event }) => {
      if (event.type !== "message.updated") return
      const { info } = event.properties
      if (info.role !== "user") return
      if (info.id === lastStagedMessageID) return
      lastStagedMessageID = info.id
      if (!(await exists(join(directory, ".git")))) return
      await $`git add .`.cwd(directory).quiet()
    },
  }
}