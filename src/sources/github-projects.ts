/**
 * Moves the Issues a merged PR resolved to the team's test column on GitHub Projects (v2).
 * Runs after the Ticket ends, because a merge starts no Executor turn: a project board has no message to reply to.
 * Each project names its columns differently, so the column is chosen by matching the configured hint against the
 * options the project actually offers, and a column that means "finished" is never chosen.
 */
import { z } from 'zod'
import type { Commands } from '../infra/commands.ts'

/** Words that mean a column is past testing; a merge must not move work into one of them. */
const FINISHED = ['pass', 'fail', 'done', 'complete', 'closed', 'released', 'cancel', 'fix']

const Option = z.object({ id: z.string(), name: z.string() })
const Field = z.object({ id: z.string(), name: z.string(), options: z.array(Option) })
const FieldValue = z.looseObject({
  name: z.string().nullish(),
  optionId: z.string().nullish(),
  field: Field.nullish(),
})
const Item = z.object({
  id: z.string(),
  project: z.object({ id: z.string(), number: z.number(), title: z.string() }),
  fieldValues: z.object({ nodes: z.array(FieldValue) }),
})
const IssueItems = z.object({
  data: z.object({ repository: z.object({ issue: z.object({ projectItems: z.object({ nodes: z.array(Item) }) }).nullish() }).nullish() }),
})
const ProjectFields = z.object({
  data: z.object({ node: z.object({ fields: z.object({ nodes: z.array(Field.nullish()) }) }).nullish() }),
})

const ITEMS_QUERY = `query($owner:String!,$repo:String!,$n:Int!){repository(owner:$owner,name:$repo){issue(number:$n){projectItems(first:10){nodes{id project{id number title} fieldValues(first:50){nodes{... on ProjectV2ItemFieldSingleSelectValue{name optionId field{... on ProjectV2SingleSelectField{id name options{id name}}}}}}}}}}}`
const FIELDS_QUERY = `query($project:ID!){node(id:$project){... on ProjectV2{fields(first:50){nodes{... on ProjectV2SingleSelectField{id name options{id name}}}}}}}`
const SET_MUTATION = `mutation($project:ID!,$item:ID!,$field:ID!,$option:String!){updateProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field,value:{singleSelectOptionId:$option}}){projectV2Item{id}}}`

export type StatusOption = z.infer<typeof Option>
export type StatusField = z.infer<typeof Field>
type FieldValues = z.infer<typeof FieldValue>[]

/** Ranks a column name for the hint; 0 means it is not a candidate. */
export function scoreOption(name: string, hint: string): number {
  const lower = name.toLowerCase()
  const wanted = hint.toLowerCase()
  if (!wanted) return 0
  const finished = FINISHED.find(word => lower.includes(word))
  // A column that means finished is only eligible when the hint itself names that state.
  if (finished && !wanted.includes(finished)) return 0
  if (lower === wanted) return 100
  if (lower.startsWith(wanted)) return 90
  if (lower.includes(wanted)) return 80
  if (lower.includes('test')) return 60
  if (wanted === 'test' && lower.startsWith('qa')) return 50
  return 0
}

/** The column whose name best matches the hint, or undefined when nothing matches. */
export function pickOption(options: readonly StatusOption[], hint: string): StatusOption | undefined {
  const ranked = [...options].sort((a, b) => scoreOption(b.name, hint) - scoreOption(a.name, hint))
  const best = ranked[0]
  return best && scoreOption(best.name, hint) > 0 ? best : undefined
}

/** The single-select Status field carried by an item's field values. */
export function statusFieldOf(values: FieldValues): StatusField | undefined {
  for (const value of values) {
    const field = value.field
    if (field && field.name.toLowerCase().includes('status')) return field
  }
  return undefined
}

const split = (repository: string): [string, string] => {
  const [owner, name] = repository.split('/')
  if (!owner || !name) throw new Error(`Invalid repository ${repository}`)
  return [owner, name]
}

async function itemsOf(commands: Commands, repository: string, issue: number): Promise<z.infer<typeof Item>[]> {
  const [owner, repo] = split(repository)
  const response = await commands.api(IssueItems, 'graphql', '-f', `query=${ITEMS_QUERY}`,
    '-f', `owner=${owner}`, '-f', `repo=${repo}`, '-F', `n=${issue}`)
  return response.data.repository?.issue?.projectItems.nodes ?? []
}

async function statusFieldOfProject(commands: Commands, project: string): Promise<StatusField | undefined> {
  const response = await commands.api(ProjectFields, 'graphql', '-f', `query=${FIELDS_QUERY}`, '-f', `project=${project}`)
  for (const field of response.data.node?.fields.nodes ?? []) {
    if (field && field.name.toLowerCase().includes('status')) return field
  }
  return undefined
}

export interface StatusMove {
  /** One line per Issue and project, for the Thread's facts. */
  readonly lines: string[]
  /** True when every Issue the board knows about was moved or was already there. */
  readonly ok: boolean
}

/**
 * Moves each Issue to the column matching `hint` on every project it belongs to.
 * An Issue on no project is reported, not treated as a failure: the repository may never use a board.
 */
export async function moveIssuesToStatus(commands: Commands, repository: string, issues: readonly number[], hint: string): Promise<StatusMove> {
  const lines: string[] = []
  let ok = true
  for (const issue of issues) {
    const items = await itemsOf(commands, repository, issue)
    if (!items.length) {
      lines.push(`#${issue}: not on a project`)
      continue
    }
    for (const item of items) {
      const field = statusFieldOf(item.fieldValues.nodes) ?? await statusFieldOfProject(commands, item.project.id)
      if (!field) {
        lines.push(`#${issue} [${item.project.title}]: no Status field`)
        ok = false
        continue
      }
      const option = pickOption(field.options, hint)
      if (!option) {
        lines.push(`#${issue} [${item.project.title}]: no column matches "${hint}" (${field.options.map(item => item.name).join(', ')})`)
        ok = false
        continue
      }
      const current = statusFieldOf(item.fieldValues.nodes)
        ? item.fieldValues.nodes.find(value => value.field?.id === field.id)?.name ?? undefined
        : undefined
      if (current === option.name) {
        lines.push(`#${issue} [${item.project.title}]: already ${option.name}`)
        continue
      }
      await commands.api(z.unknown(), 'graphql', '-f', `query=${SET_MUTATION}`,
        '-f', `project=${item.project.id}`, '-f', `item=${item.id}`, '-f', `field=${field.id}`, '-f', `option=${option.id}`)
      lines.push(`#${issue} [${item.project.title}]: ${current ?? 'unset'} -> ${option.name}`)
    }
  }
  return { lines, ok }
}
