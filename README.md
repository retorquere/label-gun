# Label Gun

`label-gun` is a GitHub Action for issue triage automation.

It is built for the class of problems where maintainers want GitHub issues to behave like a lightweight workflow:

- demand specific evidence before work can continue
- move issues between `awaiting`, `in-progress`, `blocked`, and `backlog` states
- reopen issues when users close them against policy
- reopen closed issues when new user activity should resume the conversation
- synchronize issue state into a GitHub Project

The action keeps the old Better BibTeX/debug-log behavior, but the configuration is now broader than that single use case.

now with fully automatic nagging in honor of @element4l so that I can maintain some distance while people request my help but won't actually let me help.

## Usage

Use the action from a workflow that listens to issue activity:

```yaml
name: Manage issues

on:
  issues:
    types: [opened, edited, closed, reopened]
  issue_comment:
    types: [created, edited]

jobs:
  triage:
    runs-on: ubuntu-latest
    steps:
      - uses: retorquere/label-gun@main
        with:
          token: ${{ github.token }}
```

Optional inputs:

- `config`: inline YAML override for advanced or per-workflow customization
- `config-path`: repository config path, default `.github/label-gun.yml`
- `project-token`: separate token for GitHub Project updates when `${{ github.token }}` lacks access
- action input aliases such as `label-awaiting`, `label-canclose`, `log-regex`, `close-message`, and `project-status-in-progress` are available for workflow-level overrides

## Repo Config

Each repository can configure behavior in `.github/label-gun.yml`.

Example:

```yaml
assign: true

labels:
  awaiting: awaiting-user-feedback
  reopened: reopened
  canClose:
    - question
  blocked:
    - blocked
    - upstream

messages:
  closedByUser: |
    Thanks for the feedback! GitHub does not let the bot restrict who closes issues,
    so this issue was reopened to keep it visible until maintainer review.

requirements:
  - name: debug-log
    events: [issues.opened]
    actor: user
    pattern: "([A-Z0-9]{8}(-refs)?-(apse|euc))|([A-Z0-9]{8}-[^-]+)"
    addLabels:
      - awaiting-user-feedback
      - needs-debug-log
    removeLabels:
      - needs-debug-log
    message: |
      Hello @{{username}},

      Please include a debug log so the issue can be diagnosed.
    status: awaiting

project:
  url: https://github.com/users/retorquere/projects/5
  fields:
    status: Status
    endDate: End date
    users: Users
  status:
    blocked: Blocked
    awaiting: Awaiting user input
    inProgress: In progress
    new: To triage
    backlog: Backlog
```

## Configuration Model

The config is intentionally scoped to issue triage, not to one repo-specific script.

### Labels

- `labels.awaiting`: label used when the issue is waiting on a user
- `labels.active`: optional labels that opt issues into management
- `labels.exempt`: optional labels that opt issues out
- `labels.reopened`: label applied when a closed issue is reopened by new user activity
- `labels.blocked`: labels that force blocked status
- `labels.canClose`: labels that allow a user to close an issue without automatic reopen

### Requirements

`requirements` is the general mechanism for demanding evidence or structured follow-up from users.

Each requirement can specify:

- `events`: which issue events should enforce the requirement
- `actor`: whether it applies to `user`, `owner`, or `any`
- `pattern`: regex that counts as satisfying the requirement
- `addLabels`: labels to apply when the requirement is missing
- `removeLabels`: labels to remove when the requirement is present
- `message`: optional comment posted when the requirement is missing
- `status`: state to push into the connected project

This makes the action usable for debug logs, reproduction steps, screenshots, sample data, environment details, or any other recurring evidence request.

### Legacy Aliases

For migration from the old action config, these aliases are still supported:

- `log.regex`
- `log.label`
- `log.message`
- `logs.*`
- `close.message`

Those YAML keys are translated internally into the more general `requirements` and `messages` model. Action input ids use hyphenated names because GitHub Action metadata does not validate dotted ids.
