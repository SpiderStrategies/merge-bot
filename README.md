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

**Why**: branch-here branches only include commits that have successfully merged
**all the way to main**. This prevents developers from inheriting merge conflicts
from anywhere in the release chain.

**Example**:
- ✅ Branch from: `branch-here-release-5.8.0`
- ❌ Never branch from: `release-5.8.0`

### Merge-Conflicts Branches

**Purpose**: These branches serve as **markers in Git history** to track which
commits have unresolved merge conflicts. They prevent branch-here pointers from
advancing past conflicted commits, ensuring developers never inherit someone
else's merge conflicts.

**Format**: `merge-conflicts-{issueNumber}-{sourceBranch}-to-{targetBranch}`

**Examples**:
- `merge-conflicts-68586-release-5-8-0-to-main`
- `merge-conflicts-68590-release-5-7-2-to-release-5-8-0`

**How They Work**:
1. When automerge encounters conflicts, it creates a merge-conflicts branch
   pointing to the problematic commit
2. branch-here pointers will NOT advance past commits with merge-conflicts
   branches
3. When a developer resolves the conflict and merges their PR, the marker branch
   is automatically deleted
4. Once deleted, branch-here can advance past that commit on the next maintenance
   run

**Important**: If you see stale merge-conflicts branches that weren't cleaned up,
they will preventing branch-here from advancing and must be deleted manually.

## GitHub Action

The merge bot is a single consolidated GitHub Action that runs two phases automatically:

**Phase 1: Auto-merge**
- Merges PRs forward through the release branch chain
- Creates conflict issues and merge-conflicts branches when conflicts occur
- Uses encoded branch names for conflict tracking

**Phase 2: Branch Maintenance**
- Updates branch-here pointers to the latest commit that reached main
- Checks for merge-conflicts at ALL points in the chain (not just the next hop)
- Only runs when commits have successfully merged all the way to main
- Ensures developers never inherit conflicts from earlier in the chain

**Note**: Previously split into `gh-action-automerge` and `gh-action-branch-maintainer`
(now archived). Consolidated December 2025.

## Usage

The action is used in Spider Impact's workflow:

```yaml
- uses: SpiderStrategies/private-action-loader@master
  with:
    pal-repo-token: ${{ secrets.SPIDER_PAT }}
    pal-repo-name: SpiderStrategies/merge-bot@main
    config-file: config.json
    repo-token: ${{ secrets.SPIDER_PAT }}
```

It triggers on PR close and automatically handles both merge-forward and branch-here maintenance.

## Repository Structure

```
merge-bot/
├── src/
│   ├── merge-bot.js              # Entry point - orchestrates both phases
│   ├── automerge.js              # Phase 1: Merge forward logic
│   ├── maintain-branches.js      # Phase 2: Branch-here maintenance
│   ├── issue-resolver.js         # Creates conflict resolution issues
│   ├── find-clean-merge-ref.js   # Finds safe merge points
│   └── constants.js              # Shared constants
├── test/                         # Test files
├── dist/index.js                 # Bundled output (built with ncc)
└── action.yml                    # GitHub Action definition
```

## Configuration

- Config file: `.spider-merge-bot-config.json` (in default branch of Spider Impact repo)
- Defines release branches and merge operations
- Updated when new release branches are created

## Making Changes

To update the merge bot:

1. Make changes to the code in `src/`
2. Run tests: `npm test`
3. Commit your changes to `src/` (no need to build or commit `dist/`)
4. Push to the `main` branch (or create a PR)
5. A GitHub Action will automatically:
   - Run tests again
   - Build `dist/index.js` using `npm run build`
   - Commit the updated `dist/` folder
6. Changes take effect immediately - Spider Impact references `@main` so it
   always uses the latest version

**Note**: The `build-dist.yml` workflow handles building and committing `dist/`
automatically whenever changes to `src/` land on main. You don't need to
manually run `npm run build` or commit `dist/index.js`, though doing so is
harmless

## Related Issues

- Original implementation: #42921
- Improved branch-here updates to avoid conflicts and keep branch-here- branches up to date more often: #68703, #63954

## Support

This repository is made public for convenience but is not officially supported for external use. It is maintained by Spider Strategies for internal workflows. Use at your own risk.
