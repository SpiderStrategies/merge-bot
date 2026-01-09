# Spider Merge Bot

The Spider Merge Bot automatically merges changes forward across release branches
(e.g., release-5.8.0 → main). When conflicts occur, it creates issues for
developers to resolve.

This repository is made public for convenience but is not officially supported
for external use. It is maintained by Spider Strategies for internal workflows.

## Documentation

For detailed documentation, see [`.cursor/rules/global.mdc`](.cursor/rules/global.mdc) which includes:

- Key concepts (branch-here, merge-forward, merge-conflicts branches)
- Design rationale and alternatives considered
- Developer conflict resolution workflow
- Configuration and usage

This file is automatically available to Cursor AI for context.

## Quick Reference

**Developers**: Always branch from `branch-here-{version}`, never from `release-{version}`.

**Making changes**: Edit files in `src/`, run `npm test`, push to main. The `dist/` folder is built automatically.

## Manual Recovery

If the merge bot breaks or branches get out of sync, use `manual-merge.sh` to reset everything to a pristine state. Run it from the Spider Impact repo root:

```bash
~/git/merge-bot/manual-merge.sh
```

The script merges all release branches forward, updates branch-here pointers, and cleans up stale merge-forward/merge-conflicts branches and issues. It's idempotent—if a conflict occurs, resolve it, commit, and re-run.

## Related Issues

- Original implementation: #42921
- Conflict isolation with merge-forward branches: #3

## Testing

Testing the merge bot requires a real repository with multiple release branches. At Spider Strategies, we test against Spider Impact which has branches like `release-5.7.0`, `release-5.8.0`, and `main`.

### Dedicated Test File

To test merge scenarios in a controlled way, use a dedicated test file that exists solely for merge bot testing. At Spider Strategies, we use `merge-bot-test.txt` in the repository root.

The file should have mostly shared content across branches, with a small section that differs—similar to how real code diverges between releases:

```
This is a test file for the Spider Merge Bot.
It exists to allow controlled testing of merge scenarios.

Do not delete this file.

Current branch: release-5.8.0
```

The "Current branch" line should differ in each branch, providing a reliable way to create conflicts when needed. To test a clean merge, add new lines. To test a conflict, modify the branch-specific line.

If something goes wrong during testing, you may need to manually delete leftover `merge-forward-pr-*` or `merge-conflicts-*` branches.
