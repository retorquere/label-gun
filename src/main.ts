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
let comment_id = 0
let issue_number = 0

const shortcode_prefix = 'INPUT_shortcode.'
const config = {
  log: core.getInput('log-id') ? new RegExp(core.getInput('log-id')) : (undefined as unknown as RegExp),

  body: '',

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

  shortcodes: Object.keys(process.env)
    .reduce((acc: Record<string, string>, key: string) => {
      if (process.env[key] && key.startsWith(shortcode_prefix)) acc[key.substring(shortcode_prefix.length)] = process.env[key] || key
      return acc
    }, {}),

  shortcode: /\0/g,
}

class Facts {
  public event: 'issue-opened' | 'issue-closed' | 'issue-edited' | 'issue-reopened' | 'comment-created' | 'comment-edited' | '' = ''
  public state: 'open' | 'closed' = 'open'
  public labels?: string[]
  
  public collaborator = false

  public log_present = false
  public log_required = false

  public has_shortcode = false
}

function re_escape(c: string): string {
  return c.replace(/[-[\]/{}()*+?.\\^$|]\s*/g, '\\$&')
}

async function prepare(): Promise<Facts> {
  const facts = new Facts
  try {
    await octokit.rest.repos.checkCollaborator({ owner, repo, username })
    facts.collaborator = true
  } catch (err) {
    facts.collaborator = false
  }

  if (github.context.eventName === 'issues') {
    const { action, issue } = (github.context.payload as IssuesEvent)
    facts.labels = issue.labels?.map(label => label.name)
    config.body = issue.body
    facts.event = `issue-${action}` as 'issue-opened'
    facts.state = issue.state || 'open'
    issue_number = issue.number
  }
  else if (github.context.eventName === 'issue_comment') {
    const { action, comment, issue } = (github.context.payload as IssueCommentEvent)
    facts.labels = issue.labels?.map(label => label.name)
    config.body = comment.body
    facts.event = `comment-${action}` as 'comment-created'
    facts.state = issue.state
    issue_number = issue.number
    comment_id = comment.id
  }

  if (config.log) facts.log_required = true
  if (config.log && config.body) facts.log_present = !!config.body.match(config.log)

  const shortcodes: string = Object.keys(config.shortcodes).map(re_escape).join('|')
  if (shortcodes) config.shortcode = new RegExp(`:(${shortcodes}):`, 'g')

  if (config.shortcode && config.body.match(config.shortcode)) facts.has_shortcode = true

  return facts
}

function labeled(facts: Facts, name: string, dflt = false): boolean {
  if (!name) return dflt
  return facts.labels!.includes(name) || dflt
}
async function label(facts: Facts, name: string) {
  if (facts.labels!.includes(name)) return
  await octokit.rest.issues.addLabels({ owner, repo, issue_number, labels: [name] })
  facts.labels!.push(name)
}
async function unlabel(facts: Facts, name: string) {
  let labels = facts.labels!.length
  facts.labels = facts.labels!.filter(label => label !== name)
  if (labels !== facts.labels!.length) await octokit.rest.issues.removeLabel({ owner, repo, issue_number, name })
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
    (facts: Facts) => facts.event === 'comment-created',
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
  name: 're-open issue on user comment',
  when: [
    (facts: Facts) => facts.event === 'comment-created',
    (facts: Facts) => facts.state === 'closed',
    (facts: Facts) => !facts.collaborator,
  ],
  then: async (facts: Facts) => {
    label(facts, config.label.reopened)
    await octokit.rest.issues.update({ owner, repo, issue_number, state: 'open' })
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

rules.push(new Rule({
  name: 'expand shortcodes',
  when: [
    (facts: Facts) => facts.collaborator && facts.has_shortcode
  ],
  then: async (facts: Facts) => {
    facts.has_shortcode = false
    const body = config.body.replace(config.shortcode, (match, shortcode) => config.shortcodes[shortcode] || match)
    if (body !== config.body) await octokit.rest.issues.updateComment({ owner, repo, comment_id, body })
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
