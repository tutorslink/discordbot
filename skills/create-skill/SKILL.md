---
name: create-skill
scope: workspace
summary: "Extract a reusable agent skill from a multi-step conversation or workflow and save it as a SKILL.md for the agent-customization system."
---

## When to use

- Use when a conversation reveals a repeatable multi-step workflow, decision logic, or checklist worth reusing.
- Use when you want a workspace-scoped skill other collaborators can invoke.

## Goal

Produce a concise SKILL.md that documents:
- the step-by-step process
- decision points and branching rules
- quality checks and completion criteria
- example prompts and usage notes

## Procedure

1. Read the conversation and extract the step-by-step process. Keep steps actionable and numbered.
2. Identify and document decision points: for each branch, record the condition and the resulting action.
3. Draft quality criteria: what success looks like (tests, outputs, side effects). Add completion checks.
4. Create example prompts that show how to invoke the skill in normal and edge cases.
5. Save the SKILL.md in `skills/create-skill/SKILL.md` (workspace scope).
6. Ask clarifying questions for any ambiguous or environment-specific steps.

## Decision logic template

- Condition: (short predicate)
  - Then: (action / next step)
  - Else: (alternative action)

## Quality criteria (examples)

- Output file created in the right path.
- Steps are unambiguous and executable without extra context.
- Prompts cover a normal case and one edge case.
- Any required files/permissions are listed.

## Example prompts

- "Extract a deployment workflow from this conversation and save a SKILL.md." 
- "Turn our code-review checklist into a SKILL.md with prompts and acceptance criteria."

## Clarifying questions to ask (when needed)

- Should this be workspace-scoped or personal? (workspace/personal)
- Target audience: reviewers, maintainers, or end-users?
- Should the skill create files or only output text for a human to save?

## Iteration guidance

- After saving, run a quick validation: ensure the path exists and the file renders cleanly in the editor.
- If parts are ambiguous, record them under "Clarifying questions" and mark the skill draft as needing review.

## Output produced

- A saved file at `skills/create-skill/SKILL.md` containing the documented workflow, decision logic, prompts, and checks.
