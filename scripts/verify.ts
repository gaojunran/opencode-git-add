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

// Mock the opencode SDK client surface the plugin uses.
type FakePart = { type: string; synthetic?: boolean; ignored?: boolean }
type FakeMessage = { info: { id: string; sessionID?: string }; parts: FakePart[] }
type FakeClient = {
  session: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    get: (args: any) => Promise<{ data?: { title?: string } }>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    messages: (args: any) => Promise<{ data?: FakeMessage[] }>
  }
  app: { log: () => Promise<void> }
}
function makeClient(
  titleOr: string | "404" | "reject",
  messages: FakeMessage[] = [],
  emptyPartsFor?: string[],
): FakeClient {
  const allMessages: FakeMessage[] =
    messages.length > 0
      ? messages
      : [{ info: { id: "msg-1", sessionID: "ses-main" }, parts: [{ type: "text", text: "user input" }] }]
  return {
    session: {
      get: async () => {
        if (titleOr === "404") return { data: undefined }
        if (titleOr === "reject") throw new Error("network down")
        return { data: { title: titleOr } }
      },
      messages: async ({ path }: { path: { id: string } }) => {
        const withEmpty = allMessages.map((m) => ({
          ...m,
          parts: emptyPartsFor?.includes(m.info.id) ? [] : m.parts,
        }))
        return { data: withEmpty.filter((m) => m.info.sessionID === path.id || !m.info.sessionID) }
      },
    },
    app: { log: async () => {} },
  }
}

function userMessage(id: string, sessionID = "ses-main") {
  return {
    event: {
      type: "message.updated",
      properties: { info: { id, sessionID, role: "user" } },
    },
  }
}

async function fireTurn(dir: string, message: unknown, client: FakeClient, options?: Record<string, unknown>) {
  const h = await GitAddOnNewTurn({ directory: dir, $: bun$, client: client as never }, options)
  await h.event(message as never)
  await Bun.sleep(200) // let async git add settle
}

async function scenario(
  name: string,
  setup: (d: string) => Promise<void>,
  client: FakeClient = makeClient("my normal session"),
  options?: Record<string, unknown>,
) {
  const dir = join(base, name)
  await mkdir(dir, { recursive: true })
  await setup(dir)
  await fireTurn(dir, userMessage("msg-1"), client, options)
  return dir
}

// 1. main session, plain git repo -> staged
const d1 = await scenario("git-only", async (d) => {
  await bun$`git init -q ${d}`
  await writeFile(join(d, "a.txt"), "hello")
})
const staged1 = await stagedFiles(d1)
const ok1 = staged1.includes("a.txt")

// 2. subagent session -> NOT staged
const d2 = await scenario(
  "subagent",
  async (d) => {
    await bun$`git init -q ${d}`
    await writeFile(join(d, "a.txt"), "hello")
  },
  makeClient("fix files (@fixer subagent)"),
)
const staged2 = await stagedFiles(d2)
const ok2 = staged2.length === 0

// 3. session lookup fails (404) -> skipped, no error
const d3 = await scenario(
  "lookup-404",
  async (d) => {
    await bun$`git init -q ${d}`
    await writeFile(join(d, "a.txt"), "hello")
  },
  makeClient("404"),
)
const staged3 = await stagedFiles(d3)
const ok3 = staged3.length === 0

// 4. session lookup rejects -> skipped, no error
const d4 = await scenario(
  "lookup-reject",
  async (d) => {
    await bun$`git init -q ${d}`
    await writeFile(join(d, "a.txt"), "hello")
  },
  makeClient("reject"),
)
const staged4 = await stagedFiles(d4)
const ok4 = staged4.length === 0

// 5. no .git (jj only) -> skipped, no error
await scenario("jj-only", async (d) => {
  await mkdir(join(d, ".jj"))
  await writeFile(join(d, "a.txt"), "hello")
})
const ok5 = true

// 6. assistant message.updated -> no-op
await Bun.$`git -C ${d1} reset -q`
await writeFile(join(d1, "a.txt"), "hello2")
await fireTurn(
  d1,
  {
    event: {
      type: "message.updated",
      properties: { info: { id: "asst-1", sessionID: "ses-main", role: "assistant" } },
    },
  },
  makeClient("my normal session"),
)
const stagedAfterAssistant = await stagedFiles(d1)
const ok6 = stagedAfterAssistant.length === 0

// 7. duplicate user message id -> staged only once
await Bun.$`git -C ${d1} reset -q`
const h = await GitAddOnNewTurn({
  directory: d1,
  $: bun$,
  client: makeClient("my normal session", [
    { info: { id: "msg-dup", sessionID: "ses-main" }, parts: [{ type: "text", text: "duplicate" }] },
  ]) as never,
})
await h.event(userMessage("msg-dup") as never)
await Bun.sleep(200)
await Bun.$`git -C ${d1} reset -q`
await h.event(userMessage("msg-dup") as never)
await Bun.sleep(200)
const stagedAfterDup = await stagedFiles(d1)
const ok7 = stagedAfterDup.length === 0

