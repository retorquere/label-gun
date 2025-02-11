import * as core from '@actions/core'
import { context, getOctokit } from '@actions/github'
import { graphql } from '@octokit/graphql'
import { RequestError } from '@octokit/request-error'
import { Issue, IssueComment, ProjectsV2Item } from '@octokit/webhooks-types'
import { OrgProjectV2FieldsQuery, UserProjectV2FieldsQuery } from './types'
import { CreateCardMutation, ProjectCardForIssueQuery, UpdateCardMutation } from './types'

const sender: string = context.payload.sender?.login || ''
const bot: boolean = context.payload.sender?.type === 'Bot'
const owner: string = context.payload.repository?.owner?.login || ''
const repo: string = context.payload.repository?.name || ''

function getEnum(i: string, options: string[], dflt?: string): string {
  if (!options.length) throw new Error(`enum ${i} needs options`)
  if (!dflt) dflt = options[0]
  if (!options.includes(dflt)) throw new Error(`Default ${JSON.stringify(dflt)} must be one of ${JSON.stringify(options)}`)
  const o = core.getInput(i) || dflt
  if (options.includes(o)) return o
  const mapped = options.find(_ => _.toLowerCase() === o.toLowerCase())
  if (mapped) return mapped
  throw new Error(`Default ${JSON.stringify(o)} must be one of ${JSON.stringify(options)}`)
}

function getBool(i: string, dlft: 'true' | 'false' = 'false'): boolean {
  return getEnum(i, ['false', 'true']) === 'true'
}

function getString(i: string, required = false) {
  const s = core.getInput(i) || ''
  if (!s && required) throw new Error(`missing value for ${i}`)
  return s
}

const input = {
  label: {
    exempt: getString('label.exempt'),
    active: getString('label.active'),
    awaiting: getString('label.awaiting'),
    reopened: getString('label.reopened'),
    merge: getString('label.merge'),
  },

  log: {
    regex: core.getInput('log.regex') ? new RegExp(core.getInput('log.regex')) : (undefined as unknown as RegExp),
    message: getString('log.message'),
    label: getString('log.label'),
  },

  assignee: getString('assign'),
  issue: {
    state: getEnum('issue.state', ['all', 'open', 'closed']) as 'all' | 'open' | 'closed',
  },

  verbose: getBool('verbose', 'false'),

  project: {
    token: core.getInput('project.token') || core.getInput('token') || '',
    url: getString('project.url'),
    state: {
      merge: getString('project.state.merge'),
      assigned: getString('project.state.assigned'),
      waiting: getString('project.state.waiting'),
    },
    field: {
      startDate: core.getInput('project.field.startDate') || 'Start date',
      endDate: core.getInput('project.field.endDate') || 'End date',
      status: core.getInput('project.field.status') || 'Status',
    },
  },
}

const token = core.getInput('token', { required: true })
const octokit = getOctokit(token)

if (input.verbose) console.log(input)

