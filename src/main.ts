import * as core from '@actions/core'
import { getOctokit, context } from '@actions/github'
import { Issue, IssueComment } from '@octokit/webhooks-types'

const token = core.getInput('token', { required: true })
const octokit = getOctokit(token)

const sender: string = context.payload.sender?.login || ''
const bot: boolean = context.payload.sender?.type === 'Bot'
const owner: string = context.payload.repository?.owner?.login || ''
const repo: string = context.payload.repository?.name || ''

if (core.getInput('verbose') && !(core.getInput('verbose').match(/^(true|false)$/i))) throw new Error(`Unexpected verbose value ${core.getInput('verbose')}`)

const input = {
  label: {
    active: core.getInput('label.active') || '',
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

  verbose: (core.getInput('verbose') || '').toLowerCase() === 'true',
}

if (input.verbose) console.log(input)

const User = new class {
  #collaborator: Record<string, boolean> = { 'github-actions[bot]': true }

  async isCollaborator(username?: string, allowbot=false): Promise<boolean> {
    if (!username) return false
    if ((username.endsWith('[bot]') || (username === sender && bot)) && !allowbot) {
      if (input.verbose) console.log(username, 'is a bot, which is not actually a contributor')
      return false
    }

    if (typeof this.#collaborator[username] !== 'boolean') {
      const { data: user } = await octokit.rest.repos.getCollaboratorPermissionLevel({ owner, repo, username })
      this.#collaborator[username] = user.permission !== 'none'
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
    return (issue!.labels || []).find(label => name.includes(typeof label === 'string' ? label : (label?.name || '')))
  }
  async function $label(name: string) {
    if (!name || $labeled(name)) return
    await octokit.rest.issues.addLabels({ owner, repo, issue_number: issue!.number, labels: [name] })
  }
  async function $unlabel(name: string) {
    if (!name || !$labeled(name)) return
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
  const managed = active.user && !$labeled(input.label.exempt) && (!input.label.active || $labeled(input.label.active))

  if (active.owner && input.assignee && !issue.assignees.find(assignee => assignee.login)) {
    const assignee = await User.isCollaborator(sender, false) ? sender : input.assignee
    await octokit.rest.issues.addAssignees({ owner, repo, issue_number: issue.number, assignees: [assignee] })
  }

  if (input.verbose) console.log(sender, 'collaborator:', await User.isCollaborator(sender))
  if (await User.isCollaborator(sender)) {
    if (input.verbose) console.log({ action: context.payload.action, managed, state: issue.state })
    if (context.payload.action != 'edited' && managed && issue.state !== 'closed') await $label(input.label.awaiting)
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
        found = !!([ issue.body || '', ...(comments.map(comment => comment.body || '')) ].find((b: string) => b.match(input.log.regex)))
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
        for (const issue of await octokit.paginate(octokit.rest.issues.listForRepo, { owner, repo, state: 'all', per_page: 100 })) {
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
