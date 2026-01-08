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

## Testing

### Overview

Testing the merge bot requires a real repository with multiple release branches. At Spider Strategies, we test against Spider Impact which has branches like `release-5.7.0`, `release-5.8.0`, and `main`.

### Dedicated Test File

To test merge scenarios in a controlled way, use a dedicated test file that exists solely for merge bot testing:

**File**: `merge-bot-test.txt` (in your target repository's root)

This file should:
- Be simple (plain text) to avoid syntax issues
- Exist in all release branches
- Have different content in each branch to simulate divergence

Example setup:
```bash
# On release-5.7.0
echo "release-5.7.0 baseline" > merge-bot-test.txt

# On release-5.8.0
echo "release-5.8.0 baseline" > merge-bot-test.txt

# On main
echo "main baseline" > merge-bot-test.txt
```

### Test Scenarios

#### Scenario 1: Clean Merge Forward

1. Create a branch from `branch-here-release-5.7.0`
2. Modify `merge-bot-test.txt` with a **non-conflicting** change (e.g., add a new line)
3. Create and merge a PR to `release-5.7.0`
4. **Expected**: Bot creates `merge-forward-pr-{N}-release-5-7-1`, etc., and merges cleanly to `main`

#### Scenario 2: Single Conflict

1. Create a branch from `branch-here-release-5.7.0`
2. Modify `merge-bot-test.txt` with a change that will conflict with `main` (e.g., edit the same line that differs)
3. Create and merge a PR to `release-5.7.0`
4. **Expected**:
   - Bot merges through intermediate branches
   - Conflict at `main` creates an issue
   - `merge-conflicts-{issue}-release-5-8-0-to-main` branch is created
   - `merge-forward-pr-{N}-main` points to `branch-here-main`

#### Scenario 3: Conflict Isolation (Scenario Beta)

This tests that two developers with conflicts at the same point don't see each other's conflicts:

1. **User A**: Make a conflicting change in `release-5.7.0`, merge PR
2. **User B**: Make a *different* conflicting change in `release-5.7.0`, merge PR
3. **Expected**:
   - Both users get separate `merge-forward-pr-{N}-*` branches
   - Both merge with the *same* `branch-here-release-5.8.0` snapshot
   - Neither user sees the other's unresolved conflicts

#### Scenario 4: Conflict Resolution Flow

1. After a conflict occurs (Scenario 2), resolve it:
   ```bash
   git checkout merge-conflicts-{issue}-release-5-8-0-to-main
   git merge branch-here-main
   # Resolve conflicts in merge-bot-test.txt
   git commit
   git push
   ```
2. Create a PR from `merge-conflicts-*` to `merge-forward-pr-{N}-main`
3. Merge the PR
4. **Expected**:
   - Bot resumes the merge chain
   - Release branches are updated
   - All `merge-forward-pr-{N}-*` branches are deleted
   - Conflict issue is closed

### Verification Checklist

After each test scenario, verify:

- [ ] `merge-forward-pr-{N}-*` branches created/deleted appropriately
- [ ] `merge-conflicts-*` branch points to correct commit (last successful merge)
- [ ] `branch-here-*` pointers haven't advanced past unresolved conflicts
- [ ] Issue instructions reference correct branches (`branch-here-{target}`, not commit SHA)
- [ ] Release branches updated only after chain reaches `main`

### Cleanup

After testing, delete any leftover test branches:

```bash
git push origin --delete merge-forward-pr-{N}-release-5-7-1
git push origin --delete merge-conflicts-{issue}-release-5-8-0-to-main
```

## Support

This repository is made public for convenience but is not officially supported for external use. It is maintained by Spider Strategies for internal workflows. Use at your own risk.
