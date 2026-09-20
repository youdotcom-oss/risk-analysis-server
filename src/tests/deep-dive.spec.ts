import { describe, expect, test } from 'bun:test'
import type { SystemOneCaller } from '../services/jev.ts'
import { createDeepDiveTools } from '../services/you.ts'

const profile = {
  title: 'EU port operations',
  locations: ['Hamburg Port'],
  triggers: ['strike action', 'customs delay'],
}

function jevWithProbability(probability: number): SystemOneCaller {
  return {
    systemOne(request: unknown) {
      const keys = Object.keys((request as { questions: Record<string, unknown> }).questions)
      const answers = Object.fromEntries(keys.map((key) => [key, { type: 'noul', noul: probability }]))
      return Promise.resolve({ answers }) as never
    },
  } as unknown as SystemOneCaller
}

function stubMcpTools() {
  const searchCalls: { input: Record<string, unknown>; options: unknown }[] = []
  const tools = {
    'you-search': {
      description: 'search',
      inputSchema: {
        jsonSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            knowledge: { type: 'string' },
          },
          required: ['query', 'knowledge'],
          additionalProperties: false,
          $schema: 'https://json-schema.org/draft/2020-12/schema',
        },
      },
      async execute(input: Record<string, unknown>, options: unknown) {
        searchCalls.push({ input, options })
        return { content: [{ type: 'text', text: 'results' }] }
      },
    },
    'you-contents': {
      inputSchema: {
        jsonSchema: { type: 'object', properties: { urls: { type: 'array' } } },
      },
      async execute() {
        return { content: [{ type: 'text', text: 'markdown' }] }
      },
    },
  }
  return { tools, searchCalls }
}

function stubClient(tools: unknown) {
  return {
    tools: () => Promise.resolve(tools),
  } as Parameters<typeof createDeepDiveTools>[0]['client']
}

describe('createDeepDiveTools', () => {
  test('strips knowledge from the model-visible schema', async () => {
    const { tools } = stubMcpTools()
    const wrapped = await createDeepDiveTools({
      client: stubClient(tools),
      jev: jevWithProbability(0.9),
      profile,
    })
    const tool = wrapped['you-search'] as { inputSchema: { jsonSchema: Record<string, unknown> } }
    const schema = tool.inputSchema.jsonSchema
    expect(schema.properties && 'knowledge' in (schema.properties as object)).toBe(false)
    expect(schema.required).toEqual(['query'])
  })

  test('injects knowledge=core server-bound on execute', async () => {
    const { tools, searchCalls } = stubMcpTools()
    const wrapped = await createDeepDiveTools({
      client: stubClient(tools),
      jev: jevWithProbability(0.9),
      profile,
    })
    const tool = wrapped['you-search'] as { execute: (input: unknown, options?: unknown) => Promise<unknown> }
    await tool.execute({ query: 'Hamburg Port strike' }, { toolCallId: 't1' })
    expect(searchCalls).toHaveLength(1)
    expect(searchCalls[0]?.input).toEqual({ query: 'Hamburg Port strike', knowledge: 'core' })
  })

  test('rejects weak queries before they reach you.com', async () => {
    const { tools, searchCalls } = stubMcpTools()
    const wrapped = await createDeepDiveTools({
      client: stubClient(tools),
      jev: jevWithProbability(0.1),
      profile,
    })
    const tool = wrapped['you-search'] as { execute: (input: unknown) => Promise<unknown> }
    const result = (await tool.execute({ query: 'stuff' })) as {
      content: { type: string; text: string }[]
    }
    expect(searchCalls).toHaveLength(0)
    expect(result.content[0]?.type).toBe('text')
    expect(result.content[0]?.text).toContain('rejected')
  })

  test('passes other tools through untouched', async () => {
    const { tools } = stubMcpTools()
    const wrapped = await createDeepDiveTools({
      client: stubClient(tools),
      jev: jevWithProbability(0.9),
      profile,
    })
    expect(wrapped['you-contents']).toBe(tools['you-contents'])
  })
})
