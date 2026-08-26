# opencode-git-add

opencode 插件:每轮对话结束后自动执行 `git add .`。

仅在 jujutsu colocated 仓库中生效(即 `.git` 和 `.jj` 同时存在时才执行),避免影响纯 git 或纯 jj 的项目。

## 为什么是插件而不是配置

opencode 的 `opencode.json` 目前不支持任何原生 hook/事件字段(见 [config schema](https://opencode.ai/config.json)),"每轮对话结束后"这类时机只能通过 [插件的事件系统](https://opencode.ai/docs/plugins/#events) 实现,这里用的是 `session.idle` 事件。

## 安装

将 `git-add.ts` 放到全局插件目录(对所有项目生效),或放到具体项目的 `.opencode/plugins/` 下:

```sh
mkdir -p ~/.config/opencode/plugins
cp git-add.ts ~/.config/opencode/plugins/
```

重启 opencode 后生效(配置只在启动时加载一次)。无需改动 `opencode.json`。

## 行为

- 触发时机:`session.idle` —— 每一轮对话(assistant 回复完成、会话进入空闲)后触发一次。`git add .` 是幂等操作,即使空闲事件在会话刚创建时也触发一次,也没有副作用。
- 执行条件:插件启动目录下 `.git` 与 `.jj` **同时存在**(对应 jj git colocated 工作副本),任一缺失则跳过。
- 执行内容:`git add .`(在工作目录内执行,不递归到子项目)。

## 验证

`scripts/verify.ts` 覆盖 5 个场景:.git+.jj 都存在会 staging;仅 .git / 仅 .jj / 都没有时跳过且不报错;非 `session.idle` 事件不触发。运行:

```sh
bun scripts/verify.ts
```

## License

MIT