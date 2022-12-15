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
  log: core.getInput('log-id') ? new RegExp(core.getInput('log-id')) : (undefined as unknown as RegExp),

  label: {
    active: core.getInput('label.active') || '',
    awaiting: core.getInput('label.awaiting'),
    exempt: core.getInput('label.exempt') || '',
    log_required: core.getInput('label.log-required'),
    reopened: core.getInput('label.reopened') || '',
  },

  message: {
    log_required: core.getInput('message.log-required'),
    no_close: core.getInput('message.no-close'),
  },
}

class Facts {
  public event: 'issue-opened' | 'issue-closed' | 'issue-edited' | 'issue-reopened' | 'comment-created' | 'comment-edited' | '' = ''
  public issue: Issue = undefined as unknown as Issue
  
  public collaborator = false

  public log_present = false
  public log_required = false
}

async function prepare(): Promise<Facts> {
  const facts = new Facts
  try {
    await octokit.rest.repos.checkCollaborator({ owner, repo, username })
    facts.collaborator = true
  } catch (err) {
    facts.collaborator = false
  }

  let body = ''
  if (github.context.eventName === 'issues') {
    const { action, issue } = (github.context.payload as IssuesEvent)
    facts.issue = issue
    body = issue.body
    facts.event = `issue-${action}` as 'issue-opened'
  }
  else if (github.context.eventName === 'issue_comment') {
    const { action, comment, issue } = (github.context.payload as IssueCommentEvent)
    facts.issue = issue
    body = comment.body
    facts.event = `comment-${action}` as 'comment-created'
  }

  if (config.log) facts.log_required = true
  if (config.log && body) facts.log_present = !!body.match(config.log)
  issue_number = facts.issue.number

  return facts
}

function labeled(facts: Facts, name: string, dflt = false): boolean {
  if (!name) return dflt
  return !!facts.issue.labels!.find(label => label.name === name) || dflt
}
async function label(facts: Facts, name: string) {
  if (facts.issue.labels!.find(label => label.name === name)) return
  await octokit.rest.issues.addLabels({ owner, repo, issue_number, labels: [name] })
  facts.issue.labels!.push({ name } as unknown as Label)
}
async function unlabel(facts: Facts, name: string) {
  let labels = facts.issue.labels!.length
  facts.issue.labels = facts.issue.labels!.filter(label => label.name !== name)
  if (labels !== facts.issue.labels!.length) await octokit.rest.issues.removeLabel({ owner, repo, issue_number, name })
}

const rules: Rule[] = []

rules.push(new Rule({
  name: 'ask for log',
  when: [
    (facts: Facts) => facts.event === 'issue-opened',
    (facts: Facts) => facts.log_required,
    (facts: Facts) => !facts.log_present,
    (facts: Facts) => !facts.collaborator,
    (facts: Facts) => !labeled(facts, config.label.exempt),
  ],
  then: async (facts: Facts) => {
    await label(facts, config.label.log_required)

    if (config.message.log_required) {
      await octokit.rest.issues.createComment({
        owner, repo, issue_number,
        body: config.message.log_required.replace('{{username}}', username),
      })
    }
  },
}))

rules.push(new Rule({
  name: 'acknowledge log',
  when: [
    (facts: Facts) => ['issue-opened', 'issue-edited', 'comment-created', 'comment-edited'].includes(facts.event),
    (facts: Facts) => !facts.collaborator,
    (facts: Facts) => labeled(facts, config.label.log_required),
    (facts: Facts) => facts.log_present,
  ],
  then: async (facts: Facts) => {
    await unlabel(facts, config.label.log_required)
  }
}))

rules.push(new Rule({
  name: 'toggle awaiting',
  when: [
    (facts: Facts) => ['comment-created'].includes(facts.event),
    (facts: Facts) => labeled(facts, config.label.awaiting) !== facts.collaborator,
  ],
  then: async (facts: Facts) => {
    await (facts.collaborator ? label(facts, config.label.awaiting) : unlabel(facts, config.label.awaiting))
  },
}))

rules.push(new Rule({
  name: 're-open user-closed issue',
  when: [
    (facts: Facts) => facts.event === 'issue-closed',
    (facts: Facts) => !facts.collaborator,
    (facts: Facts) => !labeled(facts, config.label.exempt),
    (facts: Facts) => !!(config.label.reopened && config.message.no_close),
  ],
  then: async (facts: Facts) => {
    await octokit.rest.issues.update({ owner, repo, issue_number, state: 'open' })
    if (!labeled(facts, config.label.reopened)) {
      await label(facts, config.label.reopened)
      await octokit.rest.issues.createComment({ owner, repo, issue_number, body: config.message.no_close })
    }
  },
}))

rules.push(new Rule({
  name: 'clean up closed issue',
  when: [
    (facts: Facts) => facts.event === 'issue-closed',
    (facts: Facts) => facts.collaborator || labeled(facts, config.label.exempt)
  ],
  then: async (facts: Facts) => {
    if (labeled(facts, config.label.reopened)) await unlabel(facts, config.label.reopened)
    if (labeled(facts, config.label.awaiting)) await unlabel(facts, config.label.awaiting)
  },
}))

async function run(): Promise<void> {
  const facts = await prepare()
  if (facts.event && labeled(facts, config.label.active, true)) {
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