const Project = new class {
  public q = {
    fields: {
      user: require('./get/user-project-fields.graphql'),
      org: require('./get/org-project-fields.graphql'),
    },
    get: require('./get/card.graphql'),
    update: require('./put/update.graphql'),
    create: require('./put/create.graphql'),
  }

  public owner: string = ''
  public type: 'user' | 'org' = 'org'
  public number: number = 0
  public id: string = ''
  public field: Record<string, string> = {}
  public state: Record<string, string> = {}

  constructor() {
    if (input.project.url) {
      const m = input.project.url.match(/https:\/\/github.com\/(users|orgs)\/([^/]+)\/projects\/(\d+)/)
      if (!m) throw new Error(`${input.project.url} is not a valid project URL`)
      const [, type, owner, number] = m
      this.type = type === 'users' ? 'user' : 'org'
      this.owner = owner
      this.number = parseInt(number)
    }
  }

  async load() {
    if (!input.project.url) return

    const data = await graphql<UserProjectV2FieldsQuery | OrgProjectV2FieldsQuery>(Project.q.fields[this.type], {
      owner: this.owner,
      projectNumber: this.number,
      headers: {
        authorization: `Bearer ${input.project.token}`,
      },
    })
    const project = data?.owner?.projectV2
    if (!project) throw new Error(`project ${JSON.stringify(input.project.url)} not found`)
    this.id = project.id

    const fields = project.fields
    if (!fields) throw new Error(`fields for ${JSON.stringify(input.project.url)} not found`)

    for (const [field, label] of Object.entries(input.project.field)) {
      if (!label) continue

      const pf = fields.nodes?.find(f => f && f.id && f.name && f.name === label)
      if (!pf) throw new Error(`${field} label ${JSON.stringify(label)} not found`)
      this.field[field] = pf.id

      if (pf.__typename === 'ProjectV2SingleSelectField' && field === 'status') {
        for (const [state, name] of Object.entries(input.project.state)) {
          if (!name) continue

          const _ = pf.options.find(o => o.name === name)
          if (!_) throw new Error(`card state ${JSON.stringify(name)} not found`)
          this.state[state] = _.id
        }
      }
    }
  }

  async get(issue: Issue): Promise<string> {
    if (input.verbose) console.log('get card', { issue, owner: this.owner, projectNumber: this.number })

    const data = await graphql<ProjectCardForIssueQuery>(Project.q.get, {
      owner: this.owner,
      projectNumber: this.number,
      headers: {
        authorization: `Bearer ${input.project.token}`,
      },
    })

    let card = data.repository?.issue?.projectItems.nodes?.find(node => (
      node
      && (node.project.owner.__typename === 'Organization' || node.project.owner.__typename === 'User')
      && node.project.owner.login == this.owner
      && node.project.number === this.number
    ))
    if (card) return card.id

    const newCard = await graphql<CreateCardMutation>(Project.q.create, {
      owner: this.id,
      contentId: issue.node_id,
      headers: {
        authorization: `Bearer ${input.project.token}`,
      },
    })
    if (!newCard?.addProjectV2ItemById?.item) throw new Error(`Failed to create card on project ${input.project.url}`)
    return newCard.addProjectV2ItemById.item.id
  }

  async update(itemId: string, state: string, startDate: string) {
    await graphql<UpdateCardMutation>(Project.q.update, {
      projectId: this.id,
      itemId,
      statusFieldId: this.field.status,
      statusValue: this.state[state],
      startDateFieldId: this.field.startDate,
      startDate: startDate,
      endDateFieldId: this.field.endDate,
      endDate: new Date().toISOString().replace(/T.*/, ''),
      headers: {
        authorization: `Bearer ${input.project.token}`,
      },
    })
  }
}()

