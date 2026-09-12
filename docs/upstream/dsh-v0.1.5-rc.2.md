# DSH upstream audit: v0.1.5-rc.1 → v0.1.5-rc.2

| Ref | Commit | Note |
| --- | --- | --- |
| `dsh-v0.1.5-rc.1` | `183f08e9c6dde7e36cd2318eaee70b0da08fb35e` | Previous line |
| `dsh-v0.1.5-rc.2` | `fb2c4b9e698e30edb738bca4cf0618587db7d203` | Target release |

## Scope

- 334 files changed, 1050 insertions / 1050 deletions: the release commit bumps every package version from `0.1.5-rc.1` to `0.1.5-rc.2`; trilingual READMEs follow.
- One backport commit (`060323d8e2 feat(web): backport feedback and file refinements to 0.1.5`) carries the whole functional delta: the web feedback dialog with categories, shared file-type icons, and deliverables refinements, all under `packages/client/*` and `apps/web`.
- The only non-web `src/` change is a one-line JSDoc wording fix in `packages/feedback/message-feedback/src/types.ts`; this bundle does not consume that package.
- Cordis requirements are unchanged (`@deepseek-ai/cordis` `^4.0.2`, `cordis-plugin-loader` `^1.0.3`).

## Conclusion

Alignment is a pure version-line bump for the terminal: every `@deepseek-ai/dsh-*` dependency and peer moves to `0.1.5-rc.2`, the lockfile resolves the new line, and no source adaptation is required. Nothing in rc.2 is portable to the TUI surface.
