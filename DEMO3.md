# DevClaw Demo 3: Advanced Workflows and Customization

Welcome to the third part of the DevClaw demo series! This guide covers **advanced workflows**, **custom configurations**, and **production-grade setups**.

## Overview

After mastering the basics in DEMO and DEMO2, you're ready to:

- **Customize worker behavior** via prompts and model overrides
- **Set up multi-project pipelines** with shared workers
- **Implement custom testing strategies** and CI/CD integration
- **Monitor and debug** worker performance
- **Scale deployments** across teams

---

## 1. Custom Worker Prompts

DevClaw workers can be customized at three levels:

### Workspace-level (Default)
Applies to all projects in the workspace:

```
devclaw/prompts/
├── developer.system.md
├── tester.system.md
├── reviewer.system.md
└── architect.system.md
```

### Project-level (Override)
Project-specific customization:

```
projects/my-webapp/prompts/
├── developer.system.md
├── tester.system.md
└── reviewer.system.md
```

### Model-level (Config)
Override models for specific roles and levels in `workflow.yaml`:

```yaml
models:
  developer:
    junior: anthropic/claude-haiku-4-5
    medior: anthropic/claude-sonnet-4-5
    senior: anthropic/claude-opus-4-6
  tester:
    junior: anthropic/claude-haiku-4-5
    senior: anthropic/claude-sonnet-4-5
```

---

## 2. Multi-Project Setup

Register multiple projects with shared workers:

```bash
devclaw project register \
  --name my-api \
  --repo ~/git/my-api \
  --base-branch main \
  --group-id <telegram-group-id>

devclaw project register \
  --name my-web \
  --repo ~/git/my-web \
  --base-branch main \
  --group-id <telegram-group-id>
```

Workers will pick tasks from both projects based on availability and priority.

---

## 3. Custom Testing Strategies

### Enable Testing Phase

In `workflow.yaml`:

```yaml
phases:
  test:
    enabled: true
    timeout: 600
    roles:
      - role: tester
        levels:
          - junior
          - medior
```

### Run Custom Test Scripts

Add test commands to your project:

```bash
# In your repo
npm test          # Unit tests
npm run e2e       # Integration tests
npm run lint      # Code quality
```

DevClaw will run these automatically before marking tasks as complete.

---

## 4. Worker Monitoring and Debugging

### Health Check

```bash
devclaw health
```

Shows:
- Active workers
- Stale sessions
- Orphaned issues
- Worker performance metrics

### Debug Logs

```bash
devclaw logs --project my-webapp --limit 100
```

View worker activity, decisions, and errors.

### Manual Intervention

Override worker assignments:

```bash
devclaw task update --issue 42 --level senior --reason "Needs human review"
```

---

## 5. CI/CD Integration

### GitHub Actions Example

```yaml
name: DevClaw Workflow

on:
  issues:
    types: [opened, labeled]

jobs:
  devclaw:
    runs-on: ubuntu-latest
    steps:
      - uses: laurentenhoor/devclaw-action@v1
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          project-slug: my-webapp
```

### GitLab CI Example

```yaml
include:
  - remote: https://gitlab.com/laurentenhoor/devclaw-ci/templates.yml

devclaw:
  stage: dev
  variables:
    PROJECT_SLUG: my-webapp
    DEVCLAW_TOKEN: $CI_JOB_TOKEN
```

---

## 6. Best Practices

### Issue Triage
- Use labels to categorize work (bug, feature, refactor)
- Add context in descriptions (links, screenshots, logs)
- Write clear acceptance criteria

### Worker Feedback
- Review worker output regularly
- Provide feedback in comments
- Escalate edge cases to senior workers

### Workflow Tuning
- Monitor metrics (cycle time, worker success rate)
- Adjust timeouts for your team's pace
- Customize prompts based on common issues

### Security
- Use branch protection rules
- Require code review before merge
- Audit worker actions via commit history
- Rotate authentication tokens regularly

---

## 7. Troubleshooting

### Workers Not Picking Up Tasks
1. Check `devclaw health` for blocked workers
2. Verify issue labels match workflow states
3. Ensure GitHub/GitLab token has write access

### Test Failures
1. Review test output in worker logs
2. Check test environment setup
3. Escalate to manual investigation if needed

### Slow Performance
1. Profile worker decision time via logs
2. Consider splitting large tasks
3. Adjust concurrency in `workflow.yaml`

---

## 8. Next Steps

You're now equipped to:

- Deploy DevClaw in production
- Manage multiple projects and teams
- Customize workflows for your needs
- Monitor and optimize worker performance

For more details, see:
- [README.md](./README.md) — Full reference
- [AGENTS.md](./AGENTS.md) — Worker role descriptions
- [devclaw/projects.json](./devclaw/projects.json) — Project configuration

Happy automating! 🚀
