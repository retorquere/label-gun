const stringify = require('fast-safe-stringify')
import * as core from '@actions/core'
import * as github from '@actions/github'
import {
  IssueCommentEvent,
  IssuesEvent,
  Label,
  Schema
} from '@octokit/webhooks-definitions/schema'

const token = core.getInput('token')
const octokit = github.getOctokit(token)

/*
octokit.hook.wrap('request', async (request, options) => {
  const start = Date.now()
  try {
    const response = await request(options)
    core.info(stringify({
      request: options,
      time: Date.now() - start
    }))
    return response
  } catch (error) {
    error.time = Date.now() - start
    core.error(error)
    throw error
  }
})
*/


const Labels = {
  needsSupportLog: 'needs-support-log',
  awaiting: 'awaiting-user-feedback',
  needsReferences: ['export', 'citekey'],
}

const Reasons = {
  nolog: 'It looks like you did not upload an support log. ',
  norefs: 'It looks like you did not upload an support log with sample references. ',
}

const complaint = `
The support log is important; it gives @retorquere your current BBT settings and a copy of the problematic reference as a test case so he can best replicate your problem. Without it, @retorquere is effectively blind. Support logs are useful for both analysis and for enhancement requests; in the case of export enhancements, @retorquere need the copy of the references you have in mind.

If you did try to submit a support log, but the ID looked like \`D<number>\`, that is a Zotero debug report, which @retorquere cannot access. Please re-submit a BBT debug log by one of the methods below. BBT support log IDs end in \`-apse\` or \`-euc\`. Support logs that include sample references will end in \`-refs-apse\` or \`-refs-euc\`; these are the type @retorquere needs for ${Labels.needsReferences.join(' or ')} issues.

**This request is much more likely than not to apply to you, too, _even if you think it unlikely_**, and even if it does not, there's no harm in sending a debug log that turns out to be unnecessary. @retorquere will usually just end up saying "please send a debug log first". Let's just skip over the unnecesary delay this entails. Sending a debug log is very easy, depending on your situation, follow one of these procedures::

1. If your issue relates to how BBT behaves around a **specific reference(s)**, such as citekey generation or export, select at least one of the problematic reference(s), right-click it, and submit an BBT support log from that popup menu. If the problem is with export, please do include a sample of what you see exported, and what you expected to see exported for these references, either by pasting it in a comment here (if it is small) or attaching it as a \`.txt\` file (if it's large). These logs will have an ID that ends in \`-refs-apse\` or \`-refs-euc\`.

2. If the issue **does not relate to references** and is of a more general nature, generate an support log by restarting Zotero with debugging enabled (\`Help\` -> \`Debug Output Logging\` -> \`Restart with logging enabled\`), reproducing your problem, and selecting \`Send Better BibTeX debug report...\` from the help menu.

Once done, you will see a support log ID in red. Please post that support log id in an issue comment here.

Thank you!
`

const prompt = 'Support log ID:'

function state() {}

async function run(): Promise<void> {
  try {
    // https://docs.github.com/en/developers/webhooks-and-events/webhook-events-and-payloads#issue_comment
    // https://docs.github.com/en/actions/reference/events-that-trigger-workflows

    const owner = github.context.payload.repository?.owner.login || ''
    const repo = github.context.payload.repository?.name || ''
    const username = github.context.payload.sender?.login || ''

    const noclose = `Thanks for the feedback; there's no way you could have known, but @${owner} prefers to keep bugreports/enhancements open as a reminder to merge the change into a new release.`

    let isCollaborator = false
    try {
      await octokit.repos.checkCollaborator({ owner, repo, username })
      isCollaborator = true
    } catch (err) {
      isCollaborator = false
    }
    core.info('action by ' + JSON.stringify({ username, isCollaborator }))

    let labels: Label[] = []
    let body = ''
    if (github.context.eventName == 'issues') {
      const event = github.context.payload as IssuesEvent
      if (event) {
        labels = event.issue.labels || []
        body = event.issue.body
      }
    }
    else if (github.context.eventName == 'issue_comment') {
      const event = github.context.payload as IssueCommentEvent
      if (event) {
        labels = event.issue.labels || []
        body = event.comment.body
      }
    }

    const isQuestion = labels.map(label => label.name).join(',') === 'question'
    let needsSupportLog = !!labels.find(label => label.name === Labels.needsSupportLog)
    const needsReferences = false // !!labels.find(label => Labels.needsReferences.includes(label.name))
    const awaiting = !!labels.find(label => label.name === Labels.awaiting)
    const hasSupportLogId = body.match(/[A-Z0-9]{8}(-refs)?-(apse|euc)/)?.[0]
    const hasReferences = body.match(/[A-Z0-9]{8}-refs-(apse|euc)/)
    const prompted = body.includes(prompt)
    console.log({
      event: github.context.payload,
      labels,
      body,
      isQuestion,
      needsSupportLog,
      awaiting,
      hasSupportLogId,
      hasReferences,
      prompted,
    })

    if (github.context.eventName === 'issues') {
      const event = github.context.payload as IssuesEvent
      const issue_number = event.issue.number

      switch (event.action) {
        case 'opened':
          if (!isQuestion && !hasSupportLogId && !isCollaborator) {
            const reason = needsReferences ? Reasons.norefs : Reasons.nolog
            await octokit.issues.createComment({ owner, repo, issue_number, body: reason + complaint.trim() })
            await octokit.issues.addLabels({ owner, repo, issue_number, labels: [Labels.needsSupportLog] })
            needsSupportLog = true
          }
          break

        case 'edited':
          if (needsSupportLog && hasSupportLogId && !(needsReferences && !hasReferences)) {
            await octokit.issues.removeLabel({ owner, repo, issue_number, name: Labels.needsSupportLog })
            needsSupportLog = false
          }
          else if (!prompted) {
            await octokit.issues.update({ owner, repo, issue_number, body: `${event.issue.body}\n\n${prompt}` })
          }
          break

        case 'closed':
          if (!isCollaborator && !isQuestion) {
            await octokit.issues.update({ owner, repo, issue_number, state: 'open' })
            await octokit.issues.createComment({ owner, repo, issue_number, body: noclose })
          }
          else if (awaiting || needsSupportLog) {
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
    }
    else if (github.context.eventName === 'issue_comment') {
      const event = github.context.payload as IssueCommentEvent

      if (event.action === 'created') {
        if (isCollaborator && event.issue.state === 'open') {
          await octokit.issues.addLabels({ owner, repo, issue_number: event.issue.number, labels: [Labels.awaiting] })
        }
        else if (awaiting) {
          await octokit.issues.removeLabel({ owner, repo, issue_number: event.issue.number, name: Labels.awaiting })
        }
      }

      if (!isCollaborator && needsSupportLog) {
        if (hasSupportLogId && !(needsReferences && !hasReferences)) {
          await octokit.issues.removeLabel({ owner, repo, issue_number: event.issue.number, name: Labels.needsSupportLog })
          needsSupportLog = false
        }
        else if (!prompted) {
          await octokit.issues.updateComment({ owner, repo, comment_id: event.comment.id, body: event.comment.body + '\n\n' + prompt })
        }
      }
    }

    core.setOutput('needsSupportLog', needsSupportLog ? 'true' : 'false')
  } catch (err) {
    core.error(`error: ${err}\n${err.stack}`)
    core.setFailed(err.message)
  }
}

run()
