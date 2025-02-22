import * as core from '@actions/core'
import { context, getOctokit } from '@actions/github'
import { graphql } from '@octokit/graphql'
import { RequestError } from '@octokit/request-error'
import { Issue, IssueComment, ProjectsV2Item } from '@octokit/webhooks-types'
import { OrgProjectV2FieldsQuery, UserProjectV2FieldsQuery } from './types'
import { CreateCardMutation, ProjectCardForIssueQuery, UpdateCardMutation } from './types'

import * as yaml from 'js-yaml'
const RegExpYamlType = new yaml.Type('!regexp', {
  kind: 'scalar', // RegExp is represented as a scalar (string)
  resolve: function(data) {
    return data !== null && typeof data === 'string' && data.startsWith('/') // Check if it looks like a regex
  },
  construct: function(data) {
    try {
      const match = data.match(/^\/(.*)\/([gimuy]*)$/)
      if (!match) {
        throw new Error('Invalid RegExp string')
      }
      return new RegExp(match[1], match[2])
    }
    catch (e) {
      console.error('Error parsing RegExp:', data, e)
      return /$^/ // Or throw the error
    }
  },
  instanceOf: RegExp,
  represent: function(regexp) {
    return regexp.toString() // Represent the RegExp as its string form
  },
})
const schema = yaml.DEFAULT_SCHEMA.extend([RegExpYamlType])

import { config } from './config'

const sender: string = context.payload.sender?.login || ''
const bot: boolean = context.payload.sender?.type === 'Bot'
const owner: string = context.payload.repository?.owner?.login || ''
const repo: string = context.payload.repository?.name || ''

function report(...msg: any[]) {
  if (!config.verbose) return
  console.log(...msg)
}

function show(msg: string, obj: any) {
  report(yaml.dump({ [msg]: config }, { schema }))
}

const octokit = getOctokit(config.token)

show('starting with', config)

type Field = keyof typeof config.project.card.field
type Status = keyof typeof config.project.card.status

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
  public field: Partial<Record<Field, string>> = {}
  public status: Partial<Record<Status, string>> = {}

  constructor() {
    if (config.project.url) {
      const m = config.project.url.match(/https:\/\/github.com\/(users|orgs)\/([^/]+)\/projects\/(\d+)/)
      if (!m) throw new Error(`${config.project.url} is not a valid project URL`)
      const [, type, owner, number] = m
      this.type = type === 'users' ? 'user' : 'org'
      this.owner = owner
      this.number = parseInt(number)
      show('project config', {
        owner: this.owner,
        type: this.type,
        number: this.number,
      })
    }
  }

  async load() {
    if (!config.project.url) return

    const data = await graphql<UserProjectV2FieldsQuery | OrgProjectV2FieldsQuery>(Project.q.fields[this.type], {
      owner: this.owner,
      projectNumber: this.number,
      headers: {
        authorization: `Bearer ${config.project.token}`,
      },
    })
    const project = data?.owner?.projectV2
    if (!project) throw new Error(`project ${JSON.stringify(config.project.url)} not found`)
    this.id = project.id

    const fields = project.fields
    if (!fields) throw new Error(`fields for ${JSON.stringify(config.project.url)} not found`)

    for (const [field, label] of Object.entries(config.project.card.field)) {
      if (!label) continue

      const pf = fields.nodes?.find(f => f && f.id && f.name && f.name === label)
      if (!pf) throw new Error(`${field} label ${JSON.stringify(label)} not found`)
      this.field[field as Field] = pf.id

      if (pf.__typename === 'ProjectV2SingleSelectField' && field === 'status') {
        for (const [status, name] of Object.entries(config.project.card.status)) {
          if (!name) continue

          const _ = pf.options.find(o => o.name === name)
          if (!_) throw new Error(`card status ${JSON.stringify(name)} not found`)
          this.status[status as Status] = _.id
        }
      }
    }
    show('project loaded', {
      owner: this.owner,
      type: this.type,
      number: this.number,
      id: this.id,
      fields: this.field,
      status: this.status,
    })
  }

  async get(issue: Issue): Promise<string> {
    report('get card', { issue, owner: this.owner, projectNumber: this.number })

    const data = await graphql<ProjectCardForIssueQuery>(Project.q.get, {
      owner: this.owner,
      projectNumber: this.number,
      headers: {
        authorization: `Bearer ${config.project.token}`,
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
        authorization: `Bearer ${config.project.token}`,
      },
    })
    if (!newCard?.addProjectV2ItemById?.item) throw new Error(`Failed to create card on project ${config.project.url}`)
    return newCard.addProjectV2ItemById.item.id
  }

  async update(itemId: string, startDate: string, status: Status) {
    await graphql<UpdateCardMutation>(Project.q.update, {
      projectId: this.id,
      itemId,
      statusFieldId: this.field.status,
      statusValue: this.status[status],
      startDateFieldId: this.field.startDate,
      startDate: startDate,
      endDateFieldId: this.field.endDate,
      endDate: new Date().toISOString().replace(/T.*/, ''),
      headers: {
        authorization: `Bearer ${config.project.token}`,
      },
    })
  }
}()

