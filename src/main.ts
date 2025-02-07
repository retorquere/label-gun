import * as core from '@actions/core'
import { context, getOctokit } from '@actions/github'
import { Issue, IssueComment } from '@octokit/webhooks-types'
import { graphql } from '@octokit/graphql'

const sender: string = context.payload.sender?.login || ''
const bot: boolean = context.payload.sender?.type === 'Bot'
const owner: string = context.payload.repository?.owner?.login || ''
const repo: string = context.payload.repository?.name || ''

if (core.getInput('verbose') && !(core.getInput('verbose').match(/^(true|false)$/i))) throw new Error(`Unexpected verbose value ${core.getInput('verbose')}`)

function getState(): 'all' | 'closed' | 'open' {
  const state = core.getInput('state') || 'all'
  switch (state) {
    case 'all':
    case 'closed':
    case 'open':
      return state
    default:
      console.log(`invalid state ${JSON.stringify(state)}, assuming "all"`)
      return 'all'
  }
}
const input = {
  label: {
    awaiting: core.getInput('label.awaiting') || '',
    exempt: core.getInput('label.exempt') || '',
    reopened: core.getInput('label.reopened') || '',
    merge: core.getInput('label.merge') || '',
  },

  log: {
    regex: core.getInput('log.regex') ? new RegExp(core.getInput('log.regex')) : (undefined as unknown as RegExp),
    message: core.getInput('log.message'),
    label: core.getInput('log.label') || '',
  },

  assignee: core.getInput('assign'),
  issue: {
    state: getState(),
  },

  verbose: (core.getInput('verbose') || '').toLowerCase() === 'true',

  project: {
    token: core.getInput('project.token') || core.getInput('token') || '',
    url: core.getInput('project.url') || ''
    state: {
      merge: core.getInput('project.state.merge') || '',
      assigned: core.getInput('project.state.assigned') || '',
      waiting: core.getInput('project.state.waiting') || '',
    },
    field: {
      startDate: core.getInput('project.field.startDate') || 'Start date',
      endDate: core.getInput('project.field.endDate') || 'End date',
      status: core.getInput('project.field.endDatetatus) || 'Status',
    }
  }
}

const token = core.getInput('token', { required: true })
const octokit = getOctokit(token)

if (input.verbose) console.log(input)

const Project = new class {
  public q = {
    fields: require('./fields.graphql')
    get: require('./card.graphql'),
    update: require('./update.graphql')
    create: require('./create.graphql')
  }

  public id: string
  public owner: string = ''
  public type: 'user' | 'organization' | '' = ''
  public number: number = 0
  public field: Record<string, string> = {}
  public state: Record<string, string> = {}

  constructor() {
    if (input.project.url) {
      const m = input.project.url.match(/https:\/\/github.com\/(users|orgs)\/([^/]+)\/projects\/(\d+)/)
      if (!m) throw new Error(`${input.project.url} is not a valid project URL`)
      const [, type, owner, number ] = m
      this.type = type === 'users' ? 'user' : 'organization'
      this.owner = owner
      this.number = parseInt(number)
    }
  }

  async load() {
    if (!input.project.url) return

    const { data: fields } = await graphql({
      query: Project.q.fields,
      variables: {
        owner: this.owner,
        projectNumber: this.number
      },
      headers: {
        authorization: `Bearer ${input.project.token}`
      }
    })

    for (const [field, label] of Object.entries(input.project.fields)) {
      const pf = project.field.nodes.find(f => f.id && f.name && f.name === label)
      this.field[field] = pf.id

      if (field === 'status') {
        for (const [ state, name ] of Object.entries(input.project.state)) {
          this.state[state] = pf.options.find(o => o.name === name).id
        }
      }
    }
  }

  asynd get(issue: Issue): ProjectItem {
    const { data: cards } = await graphql({
      query: Project.q.get,
      variables: {
        owner: this.owner,
        projectNumber: this.number
      },
      headers: {
        authorization: `Bearer ${input.project.token}`
      }
    })

    if (cards.repository?.issue) {
      return cards.repository.issue.projectItems.nodes.find(node => node.project.owner.login = this.owner && node.project.number === this.number).id
    }
    else {
      const { data: card } = await graphql({
        query: Project.q.create,
        variables: {
          owner: this.id,
          contentId: issue.node_id
        },
        headers: {
          authorization: `Bearer ${input.project.token}`
        }
      })

      return card.addProjectV2ItemById.item.id
    }
  }

  update(itemId: string, status: string, startDate: string) {
    const { data: cards } = await graphql({
      query: Project.q.update,
      variables: {
        projectId: this.id,
        itemId,
        statusFieldId: this.field.status,
        statusValue: this.options[`Status.${status}`],
        startDateFieldId: this.field.startDate,
        startDate: startDate,
        endDateFieldId: this.fields.endDate,
        endDate: new Date().toISOString(),
      },
      headers: {
        authorization: `Bearer ${input.project.token}`
      }
    })
  }
}

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
    if (input.verbose) console.log('testing whether issue is labeled', name)
    return (issue!.labels || []).find(label => name.includes(typeof label === 'string' ? label : (label?.name || '')))
  }
  async function $label(name: string) {
    if (!name || $labeled(name)) return
    if (input.verbose) console.log('labeling', name)
    await octokit.rest.issues.addLabels({ owner, repo, issue_number: issue!.number, labels: [name] })
  }
  async function $unlabel(name: string) {
    if (!name || !$labeled(name)) return
    if (input.verbose) console.log('unlabeling', name)
    await octokit.rest.issues.removeLabel({ owner, repo, issue_number: issue!.number, name })
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
  const managed = active.user && !$labeled(input.label.exempt)
  if (input.verbose) console.log({ active, managed, exempt: $labeled(input.label.exempt) })

  if (input.assignee && issue.state === 'closed') {
    const assignees = issue.assignees.map(assignee => assignee.login)
    if (assignees.length) await octokit.rest.issues.removeAssignees({ owner, repo, issue_number: issue.number, assignees })
  }
  else if (active.owner && input.assignee && !issue.assignees.find(assignee => assignee.login)) {
    const assignee = await User.isCollaborator(sender, false) ? sender : input.assignee
    await octokit.rest.issues.addAssignees({ owner, repo, issue_number: issue.number, assignees: [assignee] })
  }

  if (input.verbose) console.log(sender, 'collaborator:', await User.isCollaborator(sender))
  if (await User.isCollaborator(sender)) {
    if (context.payload.action != 'edited' && managed) {
      await (issue.state === 'open' ? $label(input.label.awaiting) : $unlabel(input.label.awaiting))
    }
  }
  else {
    if (managed && context.payload.action === 'closed') { // user closed the issue
      if (input.label.reopened && !$labeled(input.label.reopened)) await $label(input.label.merge)
    }
    else if (context.eventName === 'issue_comment') { // user commented on a closed issue
      if (managed && issue.state === 'closed') {
        await octokit.rest.issues.update({ owner, repo, issue_number: issue.number, state: 'open' })
        await $label(input.label.reopened)
      }
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
  }

  if (input.project.url) {
    // get fresh state
    const { data } = await octokit.rest.issues.get({ owner, repo, issue_number: issue.number }))
    issue = data as unknown as Issue

    const card = await Project.get(issue)

    if (issue.state === 'closed') {
      if (input.project.status.merge && $labeled(input.label.merge)) await Project.update(card, issue.created_at, input.project.status.merge)
    }
    else if (input.status.assigned && issue.assignees.length) {
      await Project.update(card, issue.created_at, input.project.status.assigned)
    }
    else if (input.state.unassigned && !issue.assignees.length) {
      await Project.update(card, issue.created_at, input.project.status.unassigned)
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
