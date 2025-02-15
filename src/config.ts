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

  user: {
    // assign active issues to this contributor when running the action manually
    assign: core.getInput('user.assign'),

    // these user logins are actually bots
    bots: core.getInput('user.bots').split(',').map(_ => _.trim()).filter(_ => _),
  },
  // log activity
  verbose: getBool('verbose', 'false'),

  issue: {
    // default: "all", when dispatching, run for this issue state
    state: getEnum('issue.state', ['all', 'open', 'closed']) as 'all' | 'open' | 'closed',
  },

  project: {
    // URL of project to update
    url: core.getInput('project.url'),

    // use this token for project updates. Will use the general token if missing, but the default github action token does not have the permissions required to update projects
    token: core.getInput('project.token') || core.getInput('token'),

    card: {
      status: {
        // default: "Backlog", project card state for open, unassigned issues
        new: core.getInput('project.card.status.new'),

        // default: "In progress", project card state for open, assigned issues
        assigned: core.getInput('project.card.status.assigned'),

        // default: "Awaiting user input", project card state for open issues awaiting user feedback
        awaiting: core.getInput('project.card.status.awaiting'),
      },

      field: {
        // default: "Start date", project field to note start date
        startDate: core.getInput('project.card.field.start-date'),

        // default: "End date", project field to note last active date
        endDate: core.getInput('project.card.field.end-date'),

        // default: "Status", project field for status
        status: core.getInput('project.card.field.status'),
      },
    },
  },
}
