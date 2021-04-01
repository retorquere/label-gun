import * as core from '@actions/core'
import * as github from '@actions/github'
import {
  IssueCommentEvent,
  IssuesEvent,
  Label,
  Schema
} from '@octokit/webhooks-definitions/schema'

const token = core.getInput('token')
core.info(`token: ${!!token}`)
const octokit = github.getOctokit(token)

const complaint = `
It looks like you did not upload an support log. The support log is important; it gives @retorquere your current BBT settings and a copy of the problematic reference as a test case so he can best replicate your problem. Without it, @retorquere is effectively blind. Support logs are useful for both analysis and for enhancement requests; in the case of export enhancements, @retorquere need the copy of the references you have in mind.

If you did try to submit a support log, but the ID looked like \`D<number>\`, that is a Zotero debug report, which @retorquere cannot access. Please re-submit a BBT debug log by one of the methods below. BBT support log IDs end in \`-apse\` or \`-euc\`.

**This request is much more likely than not to apply to you, too, _even if you think it unlikely_**, and even if it does not, there's no harm in sending a debug log that turns out to be unnecessary. @retorquere will usually just end up saying "please send a debug log first". Let's just skip over the unnecesary delay this entails. Sending a debug log is very easy, depending on your situation, follow one of these procedures::

1. If your issue relates to how BBT behaves around a **specific reference(s)**, such as citekey generation or export, select at least one of the problematic reference(s), right-click it, and submit an BBT support log from that popup menu. If the problem is with export, please do include a sample of what you see exported, and what you expected to see exported for these references, either by pasting it in a comment here (if it is small) or attaching it as a \`.txt\` file (if it's large).

2. If the issue **does not relate to references** and is of a more general nature, generate an support log by restarting Zotero with debugging enabled (\`Help\` -> \`Debug Output Logging\` -> \`Restart with logging enabled\`), reproducing your problem, and selecting \`Send Better BibTeX debug report...\` from the help menu.

Once done, you will see a support log ID in red. Please post that support log id in an issue comment here.

Thank you!
`

const Labels = {
  needsSupportLog: 'needs-support-log',
  awaiting: 'awaiting-user-feedback'
}

const prompt = 'Support ID:'

function state() {}

async function run(): Promise<void> {
  try {
    // https://docs.github.com/en/developers/webhooks-and-events/webhook-events-and-payloads#issue_comment
    // https://docs.github.com/en/actions/reference/events-that-trigger-workflows

    const owner = github.context.payload.repository?.owner.login || ''
    const repo = github.context.payload.repository?.name || ''
    const username = github.context.payload.sender?.login || ''
    core.info(`running on ${JSON.stringify({owner, repo, username})}`)
    core.info('request:isCollaborator')

    let isCollaborator = false
    try {
      await octokit.repos.checkCollaborator({ owner, repo, username })
      isCollaborator = true
    } catch (err) {
      isCollaborator = false
    }

    let labels: Label[] = []
    let body = ''
    if (github.context.eventName == 'issues') {
      const event = github.context.payload as IssuesEvent
      if (event) {
        labels = event.issue.labels || []
        body = event.issue.body
      }
    } else if (github.context.eventName == 'issue_comment') {
      const event = github.context.payload as IssueCommentEvent
      if (event) {
        labels = event.issue.labels || []
        body = event.comment.body
      }
    }

    const isQuestion = labels.map(label => label.name).join(',') === 'question'
    let needsSupportLog = !!labels.find(
      label => label.name === Labels.needsSupportLog
    )
    const awaiting = !!labels.find(label => label.name === Labels.awaiting)
    const hasSupportLogId = body.match(/[A-Z0-9]{8}-(apse|euc)/)
    const prompted = body.includes(prompt)

    const tag: string = core.getInput('tag')
    if (tag && !labels.find(label => label.name == tag)) return

    if (github.context.eventName === 'issues') {
      const event = github.context.payload as IssuesEvent
      const issue_number = event.issue.number

      switch (event.action) {
        case 'opened':
          if (!isQuestion && !hasSupportLogId && !isCollaborator) {
            core.info('request:createComment')
            await octokit.issues.createComment({
              owner,
              repo,
              issue_number,
              body: complaint
            })
            core.info('request:addLabels')
            await octokit.issues.addLabels({
              owner,
              repo,
              issue_number,
              labels: [Labels.needsSupportLog]
            })
            needsSupportLog = true
          }
          break

        case 'edited':
          if (needsSupportLog && hasSupportLogId) {
            core.info('request:removeLabel')
            await octokit.issues.removeLabel({
              owner,
              repo,
              issue_number,
              name: Labels.needsSupportLog
            })
            needsSupportLog = false
          } else if (!prompted) {
            core.info('request:update')
            await octokit.issues.update({
              owner,
              repo,
              issue_number,
              body: `${event.issue.body}\n\n${prompt}`
            })
          }
          break

        case 'closed':
          if (!isCollaborator && !isQuestion) {
            core.info('request:update')
            await octokit.issues.update({
              owner,
              repo,
              issue_number,
              state: 'open'
            })
            core.info('request:createComment')
            await octokit.issues.createComment({
              owner,
              repo,
              issue_number,
              body: `@${owner} prefers to keep bugreports/enhancements open until the change is merged into a new release.`
            })
          } else if (awaiting || needsSupportLog) {
            core.info('request:setLabels')
            await octokit.issues.setLabels({
              owner,
              repo,
              issue_number,
              labels: labels
                .filter(
                  (label: Label) =>
                    label.name !== Labels.awaiting &&
                    label.name !== Labels.needsSupportLog
                )
                .map((label: Label) => label.name)
            })
            needsSupportLog = false
          }
          break
      }
    } else if (github.context.eventName === 'issue_comment') {
      const event = github.context.payload as IssueCommentEvent

      if (event.action === 'created') {
        if (isCollaborator) {
          core.info('request:addLabels')
          await octokit.issues.addLabels({
            owner,
            repo,
            issue_number: event.issue.number,
            labels: [Labels.awaiting]
          })
        } else {
          core.info('request:removeLabels')
          await octokit.issues.removeLabel({
            owner,
            repo,
            issue_number: event.issue.number,
            name: Labels.awaiting
          })
        }
      }

      if (needsSupportLog) {
        if (hasSupportLogId) {
          core.info('request:removeLabel')
          await octokit.issues.removeLabel({
            owner,
            repo,
            issue_number: event.issue.number,
            name: Labels.needsSupportLog
          })
          needsSupportLog = false
        } else if (!prompted) {
          core.info('request:updateComment')
          await octokit.issues.updateComment({
            owner,
            repo,
            comment_id: event.comment.id,
            body: event.comment.body + '\n\n' + prompt
          })
        }
      }
    }

    // core.info(`Waiting ${ms} milliseconds ...`) // debug is only output if you set the secret `ACTIONS_RUNNER_DEBUG` to true

    core.setOutput('needsSupportLog', needsSupportLog ? 'true' : 'false')
  } catch (err) {
    core.info(`error: ${err}\n${err.stack}`)
    core.setFailed(err.message)
  }
}

run()
