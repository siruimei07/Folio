# Skill routing

Reference for agents: which skill to use for which job. Policy (what is mandatory, the
feature pipeline) lives in `CLAUDE.md` §4.

Only the skills listed here are in use. Do not install or invoke other skills or plugins
without Sirui's approval.

## Product and UX research

| Skill | Use it for |
|---|---|
| `design:user-research` | Interview guides, usability-test plans, survey design, mapping multi-step flows (import → organise → find → share) |
| `design:research-synthesis` | Turning feedback, test notes and issues into problems and prioritised improvements |

## UI visual design

| Skill / tool | Use it for |
|---|---|
| `design:design-system` | Colour, type, spacing and component rules; audits naming consistency and hard-coded values |
| `design:design-critique` | Reviewing mockups or screenshots for hierarchy, consistency, usability and template-looking ("generic") design |
| `design:design-handoff` | Turning a design into a dev spec: layout, design tokens, component states, interactions, motion parameters. Output feeds Claude Code directly |
| `frontend-design` | Writing components with deliberate typography and colour, avoiding template look |
| `dataviz` | Any chart, statistics panel, stat tile or dashboard inside the app |
| Cowork **Design** canvas | Mockups and clickable prototypes (Cowork only) |
| Cowork **Design System** artifact | Browsable library of colours, fonts, components (Cowork only) |

There is **no Animations artifact type** on this account. Motion is specified in text in the
handoff spec (durations, easings, reduced-motion fallback) and implemented from tokens.

## Interaction, UX copy and accessibility

| Skill | Use it for |
|---|---|
| `design:ux-copy` | Buttons, error messages, empty states, onboarding text |
| `design:accessibility-review` | Contrast, keyboard navigation, focus order, hit-target size, `prefers-reduced-motion` fallbacks. Required before a UI lane is marked done |

## Engineering (UI, privileged process, data layer, IPC)

| Skill | Use it for |
|---|---|
| `engineering:system-design` | **First skill before any backend work**: data model, IPC interface, module split; UI-side module boundaries and data flow |
| `engineering:architecture` | ADRs: application stack, SQLite vs JSON files, ORM or query builder, state management, component layering, directory structure |
| `engineering:testing-strategy` | Test plans: unit, component, e2e split; data layer and IPC |
| `engineering:debug` | Structured debugging: reproduce → isolate → diagnose → fix |
| `engineering:code-review` / `/code-review` | Reviewing changes: injection risk, missed edge cases, swallowed errors and silent failures, type design |
| `/security-review` | Security pass on changes to the privileged layer or IPC surface |
| `/simplify` | After a feature works: remove duplication, simplify, keep behaviour |
| `engineering:documentation` | READMEs, runbooks, developer docs |
| `engineering:deploy-checklist` | Pre-release: installers, auto-update, database schema migrations |
| `engineering:tech-debt` | Deciding what to refactor first once the codebase grows |
| `data:sql-queries` | Only for ad-hoc analysis or reviewing a complex SQLite query. It is analysis-oriented; do not rely on it for in-app query code |

## Version control, running and testing

| Skill / tool | Use it for |
|---|---|
| `gitbutler` | Command syntax for every `but` operation (policy is in `CLAUDE.md` §7) |
| `run` | Launching the app to see a change working |
| Built-in browser pane | Opening the UI, clicking through flows, screenshots |
