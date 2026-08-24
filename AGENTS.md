# Workspace agent preferences

- Avoid broad, repetitive, multi-pass code reviews that duplicate the same work.
- When a code review contains bounded mechanical checks, delegate those checks to a `gpt-5.6-luna` sub-agent with low reasoning effort when sub-agents are allowed.
- Keep the primary agent focused on evidence synthesis, product judgment, architecture, risk prioritization, and the final recommendation.
- Do not create multiple high-tier review agents unless the user explicitly asks for that level of parallel review.

## Browser extension verification

- Treat `extension/` as the canonical runtime and release source. `extension-wxt/` owns the React surfaces only until the full runtime is deliberately migrated; Playwright must load `extension/`.
- The canonical workflow is documented in `docs/automated-browser-testing.md`. Use `pnpm e2e:target --url <reported-url> --scenario <scenario>` for reproduction, `pnpm e2e:real` for the public-site matrix, `pnpm e2e:browser` for the complete browser suite, and `pnpm e2e:release` for release verification.
- For reader extraction, forum navigation, injection, and playback bugs, use the Playwright real-site runner against the reported URL before asking the user to verify anything manually.
- Use the deterministic Service Worker TTS probe for continuation, cancellation, and stale-session assertions. Do not depend on audible speaker output as the only evidence.
- Synthetic pages are useful for deterministic failure injection, but they are never sufficient evidence for real-site compatibility. Pair them with at least one relevant public site.
- A browser-facing fix is not complete until its targeted E2E scenario passes. Before a release handoff, run the real-site matrix and keep failure artifacts under ignored temporary directories.
- Classify third-party page warnings separately from extension failures. Cloudflare analytics blocks, deprecations, lazy-image notices, and forced-reflow warnings must not be reported as Flowloud errors without an extension-owned stack or failed assertion.
- Never attach Codex automation to the user's default Chrome or Edge profile. Use Playwright Chromium or the dedicated ignored development profile.
- Only request user involvement for an unavoidable CAPTCHA or one-time login to private content; do not ask the user to reload the extension, copy F12 output, or perform routine playback regression testing.
- Keep traces, screenshots, browser profiles, and captured page content in ignored temporary directories. Commit only intentionally generated, sanitized audit evidence.
