/**
 * Neutralize CI variables before any module (ink first) is imported.
 * Ink 5 depends on is-in-ci, and a truthy CI/GITHUB_ACTIONS switches its
 * output strategy from cursor-move repaints to append-only frames, which
 * breaks the TTY suites' frame assertions. GitHub Actions always sets
 * these variables; deleting them here makes every runner behave like a
 * local interactive terminal.
 */
delete process.env.CI
delete process.env.GITHUB_ACTIONS
delete process.env.CI_NAME
delete process.env.TEAMCITY_VERSION
