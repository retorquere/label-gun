import * as core from '@actions/core'
import { context, getOctokit } from '@actions/github'
import { RequestError } from '@octokit/request-error'
import { parse } from 'yaml'

import { ActionContext } from './action-context'
import { handleLabelGunEvent } from './app'

function decodeContent(content: string, encoding?: string): string {
  if (encoding === 'base64') return Buffer.from(content, 'base64').toString('utf8')
  return content
}

function stringify(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function createContext(): ActionContext {
  const token = core.getInput('token', { required: true })
  const projectToken = core.getInput('project-token') || token
  const octokit = getOctokit(token)
  const projectOctokit = projectToken === token ? octokit : getOctokit(projectToken)

  return {
    name: context.eventName as ActionContext['name'],
    payload: {
      action: context.payload.action,
      sender: context.payload.sender
        ? {
          login: context.payload.sender.login,
          type: context.payload.sender.type,
        }
        : undefined,
      repository: context.payload.repository
        ? {
          owner: { login: context.payload.repository.owner?.login },
          name: context.payload.repository.name,
        }
        : undefined,
      issue: context.payload.issue as ActionContext['payload']['issue'],
      comment: context.payload.comment as ActionContext['payload']['comment'],
    },
    octokit,
    projectOctokit,
    getInput(name: string) {
      return core.getInput(name)
    },
    async config<T>(defaultName: string): Promise<T | undefined> {
      const path = core.getInput('config-path') || defaultName
      const owner = context.payload.repository?.owner?.login
      const repo = context.payload.repository?.name
      if (!owner || !repo || !path) return undefined

      try {
        const { data } = await octokit.rest.repos.getContent({ owner, repo, path })
        if (Array.isArray(data) || !('content' in data)) return undefined
        return parse(decodeContent(data.content || '', data.encoding)) as T
      }
      catch (error) {
        if (error instanceof RequestError && error.status === 404) return undefined
        throw error
      }
    },
    issue<T extends Record<string, unknown>>(extra?: T) {
      return {
        owner: context.payload.repository?.owner?.login || '',
        repo: context.payload.repository?.name || '',
        issue_number: context.payload.issue?.number || 0,
        ...(extra || {} as T),
      }
    },
    repo<T extends Record<string, unknown>>(extra?: T) {
      return {
        owner: context.payload.repository?.owner?.login || '',
        repo: context.payload.repository?.name || '',
        ...(extra || {} as T),
      }
    },
    log: {
      info(...message: unknown[]) {
        core.info(message.map(stringify).join(' '))
      },
      warn(...message: unknown[]) {
        core.warning(message.map(stringify).join(' '))
      },
      error(...message: unknown[]) {
        core.error(message.map(stringify).join(' '))
      },
    },
  }
}

async function run(): Promise<void> {
  try {
    if (!['issues', 'issue_comment'].includes(context.eventName)) {
      throw new Error(`Unexpected event ${context.eventName}`)
    }

    const result = await handleLabelGunEvent(createContext())
    core.setOutput('issue', result.issue)
    core.setOutput('status', result.status)
    core.setOutput('users', result.users)
    core.setOutput('lastactive', result.lastactive)
  }
  catch (error) {
    core.setFailed((error as Error).message)
  }
}

void run()
