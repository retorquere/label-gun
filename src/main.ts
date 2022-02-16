import fs from 'fs/promises'
const stringify = require('fast-safe-stringify')
import * as core from '@actions/core'
import * as github from '@actions/github'
import {
  IssueCommentEvent,
  IssuesEvent,
  Label,
  Schema
} from '@octokit/webhooks-definitions/schema'

const token = core.getInput('token', { required: true })
const octokit = github.getOctokit(token)

const config = {
  logID: new class {
    needed: string = ''
    regex: RegExp = /^$/
    message: string = ''
    prompt: string = ''

    constructor() {
      const input: Record<string, string> = {}

      for (const key of ['label', 'regex', 'message', 'prompt']) {
        const value = core.getInput(`log-id.${key}`)
        switch (typeof value) {
          case 'undefined':
            break
          case 'string':
            if (value) input[key] = value
            break
          default:
            throw new Error(`Unexpected ${typeof value} ${JSON.stringify(value)} for log-id.${key}`)
        }
      }

      if (Object.keys(input).length !== 0) {
        for (const key of ['label', 'regex', 'message']) {
          if (!input[key]) throw new Error(`missing value for log-id.${key}`)
        }
        this.needed = input.label
        this.message = input.message
        this.regex = new RegExp(input.regex)
        this.prompt = input.prompt || ''
      }
    }
  },

  labels: {
    awaiting: core.getInput('label.awaiting'),
    active: core.getInput('labele.active') || '',
    exempt: core.getInput('label.exempt') || '',
  },

  noclose: core.getInput('noclose'),
}
if (!config.logID.needed) (config.logID as any) = null

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

const owner = github.context.payload.repository?.owner.login || ''
const repo = github.context.payload.repository?.name || ''
const username = github.context.payload.sender?.login || ''
const issue_number = github.context.payload.issue?.number || 0
const event: { issues?: IssuesEvent; issue_comment?: IssueCommentEvent, $?: IssuesEvent | IssueCommentEvent } = {}
switch (github.context.eventName) {
  case 'issues':
    event.$ = event.issues = github.context.payload as IssuesEvent
    break
  case 'issue_comment':
    event.$ = event.issue_comment = github.context.payload as IssueCommentEvent
    break
}
const labels = (event.$?.issue.labels || []).map((label: Label) => label.name)
let isCollaborator = false
let body = ''

async function run(): Promise<void> {
  if (!event.$) return
  if (config.labels.active && !labels.includes(config.labels.active)) return

  try {
    await octokit.rest.repos.checkCollaborator({ owner, repo, username })
    isCollaborator = true
  } catch (err) {
  }

  body = event.issues?.issue.body || event.issue_comment?.comment.body || ''

  switch (event.issues?.action) {
    case 'opened':
      if (await logNeeded()) await octokit.rest.issues.createComment({ owner, repo, issue_number, body: config.logID.message })
      break

    case 'edited':
      await logNeeded()
      break

    case 'closed':
      if (!config.noclose || isCollaborator || labels.includes(config.labels.exempt)) {
        await awaiting(false)
        return
      }

      await octokit.rest.issues.createComment({ owner, repo, issue_number, body: config.noclose })
      await octokit.rest.issues.update({ owner, repo, issue_number, state: 'open' })
      break
  }

  switch (event.issue_comment?.action) {
    case 'created':
      await awaiting(isCollaborator)
      if (await logNeeded()) await promptForLog()
      break
    case 'edited':
      await logNeeded()
      break
  }
}

async function awaiting(on: boolean) {
  core.notice(`awaiting: ${!!on}`)
  if (on) {
    await addLabel(config.labels.awaiting)
  }
  else {
    await removeLabel(config.labels.awaiting)
  }
}

async function addLabel(label: string) {
  core.notice(`ensuring label: ${label}`)
  if (!labels.includes(label)) {
    core.notice(`adding label: ${label}`)
    await octokit.rest.issues.addLabels({ owner, repo, issue_number, labels: [label] })
  }
}

async function removeLabel(label: string) {
  core.notice(`ensuring !label: ${label}`)
  if (labels.includes(label)) {
    core.notice(`removing label: ${label}`)
    await octokit.rest.issues.removeLabel({ owner, repo, issue_number, name: label })
  }
}

async function logNeeded(): Promise<boolean> {
  if (!config.logID || isCollaborator || labels.includes(config.labels.exempt)) return false
  if (body.match(config.logID.regex)) {
    await removeLabel(config.logID.needed)
    return false
  }
  else {
    await addLabel(config.logID.needed)
    return true
  }
}

async function promptForLog() {
  if (!event.issue_comment || !(config.logID?.prompt) || body.includes(config.logID.prompt)) return
  await octokit.rest.issues.updateComment({ owner, repo, comment_id: event.issue_comment.comment.id, body: body + '\n\n' + config.logID.prompt })
}

run()
