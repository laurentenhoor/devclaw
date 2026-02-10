# QA Workflow

## Overview

Quality Assurance (QA) in DevClaw follows a structured workflow that ensures every review is documented and traceable.

## Required Steps

### 1. Review the Code

- Pull latest from the base branch
- Run tests and linting
- Verify changes address issue requirements
- Check for regressions in related functionality

### 2. Document Your Review (REQUIRED)

Before completing your task, you MUST create a review comment using `task_comment`:

```javascript
task_comment({
  projectGroupId: "<group-id>",
  issueId: <issue-number>,
  body: "## QA Review\n\n**Tested:**\n- [List what you tested]\n\n**Results:**\n- [Pass/fail details]\n\n**Environment:**\n- [Test environment details]",
  authorRole: "qa"
})
```

### 3. Complete the Task

After posting your comment, call `task_complete`:

```javascript
task_complete({
  role: "qa",
  projectGroupId: "<group-id>",
  result: "pass",  // or "fail", "refine", "blocked"
  summary: "Brief summary of review outcome"
})
```

## Why Comments Are Required

1. **Audit Trail**: Every review decision is documented
2. **Knowledge Sharing**: Future reviewers understand what was tested
3. **Quality Metrics**: Enables tracking of test coverage
4. **Debugging**: When issues arise later, we know what was checked
5. **Compliance**: Some projects require documented QA evidence

## Comment Template

### For Passing Reviews

```markdown
## QA Review

**Tested:**
- Feature A: [specific test cases]
- Feature B: [specific test cases]
- Edge cases: [list]

**Results:** All tests passed. No regressions found.

**Environment:** 
- Browser/Platform: [details]
- Version: [details]
- Test data: [if relevant]

**Notes:** [Optional observations or recommendations]
```

### For Failing Reviews

```markdown
## QA Review - Issues Found

**Tested:**
- [What you tested]

**Issues Found:**
1. [Issue description with steps to reproduce]
2. [Issue description with steps to reproduce]
3. [Issue description with expected vs actual behavior]

**Environment:**
- [Test environment details]

**Severity:** [Critical/Major/Minor]
```

## Enforcement

As of [current date], QA workers are instructed via role templates to:
- Always call `task_comment` BEFORE `task_complete`
- Include specific details about what was tested
- Document results, environment, and any notes

Role templates affected:
- `roles/default/qa.md`
- `roles/devclaw/qa.md`
- All project-specific QA templates should follow this pattern

## Best Practices

1. **Be Specific**: Don't just say "tested the feature" - list what you tested
2. **Include Environment**: Version numbers, browser, OS can matter
3. **Document Edge Cases**: If you tested special scenarios, note them
4. **Use Screenshots**: For UI issues, screenshots help (link in comment)
5. **Reference Requirements**: Link back to acceptance criteria from the issue

## Related

- Issue #103: Enforce QA comment on every review (pass or fail)
- Tool: `task_comment` - Add comments to issues
- Tool: `task_complete` - Complete QA tasks