// 8. unrelated event type -> no-op
await Bun.$`git -C ${d1} reset -q`
await writeFile(join(d1, "a.txt"), "hello3")
await fireTurn(
  d1,
  { event: { type: "session.idle", properties: {} } },
  makeClient("my normal session"),
)
const stagedAfterWrongEvent = await stagedFiles(d1)
const ok8 = stagedAfterWrongEvent.length === 0

// 9. magic-context child session title -> NOT staged only when the user
// configures the pattern (no default prefix anymore; the injected-parts
// check handles magic-context regardless of title)
const d9 = await scenario(
  "magic-context-title",
  async (d) => {
    await bun$`git init -q ${d}`
    await writeFile(join(d, "a.txt"), "hello")
  },
  makeClient("magic-context-sidekick", [
    { info: { id: "msg-1", sessionID: "ses-main" }, parts: [{ type: "text", text: "nudge", synthetic: true }] },
  ]),
)
const staged9 = await stagedFiles(d9)
const ok9 = staged9.length === 0

// 10. synthetic-injected user message in main session -> NOT staged
const d10 = await scenario(
  "synthetic-injected",
  async (d) => {
    await bun$`git init -q ${d}`
    await writeFile(join(d, "a.txt"), "hello")
  },
  makeClient("my normal session", [
    { info: { id: "msg-1", sessionID: "ses-main" }, parts: [{ type: "text", text: "nudge", synthetic: true }] },
  ]),
)
const staged10 = await stagedFiles(d10)
const ok10 = staged10.length === 0

// 11. ignored-injected user message in main session -> NOT staged
const d11 = await scenario(
  "ignored-injected",
  async (d) => {
    await bun$`git init -q ${d}`
    await writeFile(join(d, "a.txt"), "hello")
  },
  makeClient("my normal session", [
    { info: { id: "msg-1", sessionID: "ses-main" }, parts: [{ type: "text", text: "notice", ignored: true }] },
  ]),
)
const staged11 = await stagedFiles(d11)
const ok11 = staged11.length === 0

// 12. real user message with a plain text part -> staged
const d12 = await scenario(
  "real-user-with-parts",
  async (d) => {
    await bun$`git init -q ${d}`
    await writeFile(join(d, "a.txt"), "hello")
  },
  makeClient("my normal session", [
    { info: { id: "msg-1", sessionID: "ses-main" }, parts: [{ type: "text", text: "please fix" }] },
  ]),
)
const staged12 = await stagedFiles(d12)
const ok12 = staged12.includes("a.txt")

// 13. user-configured extra title pattern -> NOT staged
const d13 = await scenario(
  "custom-title-pattern",
  async (d) => {
    await bun$`git init -q ${d}`
    await writeFile(join(d, "a.txt"), "hello")
  },
  makeClient("my-journal-session"),
  { skipSessionTitlePatterns: ["^my-journal-"] },
)
const staged13 = await stagedFiles(d13)
const ok13 = staged13.length === 0

// 14. message parts never appear (lookup exhausted) -> skipped, no error
const d14 = await scenario(
  "parts-never-arrive",
  async (d) => {
    await bun$`git init -q ${d}`
    await writeFile(join(d, "a.txt"), "hello")
  },
  makeClient("my normal session", [], ["msg-1"]),
)
const staged14 = await stagedFiles(d14)
const ok14 = staged14.length === 0

// 15. messages lookup rejects -> skipped, no error
const d15 = await scenario(
  "messages-reject",
  async (d) => {
    await bun$`git init -q ${d}`
    await writeFile(join(d, "a.txt"), "hello")
  },
  {
    session: {
      get: async () => ({ data: { title: "my normal session" } }),
      messages: async () => {
        throw new Error("network down")
      },
    },
    app: { log: async () => {} },
  },
)
const staged15 = await stagedFiles(d15)
const ok15 = staged15.length === 0

console.log("1. main session staged:", ok1, staged1)
console.log("2. subagent session skipped:", ok2)
console.log("3. lookup 404 skipped:", ok3)
console.log("4. lookup reject skipped:", ok4)
console.log("5. jj-only skipped:", ok5)
console.log("6. assistant message no-op:", ok6)
console.log("7. duplicate message dedup:", ok7)
console.log("8. unrelated event no-op:", ok8)
console.log("9. magic-context title skipped:", ok9)
console.log("10. synthetic-injected skipped:", ok10)
console.log("11. ignored-injected skipped:", ok11)
console.log("12. real user with parts staged:", ok12)
console.log("13. custom title pattern skipped:", ok13)
console.log("14. parts never arrive skipped:", ok14)
console.log("15. messages lookup reject skipped:", ok15)

if (!ok1 || !ok2 || !ok3 || !ok4 || !ok5 || !ok6 || !ok7 || !ok8 || !ok9 || !ok10 || !ok11 || !ok12 || !ok13 || !ok14 || !ok15) {
  failures++
}

await rm(base, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)