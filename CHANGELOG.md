# Changelog

All notable user-visible changes are recorded here. This project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Version, build number and commit hash are derived from Git at build time
rather than maintained by hand here (see `DESIGN.md` section 34).

## [Unreleased]

### Added

- Initial project scaffold: npm-workspaces TypeScript monorepo with a shared
  core package, a Node server and a Vite React PWA.
- Core domain logic: Europe/London time handling including 46 and 50-period
  daylight-saving days, Octopus price normalisation, the alert rules engine,
  the cheapest continuous window calculator, and notification text with
  idempotency keys.
- Project specification (`DESIGN.md`) and agent coordination files
  (`CLAUDE.md`, `AGENTS.md`, `AI_HANDOFF.md`).
