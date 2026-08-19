# @dsh-plugin/dsh-better-sidebar-loader

Transcription of **dsh-better-sidebar** (VSCode-style right sidebar: explorer /
editor / terminal / git / browser) whose **host half** programs ONLY against
dshloader's stable API (`ctx.dshLoader`) — zero direct dsh service access and
zero `@deepseek-ai/*` runtime imports on the host.

## API mapping (host)

| original (dsh-better-sidebar) | this plugin (dshloader API) |
| --- | --- |
| `inject = ['webServer','sessions','webRuntime','tools']` | `inject = ['dshLoader']` |
| `ctx.webServer.register({kind:'prefix',...})` | `ctx.dshLoader.web.register(path, handler)` |
| `ctx.webServer.registerUpgrade(...)` | `ctx.dshLoader.web.registerUpgrade({path, handler})` |
| `ctx.inject(['settings'], sctx => sctx.settings.register(...))` | `ctx.dshLoader.settings.register(ns, schema)` |
| `sctx.settings.describe/update` | `ctx.dshLoader.settings` (owner scope get() + update envelope) |
| `ctx.sessions / ctx.webRuntime / ctx.tools` | `ctx.dshLoader.services.get('sessions'/'webRuntime'/'tools')` |
| `ctx.get('jobs'/'agents')` | `ctx.dshLoader.services.get('jobs'/'agents')` |
| `@deepseek-ai/dsh-tools` defineTool | inlined `src/loader-compat.ts` |
| `@deepseek-ai/dsh-settings` settingsNamespace / SettingsConflictError | inlined `src/loader-compat.ts` |

`ctx.dshLoader.services.get()` is the documented escape hatch for services
with no dedicated loader surface (sessions / webRuntime / tools / jobs /
agents / invariants); the loader itself resolves the real dsh service name.

## Client half

The client bundle registers under the package name
`@dsh-plugin/dsh-better-sidebar-loader` and mounts through `dsh.client.inject` (the
platform contract). Every `@deepseek-ai/dsh-client-*` import is rewritten
to dshloader's stable subpaths — `@dsh-plugin/dsh-loader/ui-primitives`,
`/ui-slots`, `/ui-settings`, `/schema-form`, `/runtime` — which the loader's
client adapter maps to the real packages at runtime, so the plugin carries
**zero `@deepseek-ai/*` dependencies or imports** (except type-only
declarations erased at build). The build's `CLIENT_EXTERNALS` lists the
loader subpaths; package.json keeps only `@dsh-plugin/dsh-loader` as its
dsh-family dependency. The two inject-free `ctx.get(...)` calls (remote /
conversation) go through `window.__dshLoader__.services.get(...)`, and
declared injected services (slots / sessions / connection / workspaces /
locale) stay on the cordis context as every official client plugin does.

## Build

```sh
pnpm build   # tsc types + tsdown (host + client bundles + lazy chunks)
```
