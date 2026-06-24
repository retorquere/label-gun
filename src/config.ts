import { parse } from 'yaml'

import { ActionContext } from './action-context'

export type ManagedStatus = 'blocked' | 'awaiting' | 'in-progress' | 'new' | 'backlog'

interface LabelConfigFile {
  awaiting?: string
  active?: string | string[]
  exempt?: string | string[]
  reopened?: string
  blocked?: string | string[]
  canClose?: string | string[]
  canclose?: string | string[]
}

interface ProjectFieldConfigFile {
  status?: string | false
  endDate?: string | false
  users?: string | false
}

interface ProjectStatusConfigFile {
  blocked?: string
  awaiting?: string
  inProgress?: string
  ['in-progress']?: string
  new?: string
  backlog?: string
}

interface ProjectConfigFile {
  url?: string
  fields?: ProjectFieldConfigFile
  status?: ProjectStatusConfigFile
}

interface LogConfigFile {
  regex?: string
  label?: string
  message?: string
}

interface MessageConfigFile {
  missingLog?: string
  closedByUser?: string
}

interface RequirementConfigFile {
  name?: string
  events?: string | string[]
  actor?: 'user' | 'owner' | 'any'
  pattern?: string
  label?: string
  addLabels?: string | string[]
  removeLabels?: string | string[]
  message?: string
  status?: ManagedStatus
}

interface ConfigFile {
  verbose?: boolean
  assign?: boolean
  labels?: LabelConfigFile
  label?: LabelConfigFile
  messages?: MessageConfigFile
  requirements?: RequirementConfigFile[]
  close?: {
    message?: string
  }
  logs?: LogConfigFile
  log?: LogConfigFile
  project?: ProjectConfigFile
}

export interface RuntimeConfig {
  verbose: boolean
  assign: boolean
  statusNames: Record<ManagedStatus, string>
  requirements: Array<{
    name?: string
    events: string[]
    actor: 'user' | 'owner' | 'any'
    pattern: string
    regex: RegExp
    label?: string
    addLabels: string[]
    removeLabels: string[]
    message?: string
    status?: ManagedStatus
  }>
  labels: {
    awaiting: string
    active: string[]
    exempt: string[]
    reopened?: string
    blocked: string[]
    canClose: string[]
  }
  close: {
    message?: string
  }
  logs: {
    regexSource?: string
    regex?: RegExp
    label?: string
    message?: string
  }
  project?: {
    url: string
    fields: {
      status: string | false
      endDate: string | false
      users: string | false
    }
    status: Record<ManagedStatus, string>
  }
}

const defaultProjectStatus: Record<ManagedStatus, string> = {
  blocked: 'Blocked',
  awaiting: 'Awaiting user input',
  'in-progress': 'In progress',
  new: 'To triage',
  backlog: 'Backlog',
}