const User = new class {
  #collaborator: Record<string, boolean> = {}

  async isCollaborator(username?: string, allowBot = false): Promise<boolean> {
    if (!username) return false

    if (username.endsWith('[bot]') || config.user.bots.includes(username)) {
      report(username, 'is a bot, which we', allowBot ? 'consider' : 'do not consider', 'to be a contributor')
      return allowBot
    }

    if (typeof this.#collaborator[username] !== 'boolean') {
      const { data: user } = await octokit.rest.repos.getCollaboratorPermissionLevel({ owner, repo, username })
      this.#collaborator[username] = user.permission === 'admin'
      report(username, 'has permission', user.permission, 'and is', this.#collaborator[username] ? 'a' : 'not a', 'contributor')
    }
    return this.#collaborator[username]
  }
}()

async function update(issue: Issue, body: string): Promise<void> {
  if (!issue) throw new Error('No issue found')
  report('\n === processing issue', issue.number, '===')

  function $labeled(...name: string[]) {
    name = name.filter(_ => _)
    const labeled = (issue!.labels || []).find(label => name.includes(typeof label === 'string' ? label : (label?.name || '')))
    // report('testing whether issue is labeled', name, ':', labeled)
    return labeled
  }
  async function $label(name: string) {
    if (!name || $labeled(name)) return
    report('labeling', name)
    await octokit.rest.issues.addLabels({ owner, repo, issue_number: issue!.number, labels: [name] })
  }
  async function $unlabel(name: string) {
    if (!name || !$labeled(name)) return
    report('unlabeling', name)
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
  const managed = active.user && !$labeled(config.label.exempt) && (!config.label.active || $labeled(config.label.active))

  show('entering issue handler', {
    active,
    managed,
    label: {
      exempt: $labeled(config.label.exempt),
      active: $labeled(config.label.active),
    },
  })

  if (config.user.assign && issue.state === 'closed') {
    const assignees = issue.assignees.map(assignee => assignee.login)
    if (assignees.length) {
      report('unassigning closed issue')
      await octokit.rest.issues.removeAssignees({ owner, repo, issue_number: issue.number, assignees })
    }
  }
  else if (active.owner && config.user.assign && !issue.assignees.length) {
    const assignee = await User.isCollaborator(sender, false) ? sender : config.user.assign
    report('assigning active issue to', assignee)
    await octokit.rest.issues.addAssignees({ owner, repo, issue_number: issue.number, assignees: [assignee] })
  }

  report('handling', await User.isCollaborator(sender) ? 'collaborator' : 'user', 'activity')

  // collab activity
  if (await User.isCollaborator(sender)) {
    if (context.payload.action != 'edited' && managed) {
      await (issue.state === 'open' ? $label(config.label.awaiting) : $unlabel(config.label.awaiting))
    }
    return
  }

  // user activity
  if (managed && context.payload.action === 'closed') { // user closed the issue
    if (issue.assignees.length && !$labeled(config.label.reopened)) {
      report('user closed active issue, reopen for merge')
      await octokit.rest.issues.createComment({ owner, repo, issue_number: issue.number, body: config.close.message.replace('{{username}}', sender) })
      await octokit.rest.issues.update({ owner, repo, issue_number: issue.number, state: 'open' })
    }
  }
  else if (managed && context.eventName === 'issue_comment' && issue.state === 'closed') { // user commented on a closed issue
    report('user commented on closed issue')
    await octokit.rest.issues.update({ owner, repo, issue_number: issue.number, state: 'open' })
    await $label(config.label.reopened)
  }

  await $unlabel(config.label.awaiting)

  if (managed && config.log.regex && context.eventName !== 'workflow_dispatch') {
    if (issue.state === 'closed' || body.match(config.log.regex)) {
      await $unlabel(config.log.label)
    }
    else if (context.eventName === 'issues' && context.payload.action === 'opened') { // new issue, missing log
      report('log missing')
      await $label(config.log.label)
      if (config.log.message && sender) {
        await octokit.rest.issues.createComment({ owner, repo, issue_number: issue.number, body: config.log.message.replace('{{username}}', sender) })
      }
    }
  }

  if (config.project.url) {
    const { data } = await octokit.rest.issues.get({ owner, repo, issue_number: issue.number })
    issue = data as unknown as Issue

    if (issue.state === 'open' && Project.status.awaiting && Project.status.assigned && Project.status.new) {
      const card = await Project.get(issue)
      await Project.update(card, issue.created_at, $labeled(config.label.awaiting) ? 'awaiting' : (issue.assignees.length ? 'assigned' : 'new'))
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
        for (const issue of await octokit.paginate(octokit.rest.issues.listForRepo, { owner, repo, state: config.issue.state, per_page: 100 })) {
          await update(issue as unknown as Issue, '')
        }
        return
      }

      default: {
        throw new Error(`Unexpected event ${context.eventName}`)
      }
    }

    report('finished')
  }
  catch (err) {
    console.error(err)
    process.exit(1)
  }
}

run()
