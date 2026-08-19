/**
 * loader-compat.ts — inline replacements for the DSH helper imports the
 * original plugin used at runtime (`@deepseek-ai/dsh-tools`'s defineTool and
 * `@deepseek-ai/dsh-settings`'s settingsNamespace / SettingsConflictError).
 *
 * This transcription (dsh-better-sidebar-loader) programs ONLY against
 * dshloader's stable API (`ctx.dshLoader`) and must not import
 * `@deepseek-ai/*` at runtime. These three helpers are small, stable
 * shapes with no dsh-internal coupling, so they are inlined here:
 *
 *   - defineTool: compiles a per-property parameter spec into an
 *     object-rooted JSON Schema and assembles the registry-ready tool
 *     descriptor (same wire shape the real dsh-tools `register` consumes).
 *   - settingsNamespace: validates a settings namespace against the same
 *     pattern the settings service enforces (^[a-z][a-z0-9-]*$).
 *   - isSettingsConflict: duck-types the settings conflict error by its
 *     stable name/code instead of importing the class.
 */

// Type-only import (erased at build): the runtime never loads
// @deepseek-ai/dsh-tools — this transcription only needs the
// ToolRunContext type to keep the terminal tools' execute signatures typed.
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

/** The settings-namespace pattern (mirrors the settings service's check). */
const NAMESPACE_PATTERN = /^[a-z][a-z0-9-]*$/

/** Validate a settings namespace string (throws TypeError when invalid). */
export function settingsNamespace(value: string): string {
  if (!NAMESPACE_PATTERN.test(value)) {
    throw new TypeError(`settings namespace "${value}" must match ${String(NAMESPACE_PATTERN)}`)
  }
  return value
}

/** Whether an unknown thrown value is the settings conflict (revision guard). */
export function isSettingsConflict(error: unknown): error is Error & { expected?: unknown; actual?: unknown } {
  if (error === null || typeof error !== 'object') return false
  return (
    (error as Error).name === 'SettingsConflictError'
    || (error as { code?: unknown }).code === 'SETTINGS_CONFLICT'
    || ('expected' in error && 'actual' in error)
  )
}

/** A JSON-Schema-ish per-property parameter spec (one property definition). */
export interface ParameterPropertySpec {
  type: string
  required?: boolean
  description?: string
  [key: string]: unknown
}

/** Compile the per-property parameter map into an object-rooted JSON Schema. */
export function compileParameters(spec: Record<string, ParameterPropertySpec>) {
  const required: string[] = []
  const properties: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(spec)) {
    const { required: isRequired, ...rest } = value
    properties[key] = rest
    if (isRequired) required.push(key)
  }
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  }
}

/** Renderer-return type accepted by the tools registry (text or blocks). */
type ToolRenderValue = string | readonly unknown[] | Record<string, unknown>

/**
 * Inline replacement for `@deepseek-ai/dsh-tools`'s defineTool. Builds the
 * registry-ready tool descriptor from the same options shape the original
 * plugin passed. `parameters` is a per-property spec (compiled here);
 * `output.schema` is passed through unchanged.
 */
export function defineTool<Args, Exec = ToolRunContext>(options: {
  name: string
  description: string
  parameters: Record<string, ParameterPropertySpec>
  output: {
    schema: Record<string, unknown>
    render: (args: unknown, value: ToolRenderValue) => unknown
    presentationMeta?: (args: unknown, value: unknown) => unknown
  }
  timeoutMs?: number
  finalizeContent?: (exec: Exec, result: unknown) => unknown
  execute: (args: Args, exec: Exec) => unknown
}) {
  const userRender = options.output.render
  const userPresentationMeta = options.output.presentationMeta
  const userExecute = options.execute
  const tool: Record<string, unknown> = {
    name: options.name,
    description: options.description,
    parameters: compileParameters(options.parameters),
    output: {
      schema: options.output.schema,
      render: (args: unknown, value: ToolRenderValue) => userRender(args, value),
      ...(userPresentationMeta !== undefined ? { presentationMeta: userPresentationMeta } : {}),
    },
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  }
  if (userExecute !== undefined) tool.execute = userExecute
  if (options.finalizeContent !== undefined) tool.finalizeContent = options.finalizeContent
  return tool
}