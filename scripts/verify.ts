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

function userMessage(id: string) {
  return { event: { type: "message.updated", properties: { info: { id, role: "user" } } } }
}

async function fireTurn(
  dir: string,
  message: { event: { type: string; properties: unknown } },
) {
  const h = await GitAddOnNewTurn({ directory: dir, $: bun$ })
  await h.event(message as never)
  await Bun.sleep(200) // let async git add settle
}

async function scenario(name: string, setup: (d: string) => Promise<void>) {
  const dir = join(base, name)
  await mkdir(dir, { recursive: true })
  await setup(dir)
  await fireTurn(dir, userMessage("msg-1"))
  return dir
}

// 1. plain git repo (.git only) -> turn start stages previous turn's changes
const d1 = await scenario("git-only", async (d) => {
  await bun$`git init -q ${d}`
  await writeFile(join(d, "a.txt"), "hello")
})
const staged1 = await stagedFiles(d1)
const ok1 = staged1.includes("a.txt")

// 2. jujutsu colocated repo (.git + .jj) -> same behavior
const d2 = await scenario("both", async (d) => {
  await bun$`git init -q ${d}`
  await mkdir(join(d, ".jj"))
  await writeFile(join(d, "a.txt"), "hello")
})
const staged2 = await stagedFiles(d2)
const ok2 = staged2.includes("a.txt")

// 3. only .jj, no .git -> skipped, no error
await scenario("jj-only", async (d) => {
  await mkdir(join(d, ".jj"))
  await writeFile(join(d, "a.txt"), "hello")
})
const ok3 = true

// 4. neither -> skipped, no error
await scenario("none", async (d) => {
  await writeFile(join(d, "a.txt"), "hello")
})
const ok4 = true

// 5. assistant message.updated -> no-op: unstage, fire an assistant update
await Bun.$`git -C ${d1} reset -q`
await writeFile(join(d1, "a.txt"), "hello2")
await fireTurn(d1, {
  event: { type: "message.updated", properties: { info: { id: "asst-1", role: "assistant" } } },
})
const stagedAfterAssistant = await stagedFiles(d1)
const ok5 = stagedAfterAssistant.length === 0

// 6. duplicate user message id -> staged only once: unstage, same id twice,
//    second fire must not re-stage
await Bun.$`git -C ${d1} reset -q`
const h = await GitAddOnNewTurn({ directory: d1, $: bun$ })
await h.event(userMessage("msg-dup") as never)
await Bun.sleep(200)
await Bun.$`git -C ${d1} reset -q`
await h.event(userMessage("msg-dup") as never)
await Bun.sleep(200)
const stagedAfterDup = await stagedFiles(d1)
const ok6 = stagedAfterDup.length === 0

// 7. unrelated event type -> no-op
await Bun.$`git -C ${d1} reset -q`
await writeFile(join(d1, "a.txt"), "hello3")
await fireTurn(d1, { event: { type: "session.idle", properties: {} } })
const stagedAfterWrongEvent = await stagedFiles(d1)
const ok7 = stagedAfterWrongEvent.length === 0

console.log("1. .git only staged:", ok1, staged1)
console.log("2. .git+.jj staged:", ok2, staged2)
console.log("3. .jj only no error:", ok3)
console.log("4. neither no error:", ok4)
console.log("5. assistant message no-op:", ok5)
console.log("6. duplicate message id dedup:", ok6)
console.log("7. unrelated event no-op:", ok7)

if (!ok1 || !ok2 || !ok3 || !ok4 || !ok5 || !ok6 || !ok7) {
  failures++
}

await rm(base, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)