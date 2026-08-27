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
type FakeClient = {
  session: { get: () => Promise<{ data?: { title?: string } }> };
  app: { log: () => Promise<void> };
}
function makeClient(titleOr: string | "404" | "reject"): FakeClient {
  return {
    session: {
      get: async () => {
        if (titleOr === "404") return { data: undefined }
        if (titleOr === "reject") throw new Error("network down")
        return { data: { title: titleOr } }
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

async function fireTurn(dir: string, message: unknown, client: FakeClient) {
  const h = await GitAddOnNewTurn({ directory: dir, $: bun$, client: client as never })
  await h.event(message as never)
  await Bun.sleep(200) // let async git add settle
}

async function scenario(
  name: string,
  setup: (d: string) => Promise<void>,
  client: FakeClient = makeClient("my normal session"),
) {
  const dir = join(base, name)
  await mkdir(dir, { recursive: true })
  await setup(dir)
  await fireTurn(dir, userMessage("msg-1"), client)
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
  client: makeClient("my normal session") as never,
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

console.log("1. main session staged:", ok1, staged1)
console.log("2. subagent session skipped:", ok2)
console.log("3. lookup 404 skipped:", ok3)
console.log("4. lookup reject skipped:", ok4)
console.log("5. jj-only skipped:", ok5)
console.log("6. assistant message no-op:", ok6)
console.log("7. duplicate message dedup:", ok7)
console.log("8. unrelated event no-op:", ok8)

if (!ok1 || !ok2 || !ok3 || !ok4 || !ok5 || !ok6 || !ok7 || !ok8) {
  failures++
}

await rm(base, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)