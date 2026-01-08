# Testing Plan for Merge Bot in Spider Impact

## Goal

Test the merge-forward branch architecture (issue #3 fix) in Spider Impact to verify:
1. Basic merge-forward and conflict resolution work end-to-end
2. Conflict isolation works (Scenario Beta) - two PRs with conflicts at the same point are isolated
3. `branch-here` branches advance correctly
4. `merge-forward` and `merge-conflicts` branches are cleaned up after chain completes

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

## Phase 2: Test Conflict Resolution at Main

Test that a single PR can conflict at main and be resolved following the generated instructions.

### Create a conflicting state in main

```bash
git fetch origin
git checkout -b conflict-setup origin/main

sed -i '' 's/Current branch:.*/Current branch: MAIN-DIFFERENT-VALUE/' merge-bot-test.txt
git add merge-bot-test.txt
git commit -m "Create conflicting state in main for testing"
git push -u origin conflict-setup
gh pr create --base main --title "Setup: Create conflicting state" --body "Setting up test"
gh pr merge --merge --delete-branch
```

### Create a PR that will conflict when reaching main

```bash
git fetch origin
git checkout -b test-conflict origin/branch-here-release-5.7.2

sed -i '' 's/Current branch:.*/Current branch: TEST-CHANGE/' merge-bot-test.txt
git add merge-bot-test.txt
git commit -m "Test change that will conflict at main"
git push -u origin test-conflict
gh pr create --base release-5.7.2 --title "Test conflict resolution" --body "Testing conflict at main"
gh pr merge --merge --delete-branch
```

### Verify and resolve

1. Watch the action: `gh run watch`
2. A conflict issue should be created with instructions
3. Follow the instructions in the issue to resolve the conflict
4. Create a PR to the merge-forward branch and merge it
5. **Verify**: Chain completes to main, merge-forward and merge-conflicts branches cleaned up

## Phase 3: Test Scenario Beta (Conflict Isolation)

This tests the critical property that two PRs conflicting at the same point have isolated merge chains - each user only sees their own conflicts.

### Setup: Ensure main has a different value

```bash
# First, make sure main has a value that will conflict with changes from release branches
git fetch origin
git show origin/main:merge-bot-test.txt
# If needed, update main to have a conflicting value (see Phase 2 setup)
```

### Create TWO PRs from the same branch-here point (before either's merge bot runs)

**Critical**: Both PRs must branch from the SAME `branch-here` snapshot and modify DIFFERENT parts of the file so they don't conflict with each other at the base branch.

#### User A's Change

```bash
git fetch origin
git checkout -b test-beta-user-a origin/branch-here-release-5.7.2

# Add a NEW line (don't modify existing lines) so it merges cleanly to base
echo "User A was here" >> merge-bot-test.txt
git add merge-bot-test.txt
git commit -m "User A's change"
git push -u origin test-beta-user-a
gh pr create --base release-5.7.2 --title "Test Beta - User A" --body "Scenario Beta test"
```

#### User B's Change (immediately, before User A's action completes)

```bash
git fetch origin
git checkout -b test-beta-user-b origin/branch-here-release-5.7.2

# Add a DIFFERENT new line
echo "User B was here" >> merge-bot-test.txt
git add merge-bot-test.txt
git commit -m "User B's change"
git push -u origin test-beta-user-b
gh pr create --base release-5.7.2 --title "Test Beta - User B" --body "Scenario Beta test"
```

#### Merge both PRs quickly (before either merge bot completes)

```bash
gh pr merge test-beta-user-a --merge --delete-branch
gh pr merge test-beta-user-b --merge --delete-branch
```

### Verify Isolation

```bash
git fetch origin
git branch -r | grep merge-forward-pr
git branch -r | grep merge-conflicts
```

**Success criteria**:
- Both User A and User B have separate `merge-forward-pr-{prNumber}-*` branches
- Each user's conflict issue only shows their own conflicts (not the other user's)
- When resolving, each user only sees files they modified, not the other user's changes

### Resolve both conflicts

Follow the instructions in each conflict issue. Verify each resolution only involves that user's changes.

## Notes

- All commands use GitHub CLI (`gh`) for automation
- Monitor actions with `gh run list` and `gh run watch`
- View issues with `gh issue view {number}`
- When conflicts occur, follow the generated issue instructions to resolve
