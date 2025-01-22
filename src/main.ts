import fs from 'fs/promises'
const stringify = require('fast-safe-stringify')
import * as core from '@actions/core'
const { context, getOctokit } = require('@actions/github')

const token = core.getInput('token', { required: true })
const octokit = getOctokit(token)

const issueNumber = context.issue.number
const owner = context.repo.owner
const repo = context.repo.repo

const input = {
  log: core.getInput('log-id') ? new RegExp(core.getInput('log-id')) : (undefined as unknown as RegExp),

  label: {
    active: core.getInput('label.active') || '',
    awaiting: core.getInput('label.awaiting'),
    exempt: core.getInput('label.exempt') || '',
    log_required: core.getInput('label.log-required'),
    reopened: core.getInput('label.reopened') || '',
    merge: core.getInput('label.merge') || '',
  },

  message: {
    log_required: core.getInput('message.log-required'),
    no_close: core.getInput('message.no-close'),
  },

  project: core.getInput('project') || '',
  column: {
    last: core.getInput('project.lastInteraction') || '',
    waiting: core.getInput('project.waiting') || '',
  },
}

const User = new class {
  #collaborator: Record<string, boolean> = { 'github-actions[bot]': true }

  async isCollaborator(username?: string): Promise<boolean> {
    if (!username) return false

    if (typeof this.#collaborator[username] !== 'boolean') {
      const { data: user } = await octokit.rest.repos.getCollaboratorPermissionLevel({ owner, repo, username })
      this.#collaborator[username] = user.permission !== 'none'
    }
    return this.#collaborator[username]
  }

  async kind(username: string): Promise<'user' | 'collaborator'> {
    return (await this.isCollaborator(username)) ? 'collaborator' : 'user'
  }
}()

