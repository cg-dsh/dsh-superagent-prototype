import { describe, expect, it } from 'vitest'
import { pickOption, scoreOption, statusFieldOf, type StatusOption } from '../src/sources/github-projects.ts'

const option = (name: string): StatusOption => ({ id: name, name })

describe('the project column a merged PR moves to', () => {
  it('prefers an exact name, then a prefix, then a contained word', () => {
    expect(scoreOption('Testing', 'testing')).toBeGreaterThan(scoreOption('Waiting for testing', 'testing'))
    expect(scoreOption('Testing/Waiting for test', 'test')).toBeGreaterThan(scoreOption('In test', 'test'))
    expect(scoreOption('In test', 'test')).toBeGreaterThan(0)
  })

  it('never chooses a finished column, even when it contains the hint', () => {
    for (const name of ['Tests passed', 'Done', 'Completed', 'Closed', 'Released', 'Cancelled']) {
      expect(scoreOption(name, 'test')).toBe(0)
    }
    expect(pickOption([option('Tests passed'), option('Done')], 'test')).toBeUndefined()
  })

  it('falls back to a QA column when the hint finds nothing else', () => {
    expect(pickOption([option('QA'), option('In Progress')], 'test')?.name).toBe('QA')
  })

  it('returns nothing rather than guessing when no column matches', () => {
    expect(pickOption([option('Triaged'), option('In Progress')], 'test')).toBeUndefined()
  })

  it('picks the closest column on a board whose names differ from ours', () => {
    const board = [option('Todo'), option('Triaged'), option('Testing/Waiting for test'), option('Done')]
    expect(pickOption(board, 'test')?.name).toBe('Testing/Waiting for test')
  })
})

describe('the Status field of a project item', () => {
  const field = { id: 'f', name: 'Status', options: [option('Testing')] }

  it('finds the single-select field it is given', () => {
    expect(statusFieldOf([{ name: 'Testing', field }])?.id).toBe('f')
  })

  it('ignores fields of other names and values without a field', () => {
    expect(statusFieldOf([{ name: 'x', field: { id: 'g', name: 'Size', options: [] } }, {}])).toBeUndefined()
  })
})
