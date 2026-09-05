import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { $ as bun$ } from "bun"

const pluginModule = await import("../git-add.ts")
const GitAddOnNewTurn = pluginModule.GitAddOnNewTurn ?? pluginModule.default

const base = await mkdtemp(join(tmpdir(), "hook-test-"))
let failures = 0

async function stagedFiles(dir: string): Promise<string[]> {
  const out = await bun$`git -C ${dir} diff --cached --name-only`.quiet().text()
  return out.split("\n").filter(Boolean)
}

// Mock the opencode SDK client surface the plugin uses. The chat.message
// hook carries parts inline, so no messages lookup is needed anymore.
type FakePart = { type: string; synthetic?: boolean; ignored?: boolean }
type FakeClient = {
  session: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    get: (args: any) => Promise<{ data?: { title?: string; parentID?: string } }>
  }
  app: { log: () => Promise<void> }
}
function makeClient(titleOr: string | "404" | "reject", parentID?: string): FakeClient {
  return {
    session: {
      get: async () => {
        if (titleOr === "404") return { data: undefined }
        if (titleOr === "reject") throw new Error("network down")
        return { data: { title: titleOr, parentID } }
      },
    },
    app: { log: async () => {} },
  }
}

type FakeInput = { sessionID: string }
// One plugin instance per hook — the dedup Set lives in the instance.
async function makeHook(dir: string, client: FakeClient, options?: Record<string, unknown>) {
  const h = await GitAddOnNewTurn({ directory: dir, $: bun$, client: client as never }, options)
  const hook = (h as { "chat.message"?: (input: FakeInput, output: { message: { id: string }; parts: FakePart[] }) => Promise<void> })[
    "chat.message"
  ]
  if (!hook) throw new Error("plugin did not register a chat.message hook")
  return async (parts: FakePart[], id = "msg-1") => {
    await hook({ sessionID: "ses-main" }, { message: { id }, parts })
  }
}
async function fireTurn(
  dir: string,
  parts: FakePart[],
  client: FakeClient,
  options?: Record<string, unknown>,
  id = "msg-1",
): Promise<void> {
  const fire = await makeHook(dir, client, options)
  await fire(parts, id)
}

const textPart = (text = "user input"): FakePart => ({ type: "text", text })

// 1. main session, plain git repo, real user parts -> staged
const d1 = join(base, "git-only")
await mkdir(d1, { recursive: true })
await bun$`git init -q ${d1}`
await writeFile(join(d1, "a.txt"), "hello")
await fireTurn(d1, [textPart()], makeClient("my normal session"))
const staged1 = await stagedFiles(d1)
const ok1 = staged1.includes("a.txt")

// 2. subagent-style title WITHOUT a parentID -> staged. Child sessions are
//    detected structurally via the session-DB parentID, and no real session
//    carries a subagent title without one — so the old title-convention check
//    is gone. This guards against it silently coming back.
const d2 = join(base, "title-no-parent")
await mkdir(d2, { recursive: true })
await bun$`git init -q ${d2}`
await writeFile(join(d2, "a.txt"), "hello")
await fireTurn(d2, [textPart()], makeClient("fix files (@fixer subagent)"))
const staged2 = await stagedFiles(d2)
const ok2 = staged2.includes("a.txt")

// 3. session with a parentID (task-tool subagents, magic-context
//    compartments) -> NOT staged even with a normal title
const d3 = join(base, "child-session")
await mkdir(d3, { recursive: true })
await bun$`git init -q ${d3}`
await writeFile(join(d3, "a.txt"), "hello")
await fireTurn(d3, [textPart()], makeClient("magic-context-compartment", "ses-parent"))
const staged3 = await stagedFiles(d3)
const ok3 = staged3.length === 0

// 4. session lookup fails (404) -> skipped, no error
const d4 = join(base, "lookup-404")
await mkdir(d4, { recursive: true })
await bun$`git init -q ${d4}`
await writeFile(join(d4, "a.txt"), "hello")
await fireTurn(d4, [textPart()], makeClient("404"))
const staged4 = await stagedFiles(d4)
const ok4 = staged4.length === 0

// 5. session lookup rejects -> skipped, no error
const d5 = join(base, "lookup-reject")
await mkdir(d5, { recursive: true })
await bun$`git init -q ${d5}`
await writeFile(join(d5, "a.txt"), "hello")
await fireTurn(d5, [textPart()], makeClient("reject"))
const staged5 = await stagedFiles(d5)
const ok5 = staged5.length === 0

// 6. no .git (jj only) -> skipped, no error
const d6 = join(base, "jj-only")
await mkdir(d6, { recursive: true })
await mkdir(join(d6, ".jj"))
await writeFile(join(d6, "a.txt"), "hello")
await fireTurn(d6, [textPart()], makeClient("my normal session"))
const ok6 = true

