import { ActionContext } from './action-context'

import { ManagedStatus, RuntimeConfig } from './config'

interface ProjectFieldOption {
  id: string
  name: string
}

interface ProjectFieldNode {
  __typename: string
  id: string
  name: string
  dataType?: string
  options?: ProjectFieldOption[]
}

interface ProjectField {
  id: string
  name: string
  kind: 'single-select' | 'text' | 'date' | 'unknown'
  options: ProjectFieldOption[]
}

interface ProjectItem {
  id: string
  content?: {
    id: string
  }
}

interface ProjectItemsQuery {
  node: {
    items: {
      nodes: ProjectItem[]
      pageInfo: {
        hasNextPage: boolean
        endCursor: string | null
      }
    }
  }
}

interface ParsedProjectUrl {
  owner: string
  kind: 'user' | 'org' | 'repo'
  repo?: string
  number: number
}

function parseProjectUrl(url: string): ParsedProjectUrl {
  const match = url.match(/^https:\/\/github\.com\/(?:(orgs|users)\/([^/]+)|([^/]+)\/([^/]+))\/projects\/(\d+)$/)

  if (!match) throw new Error(`Invalid GitHub project URL: ${url}`)

  const number = Number.parseInt(match[5], 10)

  if (match[1] === 'orgs') {
    return { owner: match[2], kind: 'org', number }
  }

  if (match[1] === 'users') {
    return { owner: match[2], kind: 'user', number }
  }

  return {
    owner: match[3],
    repo: match[4],
    kind: 'repo',
    number,
  }
}

function toField(node: ProjectFieldNode): ProjectField {
  if (node.__typename === 'ProjectV2SingleSelectField') {
    return {
      id: node.id,
      name: node.name,
      kind: 'single-select',
      options: node.options || [],
    }
  }

  if (node.dataType === 'TEXT') {
    return { id: node.id, name: node.name, kind: 'text', options: [] }
  }

  if (node.dataType === 'DATE') {
    return { id: node.id, name: node.name, kind: 'date', options: [] }
  }

  return { id: node.id, name: node.name, kind: 'unknown', options: [] }
}

async function loadProject(context: ActionContext, url: string): Promise<{ id: string; fields: ProjectField[] }> {
  const octokit = context.projectOctokit || context.octokit
  const parsed = parseProjectUrl(url)

  if (parsed.kind === 'repo') {
    const result = await octokit.graphql<{
      repository: {
        projectV2: {
          id: string
          fields: {
            nodes: ProjectFieldNode[]
          }
        } | null
      }
    }>(
      `query RepoProject($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          projectV2(number: $number) {
            id
            fields(first: 100) {
              nodes {
                __typename
                ... on ProjectV2FieldCommon {
                  id
                  name
                }
                ... on ProjectV2Field {
                  dataType
                }
                ... on ProjectV2SingleSelectField {
                  options {
                    id
                    name
                  }
                }
              }
            }
          }
        }
      }`,
      { owner: parsed.owner, repo: parsed.repo, number: parsed.number },
    )

    if (!result.repository.projectV2) throw new Error(`Project not found for ${url}`)

    return {
      id: result.repository.projectV2.id,
      fields: result.repository.projectV2.fields.nodes.filter(Boolean).map(toField),
    }
  }

  const root = parsed.kind === 'org' ? 'organization' : 'user'
  const result = await octokit.graphql<{
    organization?: {
      projectV2: {
        id: string
        fields: {
          nodes: ProjectFieldNode[]
        }
      } | null
    }
    user?: {
      projectV2: {
        id: string
        fields: {
          nodes: ProjectFieldNode[]
        }
      } | null
    }
  }>(
    `query OwnerProject($owner: String!, $number: Int!) {
      ${root}(login: $owner) {
        projectV2(number: $number) {
          id
          fields(first: 100) {
            nodes {
              __typename
              ... on ProjectV2FieldCommon {
                id
                name
              }
              ... on ProjectV2Field {
                dataType
              }
              ... on ProjectV2SingleSelectField {
                options {
                  id
                  name
                }
              }
            }
          }
        }
      }
    }`,
    { owner: parsed.owner, number: parsed.number },
  )

  const project = parsed.kind === 'org' ? result.organization?.projectV2 : result.user?.projectV2

  if (!project) throw new Error(`Project not found for ${url}`)

  return {
    id: project.id,
    fields: project.fields.nodes.filter(Boolean).map(toField),
  }
}

