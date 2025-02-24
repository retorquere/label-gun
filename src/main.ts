import * as core from '@actions/core'
import { context, getOctokit } from '@actions/github'
import { graphql } from '@octokit/graphql'
import { RequestError } from '@octokit/request-error'
import { Issue, IssueComment } from '@octokit/webhooks-types'
import * as util from 'util'

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
  report(util.inspect({ [`${msg} =>`]: obj }, { showHidden: false, depth: null, colors: true }))
}

const octokit = getOctokit(config.token)

show('starting with', config)

const User = new class {
  #collaborator: Record<string, boolean> = {}

  async isCollaborator(username?: string, allowBot = false): Promise<boolean> {
    if (!username) return false

    const isBot = username.endsWith('[bot]') || config.user.bots.includes(username)
    if (isBot && !allowBot) username += '[as-user]'

    if (typeof this.#collaborator[username] !== 'boolean') {
      if (isBot) {
        this.#collaborator[username] = !!allowBot
        report(username, 'is a bot, which we', this.#collaborator[username] ? 'consider' : 'do not consider', 'to be a contributor')
      }
      else {
        const { data: user } = await octokit.rest.repos.getCollaboratorPermissionLevel({ owner, repo, username })
        this.#collaborator[username] = user.permission === 'admin'
        report(username, 'has', user.permission, 'permission and is', this.#collaborator[username] ? 'a' : 'not a', 'contributor')
      }
    }

    return this.#collaborator[username]
  }
}()

async function update(issue: Issue, body: string): Promise<void> {
  if (!issue) throw new Error('No issue found')
  report('\n=== processing issue', issue.number, '===')

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
  }
  else {
    // user activity
    if (managed && context.payload.action === 'closed') { // user closed the issue
      if (issue.assignees.length && !$labeled(config.label.reopened)) {
        report('user closed active issue, reopen for merge')
        await octokit.rest.issues.createComment({
          owner,
          repo,
          issue_number: issue.number,
          body: config.close.message.replace('{{username}}', sender),
        })
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
          await octokit.rest.issues.createComment({
            owner,
            repo,
            issue_number: issue.number,
            body: config.log.message.replace('{{username}}', sender),
          })
        }
      }
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
