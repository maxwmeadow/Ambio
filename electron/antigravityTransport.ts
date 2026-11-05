import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ModelOption } from '../src/shared/agentDelivery.ts'
import type { DriverLauncher } from './agentDrivers.ts'
import { AcpClient } from './acpClient.ts'

/** Combine vendor catalogs; no model-family or client-identity guesses. */
export function antigravityOptions(print: ModelOption[], session: any): ModelOption[] {
  const legacy: Array<{ modelId: string; name: string }> = session?.models?.availableModels ?? []
  const config: any[] = session?.configOptions ?? []
  const choices = (option: any): any[] => (option?.options ?? []).flatMap((item: any) => Array.isArray(item.options) ? item.options : [item])
  const model = config.find(option => option.category === 'model' || option.id === 'model')
  const thought = config.find(option => option.category === 'thought_level' || option.id === 'thought_level')
  const thinkingLevels = choices(thought).map(item => ({ id: item.value, label: item.name }))
  const acp: ModelOption[] = choices(model).map(item => ({
    id: item.value, label: item.name, transport: 'acp',
    aliases: legacy.filter(entry => entry.modelId === item.value || thinkingLevels.some(level => entry.modelId === `${item.value}-${level.id}`)).map(entry => entry.modelId),
    ...(thinkingLevels.length ? { thinkingLevels, defaultThinking: thought.currentValue } : {}),
  }))
  for (const entry of legacy) if (!acp.some(item => item.id === entry.modelId || item.aliases?.includes(entry.modelId))) acp.push({ id: entry.modelId, label: entry.name, transport: 'acp' })
  for (const option of acp) option.printIds = print.filter(item => item.id === option.id || option.aliases?.includes(item.id)).map(item => item.id)
  return [...acp, ...print.filter(entry => !acp.some(item => item.id === entry.id || item.aliases?.includes(entry.id))).map(entry => ({ ...entry, transport: 'print' as const }))]
}

/** An explicit model chooses the transport once; retained sessions never change it. */
export function antigravityRoute(models: ModelOption[], selected: string | undefined, pinned?: 'acp' | 'print', thinking?: string): { transport: 'acp' | 'print'; model?: string; thinking?: string } {
  const option = selected ? models.find(item => item.id === selected || item.aliases?.includes(selected)) : undefined
  if (selected && !option && pinned !== 'print') throw new Error('Antigravity did not report this model. Refresh its models or start a new conversation.')
  const transport = pinned ?? option?.transport ?? 'print'
  const level = thinking ?? option?.thinkingLevels?.find(level => selected === `${option.id}-${level.id}`)?.id
  if (transport === 'acp' && selected && option?.transport !== 'acp') throw new Error('This conversation uses Antigravity’s Gemini connection. Start a new conversation to use this model; your existing conversation is kept.')
  // A retained print conversation can still use models also offered over ACP.
  if (transport === 'print' && option?.transport === 'acp') {
    const alias = level ? option.printIds?.find(id => id === `${option.id}-${level}`)
      : option.printIds?.find(id => id === selected) ?? option.printIds?.find(id => id === `${option.id}-${option.defaultThinking}`) ?? option.printIds?.[0]
    if (!alias) throw new Error('This model is only offered through the Gemini connection. Start a new conversation to use it.')
    return { transport, model: alias }
  }
  return { transport, ...(selected ? { model: transport === 'acp' ? option!.id : selected } : {}), ...(transport === 'acp' && level ? { thinking: level } : {}) }
}

/** Inspect one empty vendor session. No prompt, tools, credential copying or MCP. */
export function inspectAntigravity(launcher: DriverLauncher, spawnProcess: typeof spawn = spawn): Promise<any> {
  return new Promise(resolve => {
    const cwd = fs.mkdtempSync(join(tmpdir(), 'ambio-agy-catalog-'))
    const child = spawnProcess(launcher.command, [...launcher.args, 'acp'], { cwd, shell: false, windowsHide: true, env: { ...process.env, ...(launcher.bundledNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }, stdio: ['pipe', 'pipe', 'ignore'] })
    let buffer = '', finished = false
    const client = new AcpClient({ cwd, prompt: '', mode: 'ask', mcpServers: [], send: line => child.stdin?.write(`${line}\n`), onSession: () => {}, onEvent: () => {} })
    const finish = (session?: any) => {
      if (finished) return
      finished = true; clearTimeout(timer); client.close(); child.stdin?.end(); child.kill(); resolve(session)
    }
    const timer = setTimeout(() => finish(), 30000)
    child.stdin?.on('error', () => {})
    child.on('error', () => finish())
    child.on('close', () => {
      finish()
      // Only the scratch directory created above is removed, after process exit.
      fs.rm(cwd, { recursive: true, force: true }, () => {})
    })
    child.stdout?.on('data', chunk => {
      buffer += chunk.toString()
      if (buffer.length > 1024 * 1024) { finish(); return }
      const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? ''
      for (const line of lines) client.receive(line)
    })
    child.once('spawn', () => { void client.open().then(async session => { await client.disposeSession(); finish(session) }, () => finish()).catch(() => finish()) })
  })
}
