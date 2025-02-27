import * as core from '@actions/core'
import { context, getOctokit } from '@actions/github'
import { RequestError } from '@octokit/request-error'
import { Issue, IssueComment } from '@octokit/webhooks-types'
import * as util from 'util'

import { config } from './config'

const sender = {
  login: (context.payload.sender?.login || '') as string,
  bot: context.payload.sender?.type === 'Bot' || (context.payload.sender?.login || '').endsWith('[bot]'),
  owner: false,
  user: true,
  log: {
    needed: false,
    present: false,
  },
}
const owner: string = context.payload.repository?.owner?.login || ''
const repo: string = context.payload.repository?.name || ''

function setStatus(state: 'awaiting' | 'in-progress' | 'new' | 'backlog') {
  core.setOutput('state', state)
}
function setIssue(issue: Issue) {
  core.setOutput('issue', `${issue.number}`)
}

function report(...msg: any[]) {
  if (!config.verbose) return
  console.log(...msg)
}

function show(msg: string, obj: any) {
  report(util.inspect({ [`${msg} =>`]: obj }, { showHidden: false, depth: null, colors: true }))
}

const octokit = getOctokit(config.token)

show('starting with', config)

const Users = new class {
  #owner: Record<string, boolean> = {}

  async isOwner(username?: string, allowBot = false): Promise<boolean> {
    if (!username) return false

    const isBot = username.endsWith('[bot]')
    if (isBot && !allowBot) username += '[as-user]'

    if (typeof this.#owner[username] !== 'boolean') {
      if (isBot) {
        this.#owner[username] = !!allowBot
        report(username, 'is a bot, which we', this.#owner[username] ? 'consider' : 'do not consider', 'to be a contributor')
      }
      else {
        const { data: user } = await octokit.rest.repos.getCollaboratorPermissionLevel({ owner, repo, username })
        this.#owner[username] = user.permission === 'admin'
        report(username, 'has', user.permission, 'permission and is', this.#owner[username] ? 'a' : 'not a', 'owner')
      }
    }

    return this.#owner[username]
  }

  get owners(): number {
    return Object.values(this.#owner).filter(o => o).length
  }
  get users(): number {
    return Object.values(this.#owner).filter(o => !o).length
  }
}()

class Labels {
  constructor(private issue: Issue) {
  }

  public has(...name: string[]): boolean {
    name = name.filter(_ => _)
    const labeled = (this.issue.labels || []).find(label => name.includes(typeof label === 'string' ? label : (label?.name || '')))
    // report('testing whether issue is labeled', name, ':', labeled)
    return !!labeled
  }

  async set(name: string) {
    if (!name || this.has(name)) return
    report('labeling', name)
    await octokit.rest.issues.addLabels({ owner, repo, issue_number: this.issue.number, labels: [name] })
  }

  async remove(name: string) {
    if (!name || !this.has(name)) return
    report('unlabeling', name)
    try {
      await octokit.rest.issues.removeLabel({ owner, repo, issue_number: this.issue.number, name })
    }
    catch (err) {
      if (err instanceof RequestError && err.status !== 404) throw err
    }
  }
}

async function update(issue: Issue, body: string): Promise<void> {
  if (!issue) throw new Error('No issue found')
  report('\n=== processing issue', issue.number, '===')
  setIssue(issue)

  sender.owner = await Users.isOwner(sender.login)
  sender.user = !sender.owner
  sender.log = {
    needed: !!config.log.regex && sender.user && context.payload.action === 'opened',
    present: config.log.regex ? !!body.match(config.log.regex) : false,
  }
  report('sender:', sender)

  const label = new Labels(issue)

  const { data: comments } = await octokit.rest.issues.listComments({ owner, repo, issue_number: issue.number })
  for (const user of [issue.user.login].concat(comments.map(comment => comment.user?.login || ''))) {
    await Users.isOwner(user)
    if (Users.users && Users.owners) break
  }

  const managed = Users.users && !label.has(config.label.exempt) && (!config.label.active || label.has(config.label.active))

  if (Users.users && label.has(config.label.awaiting)) {
    setStatus('awaiting')
  }
  else if (!Users.users || issue.assignees.length) {
    setStatus('in-progress')
  }
  else if (!Users.owners) {
    setStatus('new')
  }
  else {
    setStatus('backlog')
  }

  show(`entering issue handler for ${sender.owner ? 'owner' : 'user'} activity`, {
    managed,
    sender,
    users: Users.users,
    owners: Users.owners,
    label: {
      exempt: label.has(config.label.exempt),
      active: label.has(config.label.active),
    },
  })

  if (config.assign && sender.owner && !sender.bot && !issue.assignees.length && issue.state !== 'closed') {
    report('assigning active issue to', sender.login)
    await octokit.rest.issues.addAssignees({ owner, repo, issue_number: issue.number, assignees: [sender.login] })
  }

  if (!managed || (sender.owner && issue.state === 'closed')) {
    if (config.assign && issue.state === 'closed' && issue.assignees.length) {
      const assignees = issue.assignees.map(assignee => assignee.login)
      report('unassigning', assignees)
      await octokit.rest.issues.removeAssignees({ owner, repo, issue_number: issue.number, assignees })
    }

    show('unlabeling issue', { managed, sender, state: issue.state })
    await label.remove(config.label.awaiting)
    await label.remove(config.log.label)
    return
  }

  if (sender.owner) {
    if (Users.users) await label.set(config.label.awaiting)
  }
  else if (sender.user) {
    if (context.payload.action === 'closed') { // user closed the issue
      if (!label.has(config.label.reopened)) {
        report('user closed active issue, reopen')
        if (config.close.message)
          await octokit.rest.issues.createComment({
            owner,
            repo,
            issue_number: issue.number,
            body: config.close.message.replace('{{username}}', sender.login),
          })
      }
      await octokit.rest.issues.update({ owner, repo, issue_number: issue.number, state: 'open' })
    }
    else if (context.payload.action !== 'edited' && issue.state === 'closed') { // user commented on closed issue
      await label.set(config.label.reopened)
      await octokit.rest.issues.update({ owner, repo, issue_number: issue.number, state: 'open' })
    }

    if (sender.log.present) await label.remove(config.log.label)

    if (sender.log.needed && !sender.log.present) {
      await label.set(config.log.label)
      await label.set(config.label.awaiting)
      if (config.log.message) {
        await octokit.rest.issues.createComment({
          owner,
          repo,
          issue_number: issue.number,
          body: config.log.message.replace('{{username}}', sender.login),
        })
      }
      setStatus('awaiting')
    }
    else if (context.payload.action !== 'edited') {
      await label.remove(config.label.awaiting)
      setStatus('in-progress')
    }
    else if (label.has(config.label.awaiting)) {
      setStatus('awaiting')
    }
    else {
      setStatus('in-progress')
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

      default: {
        core.setFailed(`Unexpected event ${context.eventName}`)
        break
      }
    }

    report('finished')
  }
  catch (err) {
    console.error(err)
    core.setFailed((err as Error).message)
  }
}

run()