const User = new class {
  #collaborator: Record<string, boolean> = {}

  async isCollaborator(username?: string, allowBot = false): Promise<boolean> {
    if (!username) return false

    if (username.endsWith('[bot]') || (username === sender && bot)) {
      if (input.verbose) console.log(username, 'is a bot, which we', allowBot ? 'consider' : 'do not consider', 'to be a contributor')
      return allowBot
    }

    if (typeof this.#collaborator[username] !== 'boolean') {
      const { data: user } = await octokit.rest.repos.getCollaboratorPermissionLevel({ owner, repo, username })
      this.#collaborator[username] = user.permission === 'admin'
      if (input.verbose) console.log(username, 'has permission', user.permission, 'and is', this.#collaborator[username] ? 'a' : 'not a', 'contributor')
    }
    return this.#collaborator[username]
  }
}()

async function update(issue: Issue, body: string): Promise<void> {
  if (!issue) throw new Error('No issue found')
  if (input.verbose) console.log('processing issue', issue.number)

  function $labeled(...name: string[]) {
    name = name.filter(_ => _)
    const labeled = (issue!.labels || []).find(label => name.includes(typeof label === 'string' ? label : (label?.name || '')))
    if (input.verbose) console.log('testing whether issue is labeled', name, ':', labeled)
    return labeled
  }
  async function $label(name: string) {
    if (!name || $labeled(name)) return
    if (input.verbose) console.log('labeling', name)
    await octokit.rest.issues.addLabels({ owner, repo, issue_number: issue!.number, labels: [name] })
  }
  async function $unlabel(name: string) {
    if (!name || !$labeled(name)) return
    if (input.verbose) console.log('unlabeling', name)
    try {
      await octokit.rest.issues.removeLabel({ owner, repo, issue_number: issue!.number, name })
    }
    catch (err) {
      if (err instanceof RequestError && err.status !== 404) throw err
    }
  }

  const { data: comments } = await octokit.rest.issues.listComments({ owner, repo, issue_number: issue.number })
  const active = {
    user: false,
    owner: false,
  }
  for (const user of [sender, issue.user.login].concat(comments.map(comment => comment.user?.login || ''))) {
    if (!user) continue

    if (await User.isCollaborator(user)) {
      active.owner = true
    }
    else {
      active.user = true
    }

    if (active.user && active.owner) break
  }
  const managed = active.user && !$labeled(input.label.exempt) && (!input.label.active || $labeled(input.label.active))

  if (input.verbose) {
    console.log({
      active,
      managed,
      label: {
        exempt: $labeled(input.label.exempt),
        active: $labeled(input.label.active),
      },
    })
  }

  if (input.assignee && issue.state === 'closed') {
    const assignees = issue.assignees.map(assignee => assignee.login)
    if (assignees.length) await octokit.rest.issues.removeAssignees({ owner, repo, issue_number: issue.number, assignees })
  }
  else if (active.owner && input.assignee && !issue.assignees.length) {
    const assignee = await User.isCollaborator(sender, false) ? sender : input.assignee
    await octokit.rest.issues.addAssignees({ owner, repo, issue_number: issue.number, assignees: [assignee] })
  }

  if (input.verbose) console.log(sender, 'collaborator:', await User.isCollaborator(sender))

  // collab activity
  if (await User.isCollaborator(sender)) {
    if (context.payload.action != 'edited' && managed) {
      await (issue.state === 'open' ? $label(input.label.awaiting) : $unlabel(input.label.awaiting))
    }
    return
  }

  // user activity
  if (managed && context.payload.action === 'closed') { // user closed the issue
    if (issue.assignees.length && input.label.merge) await $label(input.label.merge)
  }
  else if (managed && context.eventName === 'issue_comment' && issue.state === 'closed') { // user commented on a closed issue
    await octokit.rest.issues.update({ owner, repo, issue_number: issue.number, state: 'open' })
    await $label(input.label.reopened)
  }

  await $unlabel(input.label.awaiting)

  if (managed && input.log.regex) {
    let found = issue.state === 'closed' || !!body.match(input.log.regex)
    if (!found && context.eventName === 'workflow_dispatch') {
      found = !!([issue.body || '', ...(comments.map(comment => comment.body || ''))].find((b: string) => b.match(input.log.regex)))
    }
    if (found) {
      await $unlabel(input.log.label)
    }
    else if (context.eventName === 'issues' && context.payload.action === 'opened' && !$labeled(input.log.label)) { // new issue, missing log
      await $label(input.log.label)
      if (input.log.message && sender) {
        await octokit.rest.issues.createComment({ owner, repo, issue_number: issue.number, body: input.log.message.replace('{{username}}', sender) })
      }
    }
  }

  if (input.project.url) {
    const { data } = await octokit.rest.issues.get({ owner, repo, issue_number: issue.number })
    issue = data as unknown as Issue

    const card = await Project.get(issue)

    if (issue.state === 'closed') {
      if (input.project.state.merge && $labeled(input.label.merge)) await Project.update(card, issue.created_at, Project.state.merge)
    }
    else if (issue.assignees.length) {
      await Project.update(card, issue.created_at, $labeled(input.label.awaiting) ? Project.state.awaiting : Project.state.assigned)
    }
  }
}

/*
octokit.hook.wrap('request', async (request, options) => {
  const start = Date.now()
  try {
    const response = await request(options)
    core.info(stringify({
      request: options,
      time: Date.now() - start
    }))
    return response
  } catch (error) {
    error.time = Date.now() - start
    core.error(error)
    throw error
  }
})
*/

async function run(): Promise<void> {
  try {
    if (!owner || !repo) throw new Error('No repository found')

    await Project.load()

    switch (context.eventName) {
      case 'issues': {
        const issue = context.payload.issue as Issue
        return await update(issue, issue?.body || '')
      }

      case 'issue_comment': {
        const issue = context.payload.issue as Issue
        const comment = context.payload.comment as IssueComment
        return await update(issue, comment?.body || '')
      }

      case 'workflow_dispatch': {
        for (const issue of await octokit.paginate(octokit.rest.issues.listForRepo, { owner, repo, state: input.issue.state, per_page: 100 })) {
          await update(issue as unknown as Issue, '')
        }
        return
      }

      default: {
        throw new Error(`Unexpected event ${context.eventName}`)
      }
    }

    if (input.verbose) console.log('finished')
  }
  catch (err) {
    console.log(err)
    process.exit(1)
  }
}

run()
