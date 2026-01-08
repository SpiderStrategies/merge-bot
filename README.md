# Spider Merge Bot

The Spider Merge Bot automatically merges changes forward across release branches
(e.g., release-5.8.0 → main). When conflicts occur, it creates issues for
developers to resolve.

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

## Related Issues

- Original implementation: #42921
- Conflict isolation with merge-forward branches: #3

## Support

This repository is made public for convenience but is not officially supported for external use. It is maintained by Spider Strategies for internal workflows. Use at your own risk.
