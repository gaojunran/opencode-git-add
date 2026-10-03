import { mkdtemp, rm, mkdir, writeFile, readFile, rename } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { $ as bun$ } from "bun"

const pluginModule = await import("../git-add.ts")
const GitAddOnNewTurn = pluginModule.GitAddOnNewTurn ?? pluginModule.default

const base = await mkdtemp(join(tmpdir(), "hook-test-"))
let failures = 0

async function stagedFiles(dir: string): Promise<string[]> {
  // diff.renames=false: report the raw pathspec-level result. Rename
  // detection would collapse deletions+additions of identical-content files
  // into a single "new name" line, hiding staged deletions.
  const out = await bun$`git -C ${dir} -c diff.renames=false diff --cached --name-only`.quiet().text()
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

// 14. git add failure (a concurrent process holding .git/index.lock) must
//     not block the message: the hook retries, does not throw, journals the
//     failing stderr, and a later turn stages normally once the lock is gone.
const d14 = join(base, "staging-failure")
await mkdir(d14, { recursive: true })
await bun$`git init -q ${d14}`
await writeFile(join(d14, "a.txt"), "hello")
await writeFile(join(d14, ".git/index.lock"), "held by another process")
const fire14 = await makeHook(d14, makeClient("my normal session"))
let ok14 = true
try {
  await fire14([textPart("turn during lock")], "msg-locked")
} catch {
  ok14 = false
}
const stagedDuringLock = await stagedFiles(d14)
const journalText = await readFile("/tmp/opencode-git-add.log", "utf8").catch(() => "")
const d14Lines = journalText.split("\n").filter((line) => line.includes(`dir=${d14}`))
const d14Attempts = d14Lines.filter((line) => line.includes("git add attempt")).length
const stderrCaptured = d14Lines.some((line) => line.includes("index.lock"))
await rm(join(d14, ".git/index.lock"))
await fire14([textPart("turn after lock")], "msg-after-lock")
const staged14 = await stagedFiles(d14)
const ok14b = ok14 && stagedDuringLock.length === 0 && d14Attempts === 3 && stderrCaptured && staged14.includes("a.txt")

// ---------------------------------------------------------------------------
// v2 lane (opencode 2.x): precise tool-tracked staging
// ---------------------------------------------------------------------------
// setup() is fed a fake v2 context that captures the registered hooks and
// serves controllable session.get results; the plugin itself shells out to
// real git via node execFile, so these are integration tests on real repos.

type FakeV2Ctx = {
  location: { directory: string }
  options?: Record<string, unknown>
  promptHandler?: (draft: any) => Promise<void>
  afterHandler?: (draft: any) => Promise<void>
  sessions: Map<string, Record<string, unknown>>
  getThrows: boolean
  getCalls: number
}

function makeV2Context(dir: string, options?: Record<string, unknown>): any {
  const ctx: FakeV2Ctx = {
    location: { directory: dir },
    options,
    sessions: new Map(),
    getThrows: false,
    getCalls: 0,
  }
  ctx.session = {
    hook: async (_name: string, cb: any) => {
      ctx.promptHandler = cb
    },
    get: async (input: any) => {
      ctx.getCalls++
      if (ctx.getThrows) throw new Error("network down")
      const s = ctx.sessions.get(input.sessionID)
      return s ? { data: s } : { data: undefined }
    },
  }
  ctx.tool = {
    hook: async (_name: string, cb: any) => {
      ctx.afterHandler = cb
    },
  }
  return ctx
}

async function v2Setup(dir: string, options?: Record<string, unknown>) {
  const ctx = makeV2Context(dir, options)
  await pluginModule.setup(ctx)
  return ctx
}

const afterTool = async (ctx: any, draft: any) => {
  const h = ctx.afterHandler
  if (!h) throw new Error("execute.after hook not registered")
  await h(draft)
}
const firePrompt = async (ctx: any, draft: any) => {
  const h = ctx.promptHandler
  if (!h) throw new Error("prompt hook not registered")
  await h(draft)
}

// 15. write tool tracked from a main session; next prompt stages EXACTLY the
//     touched file; a user's manual edit (never tool-written) is untouched
const d15 = join(base, "v2-write-track")
await mkdir(d15, { recursive: true })
await bun$`git init -q ${d15}`
await writeFile(join(d15, "notes.txt"), "hello")
const ctx15 = await v2Setup(d15)
ctx15.sessions.set("ses-main", { title: "my session" })
await afterTool(ctx15, { sessionID: "ses-main", tool: "write", input: { path: "notes.txt", content: "hello2" }, status: "completed" })
await writeFile(join(d15, "notes.txt"), "hello2")
await writeFile(join(d15, "unrelated.txt"), "user manual edit, never touched by a tool")
await firePrompt(ctx15, { sessionID: "ses-main", messageID: "msg-15", prompt: { text: "go" } })
const staged15 = await stagedFiles(d15)
const ok15 = staged15.length === 1 && staged15[0] === "notes.txt"

// 16. edit tool with an ABSOLUTE path from a subagent session; the subagent's
//     prompt does not stage, the main session's next prompt does
const d16 = join(base, "v2-edit-abs")
await mkdir(d16, { recursive: true })
await bun$`git init -q ${d16}`
await writeFile(join(d16, "abs.txt"), "a")
const ctx16 = await v2Setup(d16)
ctx16.sessions.set("ses-main", { title: "main" })
ctx16.sessions.set("ses-child", { title: "fix files (@fixer subagent)", parentID: "ses-main" })
await afterTool(ctx16, { sessionID: "ses-child", tool: "edit", input: { path: join(d16, "abs.txt"), appendContent: "b" }, status: "completed" })
await writeFile(join(d16, "abs.txt"), "ab")
await firePrompt(ctx16, { sessionID: "ses-child", messageID: "msg-child", prompt: { text: "child" } })
const stagedBeforeMain = await stagedFiles(d16)
await firePrompt(ctx16, { sessionID: "ses-main", messageID: "msg-16", prompt: { text: "go" } })
const staged16 = await stagedFiles(d16)
const ok16 = stagedBeforeMain.length === 0 && staged16.length === 1 && staged16[0] === "abs.txt"

// 17. turn with no tracked writes -> no staging at all
const d17 = join(base, "v2-no-writes")
await mkdir(d17, { recursive: true })
await bun$`git init -q ${d17}`
await writeFile(join(d17, "a.txt"), "hello")
const ctx17 = await v2Setup(d17)
ctx17.sessions.set("ses-main", { title: "main" })
await firePrompt(ctx17, { sessionID: "ses-main", messageID: "msg-17", prompt: { text: "go" } })
const staged17 = await stagedFiles(d17)
const ok17 = staged17.length === 0

// 18. tool status != completed -> not tracked, nothing staged
const d18 = join(base, "v2-status-error")
await mkdir(d18, { recursive: true })
await bun$`git init -q ${d18}`
await writeFile(join(d18, "a.txt"), "hello")
const ctx18 = await v2Setup(d18)
ctx18.sessions.set("ses-main", { title: "main" })
await afterTool(ctx18, { sessionID: "ses-main", tool: "write", input: { path: "a.txt", content: "x" }, status: "error" })
await writeFile(join(d18, "a.txt"), "x")
await firePrompt(ctx18, { sessionID: "ses-main", messageID: "msg-18", prompt: { text: "go" } })
const staged18 = await stagedFiles(d18)
const ok18 = staged18.length === 0

// 19. path outside the project (../evil.txt) -> not tracked
const d19 = join(base, "v2-outside-path")
await mkdir(d19, { recursive: true })
await bun$`git init -q ${d19}`
await writeFile(join(d19, "a.txt"), "hello")
const ctx19 = await v2Setup(d19)
ctx19.sessions.set("ses-main", { title: "main" })
await afterTool(ctx19, { sessionID: "ses-main", tool: "write", input: { path: "../evil.txt", content: "x" }, status: "completed" })
await firePrompt(ctx19, { sessionID: "ses-main", messageID: "msg-19", prompt: { text: "go" } })
const staged19 = await stagedFiles(d19)
const ok19 = staged19.length === 0

// 20. apply_patch patchText `*** Update File:` header -> tracked, staged
//     exactly (since v0.10.1; pre-0.10.1 it was untracked)
const d20 = join(base, "v2-apply-patch")
await mkdir(d20, { recursive: true })
await bun$`git init -q ${d20}`
await writeFile(join(d20, "notes.txt"), "hello")
await bun$`git -C ${d20} add notes.txt && git -C ${d20} commit -qm init`
const ctx20 = await v2Setup(d20)
ctx20.sessions.set("ses-main", { title: "main" })
await afterTool(ctx20, {
  sessionID: "ses-main",
  tool: "apply_patch",
  input: { patchText: "*** Begin Patch\n*** Update File: notes.txt\n@@ MARKER\n+MARKER-16\n*** End Patch" },
  status: "completed",
})
await writeFile(join(d20, "notes.txt"), "hello\nMARKER-16")
await firePrompt(ctx20, { sessionID: "ses-main", messageID: "msg-20", prompt: { text: "go" } })
const staged20 = await stagedFiles(d20)
const ok20 = staged20.length === 1 && staged20[0] === "notes.txt"

// 21. dedup: same message id fired twice on one instance -> staged only once
const d21 = join(base, "v2-dedup")
await mkdir(d21, { recursive: true })
await bun$`git init -q ${d21}`
await writeFile(join(d21, "a.txt"), "hello")
const ctx21 = await v2Setup(d21)
ctx21.sessions.set("ses-main", { title: "main" })
await afterTool(ctx21, { sessionID: "ses-main", tool: "write", input: { path: "a.txt" }, status: "completed" })
await firePrompt(ctx21, { sessionID: "ses-main", messageID: "msg-dup", prompt: { text: "one" } })
const stagedFirst21 = await stagedFiles(d21)
await afterTool(ctx21, { sessionID: "ses-main", tool: "edit", input: { path: "b.txt" }, status: "completed" })
await writeFile(join(d21, "b.txt"), "b")
await firePrompt(ctx21, { sessionID: "ses-main", messageID: "msg-dup", prompt: { text: "two" } })
const staged21 = await stagedFiles(d21)
await firePrompt(ctx21, { sessionID: "ses-main", messageID: "msg-21b", prompt: { text: "three" } })
const staged21b = await stagedFiles(d21)
const ok21 = stagedFirst21.includes("a.txt") && staged21.length === 1 && staged21b.includes("b.txt")

// 22. custom title pattern option (via context.options) -> skipped
const d22 = join(base, "v2-title-pattern")
await mkdir(d22, { recursive: true })
await bun$`git init -q ${d22}`
await writeFile(join(d22, "a.txt"), "hello")
const ctx22 = await v2Setup(d22, { skipSessionTitlePatterns: ["^my-journal-"] })
ctx22.sessions.set("ses-main", { title: "my-journal-session" })
await afterTool(ctx22, { sessionID: "ses-main", tool: "write", input: { path: "a.txt" }, status: "completed" })
await firePrompt(ctx22, { sessionID: "ses-main", messageID: "msg-22", prompt: { text: "go" } })
const staged22 = await stagedFiles(d22)
const ok22 = staged22.length === 0

// 23. session lookup failure -> skipped without error
const d23 = join(base, "v2-lookup-fail")
await mkdir(d23, { recursive: true })
await bun$`git init -q ${d23}`
await writeFile(join(d23, "a.txt"), "hello")
const ctx23 = await v2Setup(d23)
ctx23.getThrows = true
await afterTool(ctx23, { sessionID: "ses-main", tool: "write", input: { path: "a.txt" }, status: "completed" })
let ok23 = true
await firePrompt(ctx23, { sessionID: "ses-main", messageID: "msg-23", prompt: { text: "go" } }).catch(() => { ok23 = false })
const staged23 = await stagedFiles(d23)
ok23 = ok23 && staged23.length === 0

// 24. no .git -> skipped without error; write still tracked but never staged
const d24 = join(base, "v2-jj-only")
await mkdir(d24, { recursive: true })
await mkdir(join(d24, ".jj"))
await writeFile(join(d24, "a.txt"), "hello")
const ctx24 = await v2Setup(d24)
ctx24.sessions.set("ses-main", { title: "main" })
await afterTool(ctx24, { sessionID: "ses-main", tool: "write", input: { path: "a.txt" }, status: "completed" })
let ok24 = true
await firePrompt(ctx24, { sessionID: "ses-main", messageID: "msg-24", prompt: { text: "go" } }).catch(() => { ok24 = false })
ok24 = ok24 && true // no git repo to inspect; the point is not throwing

// 25. v2 staging failure (index.lock held) retries, does not throw, and a
//     later prompt stages once the lock is gone
const d25 = join(base, "v2-staging-failure")
await mkdir(d25, { recursive: true })
await bun$`git init -q ${d25}`
await writeFile(join(d25, "a.txt"), "hello")
const ctx25 = await v2Setup(d25)
ctx25.sessions.set("ses-main", { title: "main" })
await afterTool(ctx25, { sessionID: "ses-main", tool: "write", input: { path: "a.txt" }, status: "completed" })
await writeFile(join(d25, ".git/index.lock"), "held")
let ok25 = true
await firePrompt(ctx25, { sessionID: "ses-main", messageID: "msg-locked", prompt: { text: "go" } }).catch(() => { ok25 = false })
const stagedDuringLock25 = await stagedFiles(d25)
const v2Journal = await readFile("/tmp/opencode-git-add.log", "utf8").catch(() => "")
const d25Lines = v2Journal.split("\n").filter((line) => line.includes(`dir=${d25}`))
const d25Attempts = d25Lines.filter((line) => line.includes("v2 git add attempt")).length
await rm(join(d25, ".git/index.lock"))
await firePrompt(ctx25, { sessionID: "ses-main", messageID: "msg-after-lock", prompt: { text: "go" } })
const staged25 = await stagedFiles(d25)
const ok25b = ok25 && stagedDuringLock25.length === 0 && d25Attempts === 3 && staged25.includes("a.txt")

// 26. apply_patch patchText with every header form (update/add/delete/
//     rename/move-to) -> all touched paths staged, old AND new sides of
//     renames included
const d26 = join(base, "v2-apply-patch-headers")
await mkdir(d26, { recursive: true })
await bun$`git init -q ${d26}`
for (const f of ["upd.txt", "del.txt", "ren.txt", "mov.txt"]) {
  await writeFile(join(d26, f), "a")
}
await bun$`git -C ${d26} add -A && git -C ${d26} commit -qm init`
const ctx26 = await v2Setup(d26)
ctx26.sessions.set("ses-main", { title: "main" })
const patch26 = [
  "*** Begin Patch",
  "*** Update File: upd.txt",
  "+b",
  "*** Add File: new.txt",
  "+n",
  "*** Delete File: del.txt",
  "*** Rename File: ren.txt to ren2.txt",
  "*** Update File: mov.txt",
  "*** Move to: mov2.txt",
  "*** End Patch",
].join("\n")
await afterTool(ctx26, {
  sessionID: "ses-main",
  tool: "apply_patch",
  input: { patchText: patch26 },
  status: "completed",
})
// mirror the patch in the worktree
await writeFile(join(d26, "upd.txt"), "ab")
await writeFile(join(d26, "new.txt"), "n")
await rm(join(d26, "del.txt"))
await rename(join(d26, "ren.txt"), join(d26, "ren2.txt"))
await writeFile(join(d26, "mov2.txt"), "a")
await rm(join(d26, "mov.txt"))
await firePrompt(ctx26, { sessionID: "ses-main", messageID: "msg-26", prompt: { text: "go" } })
const staged26 = await stagedFiles(d26)
const ok26 =
  ["upd.txt", "new.txt", "del.txt", "ren.txt", "ren2.txt", "mov.txt", "mov2.txt"].every((f) =>
    staged26.includes(f),
  ) && staged26.length === 7

// 27. garbage patchText (no parseable file headers — bogus op, empty path,
//     bare content) -> nothing tracked, nothing staged
const d27 = join(base, "v2-apply-patch-garbage")
await mkdir(d27, { recursive: true })
await bun$`git init -q ${d27}`
await writeFile(join(d27, "a.txt"), "hello")
const ctx27 = await v2Setup(d27)
ctx27.sessions.set("ses-main", { title: "main" })
await afterTool(ctx27, {
  sessionID: "ses-main",
  tool: "apply_patch",
  input: {
    patchText: [
      "*** Begin Patch",
      "*** Bogus Op: sneaky.txt",
      "*** Update File: ",
      "just some content",
      "*** End Patch",
    ].join("\n"),
  },
  status: "completed",
})
await firePrompt(ctx27, { sessionID: "ses-main", messageID: "msg-27", prompt: { text: "go" } })
const staged27 = await stagedFiles(d27)
const ok27 = staged27.length === 0

// 28. empty result metadata (files: []) -> falls back to patchText headers
//     (journaled with src=patchText)
const d28 = join(base, "v2-apply-patch-empty-meta")
await mkdir(d28, { recursive: true })
await bun$`git init -q ${d28}`
await writeFile(join(d28, "notes.txt"), "hello")
await bun$`git -C ${d28} add notes.txt && git -C ${d28} commit -qm init`
const ctx28 = await v2Setup(d28)
ctx28.sessions.set("ses-main", { title: "main" })
await afterTool(ctx28, {
  sessionID: "ses-main",
  tool: "apply_patch",
  input: { patchText: "*** Begin Patch\n*** Update File: notes.txt\n+x\n*** End Patch" },
  result: { metadata: { files: [] } },
  status: "completed",
})
await writeFile(join(d28, "notes.txt"), "hello\nx")
await firePrompt(ctx28, { sessionID: "ses-main", messageID: "msg-28", prompt: { text: "go" } })
const staged28 = await stagedFiles(d28)
const v2Journal28 = await readFile("/tmp/opencode-git-add.log", "utf8").catch(() => "")
const ok28 =
  staged28.length === 1 &&
  staged28[0] === "notes.txt" &&
  v2Journal28.split("\n").some((l) => l.includes(`dir=${d28}`) && l.includes("src=patchText"))

// 29. result metadata files are authoritative: the metadata filePath
//     (absolute) is tracked with src=metadata, and the patchText headers
//     are NOT parsed when metadata is present (ghost.txt must not be staged)
const d29 = join(base, "v2-apply-patch-metadata")
await mkdir(d29, { recursive: true })
await bun$`git init -q ${d29}`
await writeFile(join(d29, "meta.txt"), "hello")
await bun$`git -C ${d29} add meta.txt && git -C ${d29} commit -qm init`
const ctx29 = await v2Setup(d29)
ctx29.sessions.set("ses-main", { title: "main" })
await afterTool(ctx29, {
  sessionID: "ses-main",
  tool: "apply_patch",
  input: { patchText: "*** Begin Patch\n*** Update File: ghost.txt\n+x\n*** End Patch" },
  result: { metadata: { files: [{ filePath: join(d29, "meta.txt") }] } },
  status: "completed",
})
await writeFile(join(d29, "meta.txt"), "hello\nx")
await firePrompt(ctx29, { sessionID: "ses-main", messageID: "msg-29", prompt: { text: "go" } })
const staged29 = await stagedFiles(d29)
const v2Journal29 = await readFile("/tmp/opencode-git-add.log", "utf8").catch(() => "")
const ok29 =
  staged29.length === 1 &&
  staged29[0] === "meta.txt" &&
  v2Journal29.split("\n").some((l) => l.includes(`dir=${d29}`) && l.includes("src=metadata"))

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
console.log("14. git add failure retries without blocking:", ok14, ok14b, `attempts=${d14Attempts} stderrCaptured=${stderrCaptured}`)
console.log("15. v2 write tracked, staged next prompt only, unrelated untouched:", ok15, staged15)
console.log("16. v2 subagent edit (abs path) tracked; child prompt skipped; main prompt stages:", ok16)
console.log("17. v2 no tracked writes -> nothing staged:", ok17)
console.log("18. v2 non-completed tool status not tracked:", ok18)
console.log("19. v2 outside-project path not tracked:", ok19)
console.log("20. v2 apply_patch patchText header tracked, staged next prompt:", ok20, staged20)
console.log("21. v2 dedup fires once:", ok21)
console.log("22. v2 custom title pattern skipped:", ok22)
console.log("23. v2 session lookup failure skipped:", ok23)
console.log("24. v2 no .git skipped:", ok24)
console.log("25. v2 staging failure retries without blocking:", ok25, ok25b, `attempts=${d25Attempts}`)
console.log("26. v2 apply_patch all header forms (update/add/delete/rename/move-to):", ok26)
console.log("27. v2 apply_patch garbage patchText not tracked:", ok27)
console.log("28. v2 apply_patch empty metadata falls back to patchText:", ok28)
console.log("29. v2 apply_patch metadata files authoritative (src=metadata):", ok29)

if (
  !ok1 || !ok2 || !ok3 || !ok4 || !ok5 || !ok6 || !ok7 || !ok8 || !ok9 || !ok10 || !ok11 || !ok12 ||
  !ok13 || !ok14 || !ok14b || !ok15 || !ok16 || !ok17 || !ok18 || !ok19 || !ok20 || !ok21 || !ok22 ||
  !ok23 || !ok24 || !ok25 || !ok25b || !ok26 || !ok27 || !ok28 || !ok29
) {
  failures++
}

await rm(base, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