// 7. synthetic-injected message -> NOT staged
const d7 = join(base, "synthetic-injected")
await mkdir(d7, { recursive: true })
await bun$`git init -q ${d7}`
await writeFile(join(d7, "a.txt"), "hello")
await fireTurn(d7, [{ type: "text", text: "nudge", synthetic: true }], makeClient("my normal session"))
const staged7 = await stagedFiles(d7)
const ok7 = staged7.length === 0

// 8. ignored-injected message -> NOT staged
const d8 = join(base, "ignored-injected")
await mkdir(d8, { recursive: true })
await bun$`git init -q ${d8}`
await writeFile(join(d8, "a.txt"), "hello")
await fireTurn(d8, [{ type: "text", text: "notice", ignored: true }], makeClient("my normal session"))
const staged8 = await stagedFiles(d8)
const ok8 = staged8.length === 0

// 9. empty parts (nothing to inspect) -> NOT staged
const d9 = join(base, "empty-parts")
await mkdir(d9, { recursive: true })
await bun$`git init -q ${d9}`
await writeFile(join(d9, "a.txt"), "hello")
await fireTurn(d9, [], makeClient("my normal session"))
const staged9 = await stagedFiles(d9)
const ok9 = staged9.length === 0

// 10. dedup: same message id fired twice on one instance -> staged only once
const d10 = join(base, "dedup")
await mkdir(d10, { recursive: true })
await bun$`git init -q ${d10}`
await writeFile(join(d10, "a.txt"), "hello")
const fire10 = await makeHook(d10, makeClient("my normal session"))
await fire10([textPart("first")], "msg-dup")
const stagedFirst = await stagedFiles(d10)
await bun$`git -C ${d10} reset -q`
await fire10([textPart("again")], "msg-dup")
const staged10 = await stagedFiles(d10)
const ok10 = stagedFirst.includes("a.txt") && staged10.length === 0

// 11. skipped messages leave no trace: a synthetic message followed by a
//     real one must still stage (the old single-slot dedup could be
//     poisoned by skipped messages; the Set + record-after-checks cannot)
const d11 = join(base, "synthetic-then-real")
await mkdir(d11, { recursive: true })
await bun$`git init -q ${d11}`
await writeFile(join(d11, "a.txt"), "hello")
const fire11 = await makeHook(d11, makeClient("my normal session"))
await fire11([{ type: "text", text: "⚠️ Magic Context", synthetic: true }], "msg-synth")
await fire11([textPart("real turn")], "msg-real")
const staged11 = await stagedFiles(d11)
const ok11 = staged11.includes("a.txt")

// 12. user-configured extra title pattern -> NOT staged
const d12 = join(base, "custom-title-pattern")
await mkdir(d12, { recursive: true })
await bun$`git init -q ${d12}`
await writeFile(join(d12, "a.txt"), "hello")
await fireTurn(d12, [textPart()], makeClient("my-journal-session"), { skipSessionTitlePatterns: ["^my-journal-"] })
const staged12 = await stagedFiles(d12)
const ok12 = staged12.length === 0

// 13. mixed parts: one synthetic + one real text part -> staged
//     (real user input always has at least one unflagged text part)
const d13 = join(base, "mixed-parts")
await mkdir(d13, { recursive: true })
await bun$`git init -q ${d13}`
await writeFile(join(d13, "a.txt"), "hello")
await fireTurn(
  d13,
  [
    { type: "text", text: "injected note", synthetic: true },
    textPart("please fix"),
  ],
  makeClient("my normal session"),
)
const staged13 = await stagedFiles(d13)
const ok13 = staged13.includes("a.txt")

console.log("1. main session staged:", ok1, staged1)
console.log("2. subagent-style title w/o parentID staged:", ok2)
console.log("3. parentID child session skipped:", ok3)
console.log("4. lookup 404 skipped:", ok4)
console.log("5. lookup reject skipped:", ok5)
console.log("6. jj-only skipped:", ok6)
console.log("7. synthetic-injected skipped:", ok7)
console.log("8. ignored-injected skipped:", ok8)
console.log("9. empty parts skipped:", ok9)
console.log("10. dedup fires once:", ok10)
console.log("11. skipped messages cannot poison dedup:", ok11)
console.log("12. custom title pattern skipped:", ok12)
console.log("13. mixed parts staged:", ok13)

if (!ok1 || !ok2 || !ok3 || !ok4 || !ok5 || !ok6 || !ok7 || !ok8 || !ok9 || !ok10 || !ok11 || !ok12 || !ok13) {
  failures++
}

await rm(base, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
