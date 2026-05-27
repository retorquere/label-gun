import { RequestError } from '@octokit/request-error'

import { ActionContext, ActionResult, Issue, IssueComment } from './action-context'
import { loadConfig, ManagedStatus, RuntimeConfig } from './config'
import { syncProject } from './project'

type LabelGunContext = ActionContext

class Collaborators {
  private owner = new Map<string, boolean>()

  constructor(private context: LabelGunContext, private verbose: boolean) {
  }

  async isOwner(username?: string, allowBot = false): Promise<boolean> {
    if (!username) return false

    const isBot = username.endsWith('[bot]')
    const cacheKey = isBot && !allowBot ? `${username}[as-user]` : username

    if (!this.owner.has(cacheKey)) {
      if (isBot) {
        this.owner.set(cacheKey, !!allowBot)
        this.report(cacheKey, 'is a bot, which we', allowBot ? 'consider' : 'do not consider', 'to be a contributor')
      }
      else {
        const { data } = await this.context.octokit.rest.repos.getCollaboratorPermissionLevel(
          this.context.repo({ username }),
        )

        const isOwner = ['admin', 'maintain', 'push', 'triage', 'write'].includes(data.permission || '')
        this.owner.set(cacheKey, isOwner)
        this.report(cacheKey, 'has', data.permission, 'permission and is', isOwner ? 'a' : 'not a', 'maintainer')
      }
    }

    return this.owner.get(cacheKey) || false
  }

  get owners(): string[] {
    return [...this.owner.entries()].filter(([, isOwner]) => isOwner).map(([user]) => user)
  }

  get users(): string[] {
    return [...this.owner.entries()].filter(([, isOwner]) => !isOwner).map(([user]) => user)
  }

  private report(...message: unknown[]): void {
    if (!this.verbose) return
    this.context.log.info(message)
  }
}

class Labels {
  private readonly names: Set<string>

  constructor(private context: ActionContext, private issue: Issue, private verbose: boolean) {
    this.names = new Set((issue.labels || []).map(label => typeof label === 'string' ? label : (label.name || '')).filter(Boolean))
  }

  has(...names: string[]): boolean {
    return names.filter(Boolean).some(name => this.names.has(name))
  }

  async add(name?: string): Promise<void> {
    if (!name || this.names.has(name)) return
    this.report('labeling', name)
    await this.context.octokit.rest.issues.addLabels(this.context.issue({ labels: [name] }))
    this.names.add(name)
  }

  async remove(name?: string): Promise<void> {
    if (!name || !this.names.has(name)) return
    this.report('unlabeling', name)

    try {
      await this.context.octokit.rest.issues.removeLabel(this.context.issue({ name }))
      this.names.delete(name)
    }
    catch (error) {
      if (error instanceof RequestError && error.status !== 404) throw error
    }
  }

  private report(...message: unknown[]): void {
    if (!this.verbose) return
    this.context.log.info(message)
  }
}

function report(context: ActionContext, verbose: boolean, ...message: unknown[]): void {
  if (!verbose) return
  context.log.info(message)
}

function formatStatus(config: RuntimeConfig, status: ManagedStatus | false): string {
  if (!status) return ''
  return config.statusNames[status] || status
}

async function applyRequirements(
  context: LabelGunContext,
  config: RuntimeConfig,
  labels: Labels,
  sender: { login: string; owner: boolean; user: boolean },
  event: string,
  body: string,
): Promise<ManagedStatus | undefined> {
  let status: ManagedStatus | undefined

  for (const requirement of config.requirements) {
    const actorMatches = requirement.actor === 'any'
      || (requirement.actor === 'owner' && sender.owner)
      || (requirement.actor === 'user' && sender.user)

    if (!actorMatches) continue

    if (requirement.regex.test(body)) {
      for (const name of requirement.removeLabels) {
        await labels.remove(name)
      }
      continue
    }

    if (!requirement.events.includes(event)) continue

    for (const name of requirement.addLabels) {
      await labels.add(name)
    }

    if (requirement.message) {
      await context.octokit.rest.issues.createComment(
        context.issue({ body: requirement.message.replace('{{username}}', sender.login) }),
      )
    }

    status = requirement.status || status
  }

  return status
}

function determineStatus(summary: { users: string[]; owners: string[] }, issue: Issue, labels: Labels, config: RuntimeConfig): ManagedStatus {
  if (summary.users.length && config.labels.blocked.length && labels.has(...config.labels.blocked)) {
    return 'blocked'
  }

  if (summary.users.length && labels.has(config.labels.awaiting)) {
    return 'awaiting'
  }

  if (!summary.users.length || (issue.assignees || []).length) {
    return 'in-progress'
  }

  if (!summary.owners.length) {
    return 'new'
  }

  return 'backlog'
}

