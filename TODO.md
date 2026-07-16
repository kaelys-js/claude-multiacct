~~[Original question block struck 2026-07-10 — answered by [`ADOPTING.md`](./ADOPTING.md). TRP migration (ROADMAP Item 20) is the concrete worked example.]~~

- IaC for Repo
  - Repo Description
  - Website
  - Topics
  - Releases/Deployments/Packages
  - Default Branch
  - Enable release immutability
  - Features
    - Wikis
    - Issues
      - Issue Permissions
    - Sponsorships
    - Preserve this repository
    - Discussions
    - Projects
    - Pull Requests
      - Pull request permissions
  - Pull Requests
    - Allow merge commits
    - Allow squash merging
    - Allow rebase merging
    - Always suggest updating pull request branches
    - Allow auto-merge
    - Automatically delete head branches
  - Commits
    - Require contributors to sign off on web-based commits
    - Allow comments on individual commits
  - Include Git LFS objects in archives
  - Limit how many branches and tags can be updated in a single push
  - Auto-close issues with merged linked pull requests
  - Repo Visibility
  - Code Review Limits
    - Limit to users explicitly granted read or higher access
  - Interaction Limits
    - Limit to existing users
    - Limit to prior contributors
    - Limit to repository collaborators
    - Limit open pull requests from users without write access Loading
  - Advanced Security
    - Private vulnerability reporting
    - Dependency graph
    -

- Protection for all of the root repo files (CODEOWNERS + governance system)
- package.json enforcement that all of the fields are present in every package.json (sub-packages may need to differ from root in some fields?)
- do we need validation that turbo tasks pointing to package.json scripts exist?

- script or api to post to ClickUp and create proper tickets!

- bring in all the other languages/root files from stardust

- markdown docs (README, SECURITY, CODE_OF_CONDUCT, CONTRIBUTING, VERSION)
- review heron CI / resist.js / stardust
  - .vscode/\*
  - DCO Sign Off
  - all-contributorsrc
  - .actrc
  - PII
  - pnpm audit
  - can mise force use of whatever package manager is used and deny all others?
  - can auto-activate mise when running any command from anywhere inside the workspace path

- ## horrible typescript quality (doc/valibot/tests)

- @ttt/foundations
  - Review Felipes Engineering Standards To Automate
  - Migration
  - Opt-In
  - Templates
    - PRD
    - PDR
    - ADR
    - SPEC
    - tasks.yml
    - .github (PR/Issue Templates)
    - ClickUp <-> GH
    - PR Reviews
    - Boxed Model For PRD/PDR/ADR/SPEC/etc summarization/indexing/etc
