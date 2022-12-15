import fs from 'fs/promises'
const stringify = require('fast-safe-stringify')
import { Rools, Rule } from 'rools'
import * as core from '@actions/core'
import * as github from '@actions/github'
import {
  IssueCommentEvent,
  IssuesEvent,
  Issue,
  Label,
  Schema
} from '@octokit/webhooks-definitions/schema'

const token = core.getInput('token', { required: true })
const octokit = github.getOctokit(token)

const owner = github.context.payload.repository?.owner.login || ''
const repo = github.context.payload.repository?.name || ''
const username = github.context.payload.sender?.login || ''
let issue_number = 0

const config = {
  issue: undefined as unknown as Issue,
  log: core.getInput('log-id') || core.getInput('log-id.regex') ? new RegExp(core.getInput('log-id') || core.getInput('log-id.regex')) : (undefined as unknown as RegExp),

  label: {
    active: core.getInput('label.active') || '',
    awaiting: core.getInput('label.awaiting'),
    exempt: core.getInput('label.exempt') || '',
    log_required: core.getInput('label.log-required') || core.getInput('log-id.label'),
    reopened: core.getInput('label.reopened') || core.getInput('label.reopen') || '',
  },

  message: {
    log_required: core.getInput('message.log-id') || core.getInput('logid.message') || core.getInput('log-id.message'),
    no_close: core.getInput('message.no-close') || core.getInput('no-close.message'),
  },
}

class Facts {
  public event: 'issue-opened' | 'issue-closed' | 'issue-edited' | 'comment-created' | 'comment-edited' | '' = ''
  
  public issue: Issue = undefined as unknown as Issue

  public collaborator = false
  public log_present = false

  async prepare(): Promise<Facts> {
    try {
      await octokit.rest.repos.checkCollaborator({ owner, repo, username })
      this.collaborator = true
    } catch (err) {
      this.collaborator = false
    }

    let body = ''
    if (github.context.eventName === 'issues') {
      const { action, issue } = (github.context.payload as IssuesEvent)
      this.issue = github.context.payload as unknown as Issue
      body = this.issue.body
      this.event = `issue-${github.context.payload.action}` as 'issue-opened'
    }
    else if (github.context.eventName === 'issue_comment') {
      const { action, comment, issue } = (github.context.payload as IssueCommentEvent)
      this.issue = issue
      body = comment.body
      this.event = `comment-${action}` as 'comment-created'
    }

    this.log_present = !!body.match(config.log)
    issue_number = this.issue.number

    return this
  }

  labeled(name: string, dflt = false): boolean {
    if (!name) return dflt
    return !!this.issue.labels!.find(label => label.name === name) || dflt
  }
  async label(name: string) {
    if (this.issue.labels!.find(label => label.name === name)) return
    await octokit.rest.issues.addLabels({ owner, repo, issue_number, labels: [name] })
    this.issue.labels!.push({ name } as unknown as Label)
  }
  async unlabel(name: string) {
    let labels = this.issue.labels!.length
    this.issue.labels = this.issue.labels!.filter(label => label.name !== name)
    if (labels !== this.issue.labels!.length) await octokit.rest.issues.removeLabel({ owner, repo, issue_number, name })
  }
}

const rules: Rule[] = []

rules.push(new Rule({
  name: 'ask for log',
  when: [
    (facts: Facts) => !!config.log,
    (facts: Facts) => facts.event === 'issue-opened',
    (facts: Facts) => !facts.collaborator,
    (facts: Facts) => !facts.labeled(config.label.exempt),
    (facts: Facts) => !facts.log_present,
  ],
  then: async (facts: Facts) => {
    await facts.label(config.label.log_required)
    await octokit.rest.issues.createComment({
      owner, repo, issue_number,
      body: config.message.log_required.replace('{{username}}', username),
    })
  },
}))

rules.push(new Rule({
  name: 'acknowledge log',
  when: [
    (facts: Facts) => ['issue-opened', 'issue-edited', 'comment-created', 'comment-edited'].includes(facts.event),
    (facts: Facts) => !facts.collaborator,
    (facts: Facts) => facts.labeled(config.label.log_required),
    (facts: Facts) => facts.log_present,
  ],
  then: async (facts: Facts) => {
    await facts.unlabel(config.label.log_required)
  }
}))

rules.push(new Rule({
  name: 'toggle awaiting',
  when: [
    (facts: Facts) => ['issue-edited', 'comment-created', 'comment-edited'].includes(facts.event),
  ],
  then: async (facts: Facts) => {
    await (facts.collaborator ? facts.label(config.label.awaiting) : facts.unlabel(config.label.awaiting))
  },
}))

rules.push(new Rule({
  name: 're-open user-closed issue',
  when: [
    (facts: Facts) => facts.event === 'issue-closed',
    (facts: Facts) => !!(config.label.reopened && config.message.no_close),
    (facts: Facts) => !facts.collaborator,
    (facts: Facts) => !facts.labeled(config.label.exempt),
  ],
  then: async (facts: Facts) => {
    await octokit.rest.issues.update({ owner, repo, issue_number, state: 'open' })
    if (!facts.labeled(config.label.reopened)) {
      await facts.label(config.label.reopened)
      await octokit.rest.issues.createComment({ owner, repo, issue_number, body: config.message.no_close })
    }
  },
}))

for (const rule of rules) {
}

async function run(): Promise<void> {
  const facts = new Facts
  await facts.prepare()
  if (facts.event && facts.labeled(config.label.active, true)) {
    const rools = new Rools({ logging: { error: true, debug: true } })
    await rools.register(rules)
    await rools.evaluate(facts)
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

run().catch(err => {
  console.log(err)
  process.exit(1)
})
