# Testing Plan for Merge Bot in Spider Impact

## Goal

Test the merge-forward branch architecture (issue #3 fix) in Spider Impact to verify:
1. Conflict isolation works (Scenario Beta)
2. `branch-here` branches now advance to the release branch tip
3. The full conflict resolution flow works end-to-end

## Phase 1: Add Test File via Merge Bot

Create `merge-bot-test.txt` in `release-5.7.2` and let the merge bot forward it through the chain. This tests basic merge-forward functionality.

```bash
cd ~/git/Scoreboard
git fetch origin
git checkout -b add-merge-bot-test-file origin/branch-here-release-5.7.2

cat > merge-bot-test.txt << 'EOF'
This is a test file for the Spider Merge Bot.
It exists to allow controlled testing of merge scenarios.

Do not delete this file.

Current branch: release-5.7.2
EOF

git add merge-bot-test.txt
git commit -m "Add merge-bot test file for testing"
git push -u origin add-merge-bot-test-file
gh pr create --base release-5.7.2 --title "Add merge-bot test file" --body "Adding a dedicated test file for merge-bot testing"
```

After the PR is merged:
- Watch the action: `gh run watch`
- Verify the file appears in all downstream branches
- Verify `branch-here-*` branches advanced

## Phase 2: Test Scenario Beta (Conflict Isolation)

Two PRs with conflicts at the same point should be isolated.

### User A's Change

```bash
git fetch origin
git checkout -b test-beta-user-a origin/branch-here-release-5.7.2

# Modify the test file to conflict with main
sed -i '' 's/Current branch: release-5.7.2/Current branch: USER-A-CHANGE/' merge-bot-test.txt
git add merge-bot-test.txt
git commit -m "User A's conflicting change"
git push -u origin test-beta-user-a
gh pr create --base release-5.7.2 --title "Test Beta - User A"
gh pr merge --merge --delete-branch
```

Wait for action, note the conflict issue number.

### User B's Change (before User A resolves)

```bash
git fetch origin
git checkout -b test-beta-user-b origin/branch-here-release-5.7.2

# Modify differently from User A
sed -i '' 's/Current branch: release-5.7.2/Current branch: USER-B-CHANGE/' merge-bot-test.txt
git add merge-bot-test.txt
git commit -m "User B's conflicting change"
git push -u origin test-beta-user-b
gh pr create --base release-5.7.2 --title "Test Beta - User B"
gh pr merge --merge --delete-branch
```

### Verify Isolation

```bash
git fetch origin
git branch -r | grep merge-forward-pr
git branch -r | grep merge-conflicts
```

**Success criteria**: User A and User B have separate, isolated merge chains.

## Phase 3: Test Conflict Resolution

1. Follow the instructions in one of the conflict issues
2. Resolve the conflict and create PR to merge-forward branch
3. Merge the resolution PR
4. Watch the action continue the chain
5. **Verify**: Chain completes to main, branches cleaned up

## Notes

- All commands use GitHub CLI (`gh`) for automation
- Monitor actions with `gh run list` and `gh run watch`
- View issues with `gh issue view {number}`
