const assert = require('node:assert/strict')
const test = require('node:test')
const path = require('node:path')

const appEntry = path.resolve(__dirname, '../lib/app.js')

function loadHandler() {
  delete require.cache[appEntry]
  return require(appEntry).handleLabelGunEvent
}

function createIssue(labels) {
  return {
    number: 42,
    body: 'Issue body',
    state: 'closed',
    updated_at: '2026-05-27T12:00:00Z',
    user: { login: 'reporter' },
    assignees: [],
    node_id: 'ISSUE_node_id',
    labels: labels.map(name => ({ name })),
  }
}

function createContext(config, issue, operations, event = {}) {
  const name = event.name || 'issues'
  const action = event.action || 'closed'
  const commentBody = event.commentBody
  const sender = event.sender || { login: 'reporter', type: 'User' }
  const issueComments = event.comments || []

  return {
    name,
    payload: {
      action,
      sender,
      repository: {
        owner: { login: 'retorquere' },
        name: 'label-gun',
      },
      issue,
      ...(commentBody ? { comment: { body: commentBody } } : {}),
    },
    getInput() {
      return ''
    },
    config: async () => config,
    issue(extra = {}) {
      return {
        owner: 'retorquere',
        repo: 'label-gun',
        issue_number: issue.number,
        ...extra,
      }
    },
    repo(extra = {}) {
      return {
        owner: 'retorquere',
        repo: 'label-gun',
        ...extra,
      }
    },
    log: {
      info() {},
      warn() {},
      error() {},
    },
    octokit: {
      paginate: async () => issueComments,
      graphql: async () => {
        throw new Error('graphql should not be called in this test')
      },
      rest: {
        repos: {
          async getCollaboratorPermissionLevel({ username }) {
            return {
              data: {
                permission: username === 'reporter' ? 'none' : 'admin',
              },
            }
          },
        },
        issues: {
          async addLabels(input) {
            operations.labelsAdded.push(input)
            return { data: {} }
          },
          async removeLabel(input) {
            operations.labelsRemoved.push(input)
            return { data: {} }
          },
          async createComment(input) {
            operations.comments.push(input)
            return { data: {} }
          },
          async update(input) {
            operations.reopened.push(input)
            return { data: {} }
          },
          async addAssignees(input) {
            operations.assigneesAdded.push(input)
            return { data: {} }
          },
          async removeAssignees(input) {
            operations.assigneesRemoved.push(input)
            return { data: {} }
          },
          async listComments() {
            return { data: issueComments }
          },
        },
      },
    },
  }
}

async function runScenario({ labels = [], config, event } = {}) {
  const comments = []
  const reopened = []
  const operations = {
    comments,
    reopened,
    labelsAdded: [],
    labelsRemoved: [],
    assigneesAdded: [],
    assigneesRemoved: [],
  }

  const issue = createIssue(labels)
  const scenarioConfig = config || {
    labels: {
      awaiting: 'awaiting-user-feedback',
      reopened: 'reopened',
      canClose: 'question',
    },
    messages: {
      closedByUser: 'Please leave this open',
    },
    logs: {
      label: 'needs-debug-log',
    },
  }

  const handler = loadHandler()
  if (event?.issueBody) issue.body = event.issueBody
  if (event?.state) issue.state = event.state
  await handler(createContext(scenarioConfig, issue, operations, event))

  return operations
}

test('user can close an issue labeled with label.canclose without it being reopened', async () => {
  const result = await runScenario({ labels: ['question'] })

  assert.equal(result.reopened.length, 0)
  assert.equal(result.comments.length, 0)
  assert.equal(result.labelsAdded.length, 0)
})

test('user-closing an issue without owner comments can close it', async () => {
  const result = await runScenario()

  assert.equal(result.reopened.length, 0)
  assert.equal(result.comments.length, 0)
})

test('user-closing an issue without label.canclose still reopens it after owner activity', async () => {
  const result = await runScenario({
    event: {
      comments: [
        {
          user: { login: 'maintainer' },
          updated_at: '2026-05-27T13:00:00Z',
        },
      ],
    },
  })

  assert.equal(result.reopened.length, 1)
  assert.equal(result.reopened[0].state, 'open')
  assert.equal(result.comments.length, 1)
})

test('generic triage requirements can demand other evidence without code changes', async () => {
  const result = await runScenario({
    labels: [],
    config: {
      labels: {
        awaiting: 'awaiting-user-feedback',
      },
      requirements: [
        {
          name: 'repro-steps',
          events: ['issues.opened'],
          actor: 'user',
          pattern: 'Steps to reproduce:',
          addLabels: ['awaiting-user-feedback', 'needs-repro-steps'],
          removeLabels: ['needs-repro-steps'],
          message: 'Please add reproduction steps, @{{username}}',
          status: 'awaiting',
        },
      ],
    },
    event: {
      name: 'issues',
      action: 'opened',
      state: 'open',
      issueBody: 'Problem description only',
    },
  })

  assert.equal(result.reopened.length, 0)
  assert.equal(result.labelsAdded.length, 2)
  assert.equal(result.comments.length, 1)
  assert.match(result.comments[0].body, /reporter/)
})