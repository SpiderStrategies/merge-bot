# Spider Merge Bot

The Spider Merge Bot automatically merges changes forward across release branches
(e.g., release-5.8.0 → main). When conflicts occur, it creates issues for
developers to resolve.

## For Detailed Documentation

See the internal Google Doc "Spider Merge Bot" (referenced in issue #42921) which
includes:
- User instructions for branching and handling conflicts
- Screenshots and examples
- Manual fix procedures
- Configuration and setup

## Key Concepts for AI

### branch-here Branches
**Critical**: Developers must ALWAYS branch from `branch-here-{version}` branches,
NEVER from `release-{version}` branches.

**Why**: branch-here branches only include commits known to merge cleanly forward.
This prevents developers from inheriting unrelated merge conflicts.

**Example**:
- ✅ Branch from: `branch-here-release-5.8.0`
- ❌ Never branch from: `release-5.8.0`

### Merge-Conflicts Branch Naming

**Format**: `merge-conflicts-{issueNumber}-{sourceBranch}-to-{targetBranch}`

**Examples**:
- `merge-conflicts-68586-release-5-8-0-to-main`
- `merge-conflicts-68590-release-5-7-2-to-release-5-8-0`

This encoding allows the branch maintainer to filter conflicts and only consider
those relevant to the specific merge path.

## GitHub Actions

The merge bot consists of two actions:

1. **gh-action-automerge**: Merges PRs forward, creates conflict issues/branches
   - Creates encoded merge-conflicts branch names
   - See: https://github.com/SpiderStrategies/gh-action-automerge

2. **gh-action-branch-maintainer**: Maintains branch-here branches
   - Filters merge-conflicts branches to only relevant ones
   - Advances branch-here to latest safe commit
   - See: https://github.com/SpiderStrategies/gh-action-branch-maintainer

## Configuration

- Config file: `.spider-merge-bot-config.json` (in default branch only)
- Defines release branches and merge operations
- Updated when new release branches are created

## Making and releasing changes
- See **Release Process** at https://github.com/SpiderStrategies/gh-action-branch-maintainer/blob/master/README.md#release-process

## Related Issues

- Original implementation: #42921
- Improved branch-here updates to avoid conflicts and keep branch-here- branches up to date more often: #68703, #63954
