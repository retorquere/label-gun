import * as core from '@actions/core'
import * as github from '@actions/github'
import * as fs from 'fs'

const complaint = `
It looks like you did not upload an support log. The support log is important; it gives @retorquere your current BBT settings and a copy of the problematic reference as a test case so he can best replicate your problem. Without it, @retorquere is effectively blind. Support logs are useful for both analysis and for enhancement requests; in the case of export enhancements, @retorquere need the copy of the references you have in mind.

If you did try to submit a support log, but the ID looked like `D<number>`, that is a Zotero debug report, which @retorquere cannot access. Please re-submit a BBT debug log by one of the methods below. BBT support log IDs end in `-apse` or `-euc`.

**This request is much more likely than not to apply to you, too, _even if you think it unlikely_**, and even if it does not, there's no harm in sending a debug log that turns out to be unnecessary. @retorquere will usually just end up saying "please send a debug log first". Let's just skip over the unnecesary delay this entails. Sending a debug log is very easy, depending on your situation, follow one of these procedures::

1. If your issue relates to how BBT behaves around a **specific reference(s)**, such as citekey generation or export, select at least one of the problematic reference(s), right-click it, and submit an BBT support log from that popup menu. If the problem is with export, please do include a sample of what you see exported, and what you expected to see exported for these references, either by pasting it in a comment here (if it is small) or attaching it as a `.txt` file (if it's large).

2. If the issue **does not relate to references** and is of a more general nature, generate an support log by restarting Zotero with debugging enabled (`Help` -> `Debug Output Logging` -> `Restart with logging enabled`), reproducing your problem, and selecting `Send Better BibTeX debug report...` from the help menu.

Once done, you will see a support log ID in red. Please post that support log id in an issue comment here.

Thank you!
`

async function run(): Promise<void> {
  try {
    // https://docs.github.com/en/developers/webhooks-and-events/webhook-events-and-payloads#issue_comment
    // https://docs.github.com/en/actions/reference/events-that-trigger-workflows
    const event = JSON.parse(await fs.promises.readFile(process.env.GITHUB_EVENT_PATH, 'utf-8'))
    const owner = event.repository.owner.login
    const repo = event.repository.name
    const username = event.sender.login

    const isCollaborator = await github.repos.checkCollaborator({ owner, repo, username })
    const isQuestion = event.issue?.labels.map(label => label.name).join(',') === 'question'
    const waiting = 'awaiting-user-feedback'
    const isWaiting = event.issue?.labels.find(label => label.name === waiting)
    const needsSupportLog = 'needs-support-log'
    let supportLogRequested = event.issue?.labels.find(label => label.name === needsSupportLog)
    const prompt = 'Support ID:'

    const labels = []

    switch ([process.env.GITHUB_EVENT_NAME, event.action].filter(n => n).join('.')) {
      case 'issues.closed':
        if (!isCollaborator && !isQuestion) {
          await github.issues.update({ owner, repo, issue_number: event.issue.number, state: 'open' })
          await github.issues.createComment( { owner, repo, issue_number: event.issue.number, '@retorquere prefers to keep bugreports/enhancements open until the change is merged into a new release.' })
        }
        else if (event.issue?.labels.find(label => label.name === waiting || label.name === needsSupportLog)) {
          await github.issues.setLabels({ owner, repo, issue_number: event.issue.number, labels: event.issue.labels.filter(label => label.name !== waiting && label.name !== needsSupportLog))
          supportLogRequested = false
        }
        break

      case 'issues.opened':
        if (!isQuestion && !event.issue.body.match(/[A-Z0-9]{8}-(apse|euc)/) ) {
          await complain()
          await github.issues.createComment({ owner, repo, issue_number: event.issue.number, body: complaint })
          await github.issues.addLabels({ owner, repo, issue_number: event.issue.number, labels: needsSupportLog })
          supportLogRequested = true
        }
        break

      case 'issues.edited':
        if ( supportLogRequested && event.issue.body.match(/[A-Z0-9]{8}-(apse|euc)/) ) {
          await github.issues.removeLabel({ owner, repo, issue_number: event.issue.number, name: needsSupportLog })
          needsSupportLog = false
        }
        else if ( !event.issue.body.includes(prompt) ) {
          await github.issues.update({ owner, repo, issue_number: event.issue.number, body: event.issue.body + '\n\n' + prompt })
        }
        break

      case 'issue_comment.created':
      case 'issue_comment.edited':
        if (event.action === 'created') {
          if (isCollaborator) {
            await github.issues.addLabels({ owner, repo, issue_number: event.issue.number, labels: waiting })
          } else {
            await github.issues.removeLabel({ owner, repo, issue_number: event.issue.number, name: waiting })
          }
        }

        if (supportLogRequested) {
          if (event.comment.body.match(/[A-Z0-9]{8}-(apse|euc)/)
            await github.issues.removeLabel({ owner, repo, issue_number: event.issue.number, name: needsSupportLog })
            supportLogRequested = false
          }
          else if (!event.comment.body.includes(prompt) ) {
            await github.issues.updateComment({ owner, repo, comment_id: event.comment.id, body: event.comment.body + '\n\n' + prompt })
          }
        }
        break
    }

    // core.debug(`Waiting ${ms} milliseconds ...`) // debug is only output if you set the secret `ACTIONS_RUNNER_DEBUG` to true

    core.setOutput('needsSupportLog', supportLogRequested ? 'true' : 'false')
  } catch (error) {
    core.setFailed(error.message)
  }
}

run()
