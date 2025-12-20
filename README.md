# Merge Bot

GitHub Action that automatically merges pull requests forward through the release branch chain and maintains `branch-here-*` safety branches.

## Overview

This action combines two previously separate actions:
- `gh-action-automerge` - Merges PRs forward through branches
- `gh-action-branch-maintainer` - Updates branch-here pointers

## Status

🚧 **Work in Progress** - Consolidating multiple repos into one.

## Structure

```
merge-bot/
├── src/
│   ├── automerge.js           # Phase 1: Merge forward logic
│   ├── maintain-branches.js   # Phase 2: Branch-here maintenance
│   ├── issue-resolver.js      # Issue creation for conflicts
│   ├── find-clean-merge-ref.js # Find safe merge points
│   └── constants.js           # Shared constants
├── test/                      # Test files
└── dist/                      # Bundled output (generated)
```

## Next Steps

1. Create unified entry point (`src/merge-bot.js`)
2. Set up package.json with dependencies
3. Create action.yml
4. Bundle with ncc
5. Update Spider Impact workflow to use this action

