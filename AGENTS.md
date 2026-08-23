# Workspace agent preferences

- Avoid broad, repetitive, multi-pass code reviews that duplicate the same work.
- When a code review contains bounded mechanical checks, delegate those checks to a `gpt-5.6-luna` sub-agent with low reasoning effort when sub-agents are allowed.
- Keep the primary agent focused on evidence synthesis, product judgment, architecture, risk prioritization, and the final recommendation.
- Do not create multiple high-tier review agents unless the user explicitly asks for that level of parallel review.
