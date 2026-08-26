import { exists } from "node:fs/promises"
import { join } from "node:path"
import type { Plugin } from "@opencode-ai/plugin"

// Auto-stage all changes after every finished turn, but only in jujutsu
// colocated repositories (both .jj and .git present).
export const GitAddOnIdle: Plugin = async ({ directory, $ }) => {
  return {
    event: async ({ event }) => {
      if (event.type !== "session.idle") return
      if (
        !(await exists(join(directory, ".git"))) ||
        !(await exists(join(directory, ".jj")))
      ) {
        return
      }
      await $`git add .`.cwd(directory).quiet()
    },
  }
}