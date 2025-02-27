import * as core from '@actions/core'

function getEnum(i: string, options: string[]): string {
  options = options.filter(_ => _)
  if (!options.length) throw new Error(`enum ${i} needs options`)
  const o = core.getInput(i) || options[0]
  if (options.includes(o)) return o
  const mapped = options.find(_ => _.toLowerCase() === o.toLowerCase())
  if (mapped) return mapped
  throw new Error(`Default ${JSON.stringify(o)} must be one of ${JSON.stringify(options)}`)
}

function getBool(i: string, dlft: 'true' | 'false' = 'false'): boolean {
  return getEnum(i, ['false', 'true']) === 'true'
}

export const config = {
  // required; token to post to the issue list
  token: core.getInput('token'),

  label: {
    // required; default: "awaiting-user-feedback", label issues that require user feedback to proceed
    awaiting: core.getInput('label.awaiting'),

    // only act on issues with this tag
    active: core.getInput('label.active'),

    // ignore issues with this tag
    exempt: core.getInput('label.exempt'),

    // re-open issue when non-collaborator posts, and label issue. Issues re-opened this way can be closed by non-collaborators.
    reopened: core.getInput('label.reopened'),
  },

  close: {
    // when set, assigned issues can only be closed by collaborators. Since github doesn't allow to set this behavior, re-open the issue and show this message
    message: core.getInput('close.message'),
  },

  log: {
    // search for this regular expression to detect log ID
    regex: core.getInput('log.regex') ? new RegExp(core.getInput('log.regex')) : (undefined as unknown as RegExp),

    // post this comment when log ID is missing
    message: core.getInput('log.message'),

    // tag issues with missing log ID with this label
    label: core.getInput('log.label'),
  },
  // log activity
  verbose: getBool('verbose', 'false'),

  // assign issue to owner on owner interaction
  assign: getBool('assign', 'false'),

  project: {
    state: {
      // default: "Awaiting user input", Status to output for issues that are waiting for feedback
      awaiting: core.getInput('project.state.awaiting'),

      // default: "In progress", Status to output for issues that are in progress
      inProgress: core.getInput('project.state.in-progress'),

      // default: "To triage", Status to output for issues that are new
      new: core.getInput('project.state.new'),

      // default: "Backlog", Status to output for issues that have been seen by a repo owner but not acted on
      backlog: core.getInput('project.state.backlog'),
    },
  },
}
