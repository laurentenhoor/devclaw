# DevClaw Demo 2: Advanced Workflow Scenarios

This document demonstrates advanced DevClaw workflows and use cases.

## Table of Contents

1. [Parallel Task Execution](#parallel-task-execution)
2. [Research Tasks with Architects](#research-tasks-with-architects)
3. [Multi-phase Workflow](#multi-phase-workflow)
4. [Project Configuration](#project-configuration)
5. [Best Practices](#best-practices)

## Parallel Task Execution

DevClaw supports parallel task execution across multiple issues. Workers are automatically dispatched based on available capacity and task priority.

### Example Scenario

```
Project Dashboard:
├── Active Tasks (In Progress)
│   ├── Issue #101: Database migration (DEVELOPER)
│   ├── Issue #102: UI components (DEVELOPER)
│   └── Issue #103: API endpoint (DEVELOPER)
├── Queue (Waiting to Start)
│   ├── Issue #104: Bug fix
│   └── Issue #105: Documentation
└── Hold (Waiting for Input)
    └── Issue #106: Design review
```

## Research Tasks with Architects

When facing complex architectural decisions, spawn an architect to research and propose solutions.

### Workflow

1. **Create Research Task**: Call `research_task()` with detailed context
2. **Architect Investigates**: Systematically research codebase, docs, and web resources
3. **Findings Posted**: Results appear as comments on the research issue
4. **Implementation Tasks**: Architect creates actionable tasks in Planning state
5. **Development Begins**: Operators review and move tasks to Do state

### Example Usage

```bash
# Spawn architect for session persistence strategy
research_task({
  projectSlug: "my-webapp",
  title: "Research: Session persistence strategy",
  description: "Sessions lost on restart. Current: in-memory Map. Constraints: must work with SQLite, max 50ms latency.",
  focusAreas: ["SQLite vs file-based", "migration path", "cache invalidation"],
  complexity: "complex"
})
```

## Multi-phase Workflow

DevClaw supports a complete workflow from planning through deployment:

### Workflow States

- **Planning**: Initial issue submission
- **To Do**: Approved and ready to start
- **Doing**: Work in progress (DEVELOPER, TESTER, or ARCHITECT)
- **To Review**: Ready for review (REVIEWER phase)
- **Reviewing**: Under review
- **Done**: Completed and merged

### Example: Feature Implementation

```
Issue #200: Add user authentication

Planning
  └─→ To Do (Operator approves)
       └─→ Developer picks up
            └─→ Doing (Implementation)
                 └─→ To Review (PR created)
                      └─→ Reviewer reviews
                           └─→ Reviewing (Changes requested)
                                └─→ Developer updates (back to Doing)
                                     └─→ To Review (Updated PR)
                                          └─→ Done (Approved and merged)
```

## Project Configuration

DevClaw uses a structured project configuration:

### Project Registration

```bash
project_register({
  name: "my-app",
  projectGroupId: "123456789",
  repo: "~/git/my-app",
  baseBranch: "main",
  deployBranch: "production",
  deployUrl: "https://my-app.com"
})
```

### Workflow Customization

Edit `workflow.yaml` to customize:

- **Roles**: Developer, Tester, Architect, Reviewer
- **Levels**: Junior, Medior, Senior (per role)
- **Timeouts**: How long tasks wait in each state
- **Review Policy**: Manual vs automated approval
- **Testing Phase**: Enable/disable automated testing

### Model Assignment

Assign LLM models per role and level:

```json
{
  "developer": {
    "junior": "anthropic/claude-haiku-4-5",
    "medior": "anthropic/claude-sonnet-4-5",
    "senior": "anthropic/claude-opus-4-6"
  },
  "tester": {
    "junior": "anthropic/claude-haiku-4-5",
    "medior": "anthropic/claude-sonnet-4-5"
  }
}
```

## Best Practices

### Task Management

1. **Clear Titles**: Write descriptive issue titles
   - ❌ "Bug fix"
   - ✅ "Fix: Login form validation error on empty email"

2. **Detailed Context**: Include reproduction steps, expected behavior, and constraints
   - Screenshots or logs when applicable
   - Links to related issues or docs

3. **Proper Labels**: Use workflow state labels for routing
   - Planning → To Do → Doing → To Review → Done

### Commits and PRs

1. **Conventional Commits**: Use commit message format
   ```
   feat: add user authentication (#12)
   fix: resolve login timeout issue (#45)
   docs: update API documentation (#78)
   ```

2. **Branch Naming**: Follow the pattern
   ```
   feature/<id>-<short-description>
   fix/<id>-<short-description>
   ```

3. **PR Descriptions**: Include issue reference and summary
   ```markdown
   ## Summary
   Implements user authentication system
   
   Addresses issue #12
   
   ## Changes
   - Added login endpoint
   - Added JWT token handling
   - Added session management
   ```

### Code Review

1. **Review Checklist**:
   - Code follows project standards
   - Tests pass and coverage maintained
   - No breaking changes
   - Documentation updated

2. **Feedback Quality**:
   - Be specific and constructive
   - Provide examples or suggestions
   - Respect different approaches

### Team Collaboration

1. **Worker Levels**:
   - **Junior**: Straightforward tasks, guided by issue descriptions
   - **Medior**: Complex tasks, some autonomy in design decisions
   - **Senior**: Architectural decisions, code review, mentoring

2. **Escalation**:
   - Tasks can be escalated to senior level if needed
   - Use `task_update` to change level assignment
   - Document escalation reason in comments

## Troubleshooting

### Common Issues

**Task stuck in "Doing" state**
- Check worker health: `health(projectSlug: "my-app")`
- Review worker logs for errors
- Use `task_update` to reassign if worker is stalled

**PR not auto-merging**
- Verify all checks pass
- Check review approval status
- Ensure base branch is set correctly

**Worker assignment seems off**
- Review task complexity and requirements
- Provide more context in issue description
- Consider manual level assignment

## More Information

- See `AGENTS.md` for role-specific instructions
- See `TOOLS.md` for tool usage guide
- See `HEARTBEAT.md` for system health and monitoring