function maybeString(value: string | false | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

function maybeFieldName(value: string | false | undefined, fallback: string): string | false {
  if (value === false) return false
  return maybeString(value) || fallback
}

function getInput(context: ActionContext, ...names: string[]): string {
  for (const name of names) {
    const value = context.getInput(name)
    if (value) return value
  }

  return ''
}

function toList(value: string | string[] | undefined): string[] {
  if (!value) return []

  if (Array.isArray(value)) {
    return value
      .map(item => item.trim())
      .filter(Boolean)
  }

  return value
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
}

function toRequirement(requirement: RequirementConfigFile, awaitingLabel: string): RuntimeConfig['requirements'][number] | undefined {
  const pattern = maybeString(requirement.pattern)
  if (!pattern) return undefined

  const label = maybeString(requirement.label)
  const addLabels = toList(requirement.addLabels)
  const removeLabels = toList(requirement.removeLabels)

  return {
    name: maybeString(requirement.name),
    events: toList(requirement.events).length ? toList(requirement.events) : ['issues.opened'],
    actor: requirement.actor || 'user',
    pattern,
    regex: new RegExp(pattern),
    label,
    addLabels: addLabels.length ? addLabels : (label ? [awaitingLabel, label] : [awaitingLabel]),
    removeLabels: removeLabels.length ? removeLabels : (label ? [label] : []),
    message: maybeString(requirement.message),
    status: requirement.status || 'awaiting',
  }
}

function optionalBoolInput(context: ActionContext, name: string): boolean | undefined {
  const value = maybeString(context.getInput(name))
  if (!value) return undefined
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error(`Input ${name} must be true or false`)
}

function parseInlineConfig(context: ActionContext): ConfigFile {
  const raw = maybeString(context.getInput('config'))
  if (!raw) return {}

  const parsed = parse(raw)
  if (!parsed || typeof parsed !== 'object') return {}

  return parsed as ConfigFile
}

function legacyInputConfig(context: ActionContext): ConfigFile {
  const config: ConfigFile = {}

  const verbose = optionalBoolInput(context, 'verbose')
  if (typeof verbose === 'boolean') config.verbose = verbose

  const assign = optionalBoolInput(context, 'assign')
  if (typeof assign === 'boolean') config.assign = assign

  const labels: LabelConfigFile = {
    awaiting: maybeString(getInput(context, 'label-awaiting')),
    active: maybeString(getInput(context, 'label-active')),
    exempt: maybeString(getInput(context, 'label-exempt')),
    reopened: maybeString(getInput(context, 'label-reopened')),
    blocked: maybeString(getInput(context, 'label-blocked')),
    canclose: maybeString(getInput(context, 'label-canclose')),
  }
  if (Object.values(labels).some(Boolean)) config.labels = labels

  const closeMessage = maybeString(getInput(context, 'close-message'))
  if (closeMessage) config.close = { message: closeMessage }

  const logs: LogConfigFile = {
    regex: maybeString(getInput(context, 'log-regex')),
    label: maybeString(getInput(context, 'log-label')),
    message: maybeString(getInput(context, 'log-message')),
  }
  if (Object.values(logs).some(Boolean)) config.logs = logs

  const projectFields: ProjectFieldConfigFile = {
    status: maybeString(getInput(context, 'project-field-status')),
    endDate: maybeString(getInput(context, 'project-field-end-date')),
    users: maybeString(getInput(context, 'project-field-users')),
  }
  const projectStatus: ProjectStatusConfigFile = {
    blocked: maybeString(getInput(context, 'project-status-blocked')),
    awaiting: maybeString(getInput(context, 'project-status-awaiting')),
    inProgress: maybeString(getInput(context, 'project-status-in-progress')),
    new: maybeString(getInput(context, 'project-status-new')),
    backlog: maybeString(getInput(context, 'project-status-backlog')),
  }
  const projectUrl = maybeString(getInput(context, 'project-url'))
  if (projectUrl || Object.values(projectFields).some(Boolean) || Object.values(projectStatus).some(Boolean)) {
    config.project = {
      url: projectUrl,
      fields: projectFields,
      status: projectStatus,
    }
  }

  return config
}

function mergeConfig(base: ConfigFile, override: ConfigFile): ConfigFile {
  return {
    ...base,
    ...override,
    labels: { ...(base.labels || base.label || {}), ...(override.labels || override.label || {}) },
    label: { ...(base.label || base.labels || {}), ...(override.label || override.labels || {}) },
    messages: { ...(base.messages || {}), ...(override.messages || {}) },
    close: { ...(base.close || {}), ...(override.close || {}) },
    logs: { ...(base.logs || base.log || {}), ...(override.logs || override.log || {}) },
    log: { ...(base.log || base.logs || {}), ...(override.log || override.logs || {}) },
    project: {
      ...(base.project || {}),
      ...(override.project || {}),
      fields: { ...(base.project?.fields || {}), ...(override.project?.fields || {}) },
      status: { ...(base.project?.status || {}), ...(override.project?.status || {}) },
    },
    requirements: override.requirements || base.requirements,
  }
}

export async function loadConfig(context: ActionContext): Promise<RuntimeConfig> {
  const raw = mergeConfig(
    mergeConfig((await context.config<ConfigFile>('label-gun.yml')) || {}, parseInlineConfig(context)),
    legacyInputConfig(context),
  )
  const labels = raw.labels || raw.label || {}
  const logs = raw.logs || raw.log || {}
  const project = raw.project || {}
  const projectStatus = project.status || {}
  const resolvedStatusNames: Record<ManagedStatus, string> = {
    blocked: maybeString(projectStatus.blocked) || defaultProjectStatus.blocked,
    awaiting: maybeString(projectStatus.awaiting) || defaultProjectStatus.awaiting,
    'in-progress': maybeString(projectStatus.inProgress || projectStatus['in-progress']) || defaultProjectStatus['in-progress'],
    new: maybeString(projectStatus.new) || defaultProjectStatus.new,
    backlog: maybeString(projectStatus.backlog) || defaultProjectStatus.backlog,
  }

  const regexSource = maybeString(logs.regex)
  const awaitingLabel = maybeString(labels.awaiting) || 'awaiting-user-feedback'
  const requirements = (raw.requirements || [])
    .map(requirement => toRequirement(requirement, awaitingLabel))
    .filter((requirement): requirement is NonNullable<typeof requirement> => !!requirement)

  if (regexSource) {
    const legacyRequirement = toRequirement({
      name: 'legacy-log-requirement',
      events: ['issues.opened'],
      actor: 'user',
      pattern: regexSource,
      label: maybeString(logs.label),
      message: maybeString(raw.messages?.missingLog) || maybeString(logs.message),
      addLabels: [awaitingLabel, ...(maybeString(logs.label) ? [maybeString(logs.label) as string] : [])],
      removeLabels: maybeString(logs.label) ? [maybeString(logs.label) as string] : [],
      status: 'awaiting',
    }, awaitingLabel)

    if (legacyRequirement) requirements.push(legacyRequirement)
  }

  return {
    verbose: !!raw.verbose,
    assign: !!raw.assign,
    statusNames: resolvedStatusNames,
    requirements,
    labels: {
      awaiting: awaitingLabel,
      active: toList(labels.active),
      exempt: toList(labels.exempt),
      reopened: maybeString(labels.reopened),
      blocked: toList(labels.blocked),
      canClose: toList(labels.canClose || labels.canclose),
    },
    close: {
      message: maybeString(raw.messages?.closedByUser) || maybeString(raw.close?.message),
    },
    logs: {
      regexSource,
      regex: regexSource ? new RegExp(regexSource) : undefined,
      label: maybeString(logs.label),
      message: maybeString(raw.messages?.missingLog) || maybeString(logs.message),
    },
    project: maybeString(project.url)
      ? {
        url: maybeString(project.url) as string,
        fields: {
          status: maybeFieldName(project.fields?.status, 'Status'),
          endDate: maybeFieldName(project.fields?.endDate, 'End date'),
          users: maybeFieldName(project.fields?.users, 'Users'),
        },
        status: resolvedStatusNames,
      }
      : undefined,
  }
}
