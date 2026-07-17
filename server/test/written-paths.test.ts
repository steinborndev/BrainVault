import { describe, it, expect } from 'vitest'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { extractWrittenPaths } from '../src/pipeline/written-paths.js'

const VAULT = '/home/x/vault'

function assistant(blocks: unknown[]): SDKMessage {
  return { type: 'assistant', message: { content: blocks } } as never
}

describe('extractWrittenPaths', () => {
  it('captures Write/Edit file paths, made vault-relative', () => {
    const msg = assistant([
      { type: 'text', text: 'writing' },
      { type: 'tool_use', name: 'Write', input: { file_path: `${VAULT}/wiki/concepts/Foo.md` } },
      { type: 'tool_use', name: 'Edit', input: { file_path: `${VAULT}/wiki/index.md` } },
    ])
    expect(extractWrittenPaths(msg, VAULT).sort()).toEqual(['wiki/concepts/Foo.md', 'wiki/index.md'])
  })

  it('captures MultiEdit edits[] paths', () => {
    const msg = assistant([
      {
        type: 'tool_use',
        name: 'MultiEdit',
        input: { edits: [{ file_path: `${VAULT}/wiki/a.md` }, { file_path: `${VAULT}/wiki/b.md` }] },
      },
    ])
    expect(extractWrittenPaths(msg, VAULT).sort()).toEqual(['wiki/a.md', 'wiki/b.md'])
  })

  it('ignores non-write tools and read-only blocks', () => {
    const msg = assistant([
      { type: 'tool_use', name: 'Read', input: { file_path: `${VAULT}/wiki/x.md` } },
      { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
    ])
    expect(extractWrittenPaths(msg, VAULT)).toEqual([])
  })

  it('drops paths outside the vault (defensive)', () => {
    const msg = assistant([{ type: 'tool_use', name: 'Write', input: { file_path: '/etc/passwd' } }])
    expect(extractWrittenPaths(msg, VAULT)).toEqual([])
  })

  it('returns nothing for non-assistant messages', () => {
    expect(extractWrittenPaths({ type: 'result' } as never, VAULT)).toEqual([])
  })
})