async function summarizeActivity(context: LabelGunContext, issue: Issue, collaborators: Collaborators): Promise<{ lastActive?: string; owners: string[]; users: string[] }> {
  await collaborators.isOwner(issue.user?.login)

  const comments = await context.octokit.paginate(context.octokit.rest.issues.listComments, context.issue()) as IssueComment[]
  let lastActive = issue.updated_at?.split('T')[0]

  for (const comment of comments) {
    await collaborators.isOwner(comment.user?.login || '')
    lastActive = comment.updated_at?.split('T')[0] || lastActive
  }

  return {
    lastActive,
    owners: collaborators.owners,
    users: collaborators.users,
  }
}

async function syncIssueProject(
  context: LabelGunContext,
  config: RuntimeConfig,
  issue: Issue,
  status: ManagedStatus | false,
  users: string[],
  lastActive?: string,
): Promise<void> {
  if (!status || !config.project || !issue.node_id) return
  await syncProject(context, config.project, issue.node_id, status, users, lastActive)
}

export async function handleLabelGunEvent(context: LabelGunContext): Promise<ActionResult> {
  const config = await loadConfig(context)
  const payloadIssue = context.payload.issue as Issue | undefined
  const payloadComment = 'comment' in context.payload ? context.payload.comment as IssueComment : undefined
  const issue = payloadIssue

  if (!issue) throw new Error('No issue found in payload')

  const result: ActionResult = {
    issue: `${issue.number}`,
    status: '',
    users: '',
    lastactive: '',
  }

  const event = `${context.name}.${context.payload.action}`
  const senderLogin = context.payload.sender?.login || ''
  const senderIsBot = context.payload.sender?.type === 'Bot' || senderLogin.endsWith('[bot]')

  report(context, config.verbose, 'processing issue', issue.number, 'for', event)

  const collaborators = new Collaborators(context, config.verbose)
  const senderIsOwner = await collaborators.isOwner(senderLogin)
  const sender = {
    login: senderLogin,
    owner: senderIsOwner,
    user: !senderIsOwner,
    bot: senderIsBot,
  }
  const body = payloadComment?.body || issue.body || ''

  const labels = new Labels(context, issue, config.verbose)
  const summary = await summarizeActivity(context, issue, collaborators)
  result.users = summary.users.sort().join(', ')
  result.lastactive = summary.lastActive || ''
  const managed = summary.users.length > 0
    && !labels.has(...config.labels.exempt)
    && (!config.labels.active.length || labels.has(...config.labels.active))

  let status: ManagedStatus | false = determineStatus(summary, issue, labels, config)

  if (config.assign && sender.owner && !sender.bot && !(issue.assignees || []).length && issue.state !== 'closed') {
    report(context, config.verbose, 'assigning issue to', sender.login)
    await context.octokit.rest.issues.addAssignees(context.issue({ assignees: [sender.login] }))
    status = 'in-progress'
  }

  if (!managed || (sender.owner && issue.state === 'closed')) {
    if (config.assign && issue.state === 'closed' && (issue.assignees || []).length) {
      await context.octokit.rest.issues.removeAssignees(
        context.issue({ assignees: (issue.assignees || []).map(assignee => assignee.login) }),
      )
    }

    await labels.remove(config.labels.awaiting)
    await labels.remove(config.logs.label)
    await syncIssueProject(context, config, issue, false, summary.users, summary.lastActive)
    return result
  }

  if (sender.owner) {
    if (summary.users.length && event === 'issue_comment.created') {
      await labels.add(config.labels.awaiting)
    }

    status = 'awaiting'
  }
  else {
    if (event === 'issues.closed') {
      const canUserCloseIssue = labels.has(config.labels.reopened || '', ...config.labels.canClose)

      if (!canUserCloseIssue) {
        report(context, config.verbose, 'user closed active issue, reopening')

        if (config.close.message) {
          await context.octokit.rest.issues.createComment(
            context.issue({ body: config.close.message.replace('{{username}}', sender.login) }),
          )
        }

        await context.octokit.rest.issues.update(context.issue({ state: 'open' as const }))
        status = 'in-progress'
      }
    }
    else if (event === 'issue_comment.created' && issue.state === 'closed') {
      await labels.add(config.labels.reopened)
      await context.octokit.rest.issues.update(context.issue({ state: 'open' as const }))
      status = 'in-progress'
    }

    const requirementStatus = await applyRequirements(
      context,
      config,
      labels,
      sender,
      event,
      body,
    )

    if (requirementStatus) {
      status = requirementStatus
    }
    else if (event === 'issue_comment.created') {
      await labels.remove(config.labels.awaiting)
      status = 'in-progress'
    }
    else if (labels.has(config.labels.awaiting)) {
      status = 'awaiting'
    }
    else {
      status = 'in-progress'
    }
  }

  await syncIssueProject(context, config, issue, status, summary.users, summary.lastActive)
  result.status = formatStatus(config, status)
  return result
}
