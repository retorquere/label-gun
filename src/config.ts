import * as core from '@actions/core'

function getEnum(i: string, options: string[], dflt?: string): string {
  if (!options.length) throw new Error(`enum ${i} needs options`)
  if (!dflt) dflt = options[0]
  if (!options.includes(dflt)) throw new Error(`Default ${JSON.stringify(dflt)} must be one of ${JSON.stringify(options)}`)
  const o = core.getInput(i) || dflt
  if (options.includes(o)) return o
  const mapped = options.find(_ => _.toLowerCase() === o.toLowerCase())
  if (mapped) return mapped
  throw new Error(`Default ${JSON.stringify(o)} must be one of ${JSON.stringify(options)}`)
}

function getBool(i: string, dlft: 'true' | 'false' = 'false'): boolean {
  return getEnum(i, ['false', 'true']) === 'true'
}

export const config = {
  token: core.getInput('token'),
  label: {
    awaiting: core.getInput('label.awaiting'),
    active: core.getInput('label.active'),
    exempt: core.getInput('label.exempt'),
  },
  close: {
    message: core.getInput('close.message'),
    notified: core.getInput('close.notified'),
    label: core.getInput('close.label'),
  },
  log: {
    regex: core.getInput('log.regex') ? new RegExp(core.getInput('log.regex')) : (undefined as unknown as RegExp),
    message: core.getInput('log.message'),
    label: core.getInput('log.label'),
  },
  user: {
    assign: core.getInput('user.assign'),
    bots: core.getInput('user.bots'),
  },
  verbose: getBool('verbose', 'false'),
  issue: {
    state: getEnum('issue.state', ['all', 'open', 'closed']) as 'all' | 'open' | 'closed',
  },
  project: {
    token: core.getInput('project.token'),
    url: core.getInput('project.url'),
    state: {
      new: core.getInput('project.state.new'),
      assigned: core.getInput('project.state.assigned'),
      waiting: core.getInput('project.state.waiting'),
    },
    field: {
      startDate: core.getInput('project.field.startDate'),
      endDate: core.getInput('project.field.endDate'),
      status: core.getInput('project.field.status'),
    },
  },
}

config.project.token = config.project.token || config.token
