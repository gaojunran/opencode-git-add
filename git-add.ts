import { exists } from "node:fs/promises"
import { join } from "node:path"
import type { Plugin } from "@opencode-ai/plugin"

// Auto-stage all changes after every finished turn, but only inside git
// repositories (a .git directory present, which also covers jujutsu colocated
// working copies).
export const GitAddOnIdle: Plugin = async ({ directory, $ }) => {
  return {
    event: async ({ event }) => {
      if (event.type !== "session.idle") return
      if (!(await exists(join(directory, ".git")))) return
      await $`git add .`.cwd(directory).quiet()
    },
  }
}