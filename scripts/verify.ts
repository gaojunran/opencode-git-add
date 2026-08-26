import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { $ as bun$ } from "bun"

const pluginModule = await import("../git-add.ts")
const GitAddOnIdle = pluginModule.GitAddOnIdle ?? pluginModule.default

const base = await mkdtemp(join(tmpdir(), "hook-test-"))
let failures = 0

async function stagedFiles(dir: string): Promise<string[]> {
  const out = await bun$`git -C ${dir} diff --cached --name-only`.quiet().text()
  return out.split("\n").filter(Boolean)
}

async function scenario(name: string, setup: (d: string) => Promise<void>) {
  const dir = join(base, name)
  await mkdir(dir, { recursive: true })
  await setup(dir)
  const h = await GitAddOnIdle({ directory: dir, $: bun$ })
  await h.event({ event: { type: "session.idle" } })
  await Bun.sleep(200) // let async git add settle
  return dir
}

// 1. plain git repo (.git only) -> should stage
const d1 = await scenario("git-only", async (d) => {
  await bun$`git init -q ${d}`
  await writeFile(join(d, "a.txt"), "hello")
})
const staged1 = await stagedFiles(d1)
const ok1 = staged1.includes("a.txt")

// 2. jujutsu colocated repo (.git + .jj) -> should stage
const d2 = await scenario("both", async (d) => {
  await bun$`git init -q ${d}`
  await mkdir(join(d, ".jj"))
  await writeFile(join(d, "a.txt"), "hello")
})
const staged2 = await stagedFiles(d2)
const ok2 = staged2.includes("a.txt")

// 3. only .jj, no .git -> should NOT run (and not error)
await scenario("jj-only", async (d) => {
  await mkdir(join(d, ".jj"))
  await writeFile(join(d, "a.txt"), "hello")
})
const ok3 = true

// 4. neither -> should NOT run (and not error)
await scenario("none", async (d) => {
  await writeFile(join(d, "a.txt"), "hello")
})
const ok4 = true

// 5. non-session.idle events ignored: unstage first, then fire a wrong event
await Bun.$`git -C ${d1} reset -q`
await writeFile(join(d1, "a.txt"), "hello2")
const h = await GitAddOnIdle({ directory: d1, $: bun$ })
await h.event({ event: { type: "message.updated" } })
await Bun.sleep(200)
const stagedAfterWrongEvent = await stagedFiles(d1)
const ok5 = stagedAfterWrongEvent.length === 0

console.log("1. .git only staged:", ok1, staged1)
console.log("2. .git+.jj staged:", ok2, staged2)
console.log("3. .jj only no error:", ok3)
console.log("4. neither no error:", ok4)
console.log("5. wrong event no-op:", ok5)

if (!ok1 || !ok2 || !ok3 || !ok4 || !ok5) {
  failures++
}

await rm(base, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)