const Project = new class {
  #columns: any[] = []
  #cards: Record<number, any[]> = {}

  async columns(): Promise<any[]> {
    if (!this.#columns.length) {
      const result = await octokit.graphql(`
        query($projectId: ID!) {
          node(id: $projectId) {
            ... on ProjectNext {
              columns: fields(first: 100) {
                nodes {
                  id
                  name
                }
              }
            }
          }
        }
      `, { projectId: input.project })
      this.#columns = result.node.columns.nodes
    }
    return this.#columns
  }

  async cards(): Promise<Record<number, any[]>> {
    if (!Object.keys(this.#cards).length) {
      const columns = await this.columns()
      for (const column of columns) {
        const result = await octokit.graphql(`
          query($columnId: ID!) {
            node(id: $columnId) {
              ... on ProjectNextField {
                cards: items(first: 100) {
                  nodes {
                    id
                    content {
                      ... on Issue {
                        id
                        number
                      }
                    }
                  }
                }
              }
            }
          }
        `, { columnId: column.id })
        this.#cards[column.id] = result.node.cards.nodes
      }
    }
    return this.#cards
  }

  async delete(cardId: string) {
    await octokit.graphql(`
      mutation($cardId: ID!) {
        deleteProjectNextItem(input: { projectId: "${input.project}", itemId: $cardId }) {
          clientMutationId
        }
      }
    `, { cardId })
    for (const columnId in this.#cards) {
      this.#cards[columnId] = this.#cards[columnId].filter(card => card.id !== cardId)
    }
  }

  async addCard(columnId: string, contentId: string) {
    const result = await octokit.graphql(`
      mutation($columnId: ID!, $contentId: ID!) {
        addProjectNextItem(input: { projectId: "${input.project}", contentId: $contentId }) {
          projectNextItem {
            id
          }
        }
      }
    `, { columnId, contentId })
    if (!this.#cards[columnId]) {
      this.#cards[columnId] = []
    }
    this.#cards[columnId].push(result.addProjectNextItem.projectNextItem)
  }

  async moveCard(cardId: string, columnName: string) {
    const columns = await this.columns()
    const column = columns.find(col => col.name === columnName)
    if (!column) throw new Error(`Column ${columnName} not found`)

    const cards = await this.cards()
    for (const columnCards of Object.values(cards)) {
      const card = columnCards.find(card => card.id === cardId)
      if (card && card.columnId === column.id) return
    }

    await octokit.graphql(`
      mutation($cardId: ID!, $columnId: ID!) {
        moveProjectNextItem(input: { projectId: "${input.project}", itemId: $cardId, columnId: $columnId }) {
          clientMutationId
        }
      }
    `, { cardId, columnId: column.id })

    for (const columnId in this.#cards) {
      this.#cards[columnId] = this.#cards[columnId].filter(card => card.id !== cardId)
    }

    if (!this.#cards[column.id]) {
      this.#cards[column.id] = []
    }

    const result = await octokit.graphql(`
      query($cardId: ID!) {
        node(id: $cardId) {
          ... on ProjectNextItem {
            id
          }
        }
      }
    `, { cardId })
    this.#cards[column.id].push(result.node)
  }
}()

class Issue {
  #issue: any
  #comments: any[]
  constructor(issue: any, comments: any[]) {
    this.#issue = issue
    this.#comments = comments
  }

  async update(): Promise<void> {
    await this.updateIssue()
    await this.updateProject()
  }

  async updateProject() {
    const cards = await Project.cards()
    let card: any | undefined
    for (const columnCards of Object.values(cards)) {
      card = columnCards.find(card => card.content?.number === this.#issue.number)
      if (card) break
    }
    if (!card && this.#issue.state === 'open') {
      const columns = await Project.columns()
      await Project.addCard(columns[0].id, this.#issue.id)
    }
    else if (card && this.#issue.state === 'closed') {
      await Project.delete(card.id)
      card = undefined
    }

    if (!card) return

    const sender = context.payload.sender.login
    let active = (await User.isCollaborator(sender)) || (await User.isCollaborator(this.#issue.user?.login))
    for (const comment of this.#comments) {
      active = active || (await User.isCollaborator(comment.user?.login))
      if (active) break
    }

    let lastInteractionDate = new Date(this.#issue.updated_at)

    if (input.column.last) {
      for (const comment of this.#comments) {
        const commentDate = new Date(comment.updated_at)
        if (commentDate > lastInteractionDate) {
          lastInteractionDate = commentDate
        }
      }
    }

    const fields = {
      [input.column.last]: lastInteractionDate.toISOString(),
      [input.column.waiting]: Math.floor((new Date().getTime() - lastInteractionDate.getTime()) / (1000 * 60 * 60 * 24)),
    }
    delete fields['']

    if (input.column.last || input.column.waiting) {
      await octokit.graphql(`
        mutation($cardId: ID!, $fields: JSON!) {
          updateProjectNextItemField(input: { projectId: "${input.project}", itemId: $cardId, fields: $fields }) {
            clientMutationId
          }
        }
      `, { cardId: card.id, fields })
    }
  }

  async updateIssue(): Promise<void> {
    const sender = context.payload.sender.login

    const user = {
      login: sender,
      isCollaborator: await User.isCollaborator(sender),
    }

    const comments = this.#comments.length

    const body = comments ? this.#comments[comments - 1].body : this.#issue.body

    if (user.isCollaborator) {
      if (this.#issue.state !== 'closed') await this.label(input.label.awaiting)
    }
    else {
      const exempt = this.#issue.labels.find(label => (typeof label === 'string' ? label : label.name) === input.label.exempt)
      if (context.payload.action === 'closed') {
        if (!exempt) await this.label(input.label.merge)
      }
      else if (context.eventName === 'issue_comment') {
        if (this.#issue.state === 'closed') {
          await octokit.rest.issues.update({
            owner,
            repo,
            issue_number: this.#issue.number,
            state: 'open',
          })
          this.#issue.state = 'open'
        }
      }

      await this.unlabel(input.label.awaiting)

      const body = comments ? this.#comments[comments - 1].body : this.#issue.body
      const required = input.log && (!input.label.exempt || !exempt)
      const found = (body || '').match(input.log)
      if (required) {
        if (!comments && !found) { // new issue, missing log
          await this.label(input.label.log_required)

          if (input.message.log_required) {
            await octokit.rest.issues.createComment({
              owner,
              repo,
              issue_number: issueNumber,
              body: input.message.log_required.replace('{{username}}', sender),
            })
          }
        }

        if (found) await this.unlabel(input.label.log_required)
      }
    }
  }

  async unlabel(name: string) {
    if (!name) return

    let remove = false
    this.#issue.labels = this.#issue.labels.filter(label => {
      const labelname = typeof label === 'string' ? label : label.name
      if (labelname === name) {
        remove = true
        return false
      }
      else {
        return true
      }
    })
    if (remove) await octokit.rest.issues.removeLabel({ owner, repo, issue_number: issueNumber, name })
  }

  async label(name: string) {
    if (!name) return

    let add = true
    this.#issue.labels = this.#issue.labels.filter(label => {
      const labelname = typeof label === 'string' ? label : label.name
      if (labelname === name) add = false
      return true
    })
    if (add) {
      this.#issue.labels.push({ name })
      await octokit.rest.issues.addLabels({ owner, repo, issue_number: issueNumber, labels: [name] })
    }
  }
}

async function run() {
  switch (context.eventName) {
    case 'workflow_dispatch': {
      const { data: issues } = await octokit.rest.issues.listForRepo({ owner, repo })
      for (const issue of issues) {
        const { data: comments } = await octokit.rest.issues.listComments({ owner, repo, issue_number: issue.number })
        await (new Issue(issue, comments)).update()
      }
      break
    }
    case 'issues': {
      const { data: issue } = await octokit.rest.issues.get({ owner, repo, issue_number: issueNumber })
      const { data: comments } = await octokit.rest.issues.listComments({ owner, repo, issue_number: issueNumber })
      await (new Issue(issue, comments)).update()
      break
    }

    case 'issue_comment': {
      const { data: issue } = await octokit.rest.issues.get({ owner, repo, issue_number: issueNumber })
      const { data: comments } = await octokit.rest.issues.listComments({ owner, repo, issue_number: issueNumber })
      await (new Issue(issue, comments)).update()
      break
    }

    default:
      core.setFailed(`Unsupported event: ${context.eventName}`)
      break
  }
}

run().catch(err => {
  console.log(err)
  process.exit(1)
})
