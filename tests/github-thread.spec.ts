/** Cover the thread identity that keeps the primary repository's ids unchanged. */

import { describe, expect, it } from 'vitest'
import { githubThreadId, sameRepository, threadNumber, threadRepository } from '../src/sources/github-thread.ts'

const primary = 'Catglobe/Catglobe'

describe('GitHub thread identity', () => {
  it('keeps the bare number for the primary repository, so stored threads and cursors stay valid', () => {
    expect(githubThreadId(primary, 42, primary)).toBe('42')
    expect(githubThreadId('catglobe/CATGLOBE', 42, primary)).toBe('42')
  })

  it('qualifies any other repository with its own owner and name', () => {
    expect(githubThreadId('Catglobe/Designer', 42, primary)).toBe('Catglobe/Designer#42')
  })

  it('reads the number from either form', () => {
    expect(threadNumber('42')).toBe(42)
    expect(threadNumber('Catglobe/Designer#42')).toBe(42)
  })

  it('reads a bare id as the primary repository', () => {
    expect(threadRepository('42', primary)).toBe(primary)
    expect(threadRepository('Catglobe/Designer#42', primary)).toBe('Catglobe/Designer')
  })

  it('compares repository names the way GitHub does', () => {
    expect(sameRepository('Catglobe/Catglobe', 'catglobe/catglobe')).toBe(true)
    expect(sameRepository('Catglobe/Catglobe', 'Catglobe/Designer')).toBe(false)
  })
})
