import * as core from '@actions/core'
import * as github from '@actions/github'

const token = core.getInput('token')
const octokit = github.getOctokit(token, { required: true })

const owner = github.context.payload.repository?.owner.login || ''
const repo = github.context.payload.repository?.name || ''
const username = github.context.payload.sender?.login || ''

async function run() {
  core.info(`token: ${!!token}`)
  const isCollaborator = await octokit.repos.checkCollaborator({ owner, repo, username })
  core.info(`isCollaborator: ${isCollaborator}`)
}

run().catch(err => core.error(err))