async function findProjectItem(context: ActionContext, projectId: string, issueNodeId: string): Promise<string | undefined> {
  const octokit = context.projectOctokit || context.octokit
  let hasNextPage = true
  let after: string | null = null

  while (hasNextPage) {
    const result: ProjectItemsQuery = await octokit.graphql(
      `query ProjectItems($projectId: ID!, $after: String) {
        node(id: $projectId) {
          ... on ProjectV2 {
            items(first: 100, after: $after) {
              nodes {
                id
                content {
                  ... on Issue {
                    id
                  }
                }
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        }
      }`,
      { projectId, after },
    )

    const item = result.node.items.nodes.find((candidate: ProjectItem) => candidate.content?.id === issueNodeId)
    if (item) return item.id

    hasNextPage = result.node.items.pageInfo.hasNextPage
    after = result.node.items.pageInfo.endCursor
  }

  return undefined
}

async function addProjectItem(context: ActionContext, projectId: string, issueNodeId: string): Promise<string> {
  const octokit = context.projectOctokit || context.octokit
  const result = await octokit.graphql<{
    addProjectV2ItemById: {
      item: {
        id: string
      }
    }
  }>(
    `mutation AddItem($projectId: ID!, $contentId: ID!) {
      addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
        item {
          id
        }
      }
    }`,
    { projectId, contentId: issueNodeId },
  )

  return result.addProjectV2ItemById.item.id
}

async function updateSingleSelectField(context: ActionContext, projectId: string, itemId: string, fieldId: string, optionId: string): Promise<void> {
  const octokit = context.projectOctokit || context.octokit
  await octokit.graphql(
    `mutation SetSingleSelect($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId,
        itemId: $itemId,
        fieldId: $fieldId,
        value: { singleSelectOptionId: $optionId }
      }) {
        projectV2Item {
          id
        }
      }
    }`,
    { projectId, itemId, fieldId, optionId },
  )
}

async function updateTextField(context: ActionContext, projectId: string, itemId: string, fieldId: string, text: string): Promise<void> {
  const octokit = context.projectOctokit || context.octokit
  await octokit.graphql(
    `mutation SetText($projectId: ID!, $itemId: ID!, $fieldId: ID!, $text: String!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId,
        itemId: $itemId,
        fieldId: $fieldId,
        value: { text: $text }
      }) {
        projectV2Item {
          id
        }
      }
    }`,
    { projectId, itemId, fieldId, text },
  )
}

async function updateDateField(context: ActionContext, projectId: string, itemId: string, fieldId: string, date: string): Promise<void> {
  const octokit = context.projectOctokit || context.octokit
  await octokit.graphql(
    `mutation SetDate($projectId: ID!, $itemId: ID!, $fieldId: ID!, $date: Date!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId,
        itemId: $itemId,
        fieldId: $fieldId,
        value: { date: $date }
      }) {
        projectV2Item {
          id
        }
      }
    }`,
    { projectId, itemId, fieldId, date },
  )
}

function findField(fields: ProjectField[], name: string | false): ProjectField | undefined {
  if (!name) return undefined
  return fields.find(field => field.name === name)
}

export async function syncProject(
  context: ActionContext,
  config: NonNullable<RuntimeConfig['project']>,
  issueNodeId: string,
  status: ManagedStatus,
  users: string[],
  lastActive?: string,
): Promise<void> {
  const project = await loadProject(context, config.url)
  const statusValue = config.status[status]
  const statusField = findField(project.fields, config.fields.status)

  if (!statusField) throw new Error(`Project field ${String(config.fields.status)} not found`)

  let itemId = await findProjectItem(context, project.id, issueNodeId)
  if (!itemId) itemId = await addProjectItem(context, project.id, issueNodeId)

  if (statusField.kind === 'single-select') {
    const option = statusField.options.find(candidate => candidate.name === statusValue)
    if (!option) throw new Error(`Project status option ${statusValue} not found in ${statusField.name}`)
    await updateSingleSelectField(context, project.id, itemId, statusField.id, option.id)
  }
  else if (statusField.kind === 'text') {
    await updateTextField(context, project.id, itemId, statusField.id, statusValue)
  }
  else {
    throw new Error(`Project field ${statusField.name} must be a single select or text field`)
  }

  const endDateField = findField(project.fields, config.fields.endDate)
  if (endDateField && lastActive) {
    if (endDateField.kind !== 'date') throw new Error(`Project field ${endDateField.name} must be a date field`)
    await updateDateField(context, project.id, itemId, endDateField.id, lastActive)
  }

  const usersField = findField(project.fields, config.fields.users)
  if (usersField && users.length) {
    if (usersField.kind !== 'text') throw new Error(`Project field ${usersField.name} must be a text field`)
    await updateTextField(context, project.id, itemId, usersField.id, users.join(', '))
  }
}
