import { getOctokit } from '@actions/github'
import { components } from '@octokit/openapi-types'

export type Issue = components['schemas']['issue']
export type IssueComment = components['schemas']['issue-comment']
export type OctokitLike = ReturnType<typeof getOctokit>

export interface ActionContext {
  name: 'issues' | 'issue_comment'
  payload: {
    action?: string
    sender?: {
      login?: string
      type?: string
    }
    repository?: {
      owner?: {
        login?: string
      }
      name?: string
    }
    issue?: Issue
    comment?: IssueComment
  }
  octokit: OctokitLike
  projectOctokit?: OctokitLike
  getInput(name: string): string
  config<T>(name: string): Promise<T | undefined>
  issue<T extends Record<string, unknown>>(extra?: T): { owner: string; repo: string; issue_number: number } & T
  repo<T extends Record<string, unknown>>(extra?: T): { owner: string; repo: string } & T
  log: {
    info(...message: unknown[]): void
    warn(...message: unknown[]): void
    error(...message: unknown[]): void
  }
}

export interface ActionResult {
  issue: string
  status: string
  users: string
  lastactive: string
}
