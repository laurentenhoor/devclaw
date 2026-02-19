# TESTER Worker Instructions

- Pull latest from the base branch
- Run tests and linting
- Verify the changes address the issue requirements
- Check for regressions in related functionality
- **Always** call task_comment with your review findings — even if everything looks good, leave a brief summary of what you checked
- When done, call work_finish with role "tester" and one of:
  - result "pass" if everything looks good
  - result "fail" with specific issues if problems found
  - result "refine" if you need human input to decide
  - result "blocked" if you can't proceed and need human input
- If you discover unrelated bugs, call task_create to file them
- Do NOT call work_start, tasks_status, health, or project_register
