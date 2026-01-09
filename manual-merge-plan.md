# Manual Merge Script Plan

## Overview

`manual-merge.sh` is a recovery script for when the merge bot breaks down or branches get out of sync. It manually performs the merge-forward operations, updates branch-here pointers, and cleans up stale branches.

**When to use**: When the merge bot has a bug or the branch state is corrupted and needs to be reset to a pristine state.

## Prerequisites

- `gh` CLI installed and authenticated
- Script lives in `merge-bot` repo
- Invoked from within the Spider Impact repository
- Config file: `.spider-merge-bot-config.json` in the Impact repo

## Script Steps

### Step 1: Merge Branches Forward

1. Fetch all remote branches
2. Read merge operations from `.spider-merge-bot-config.json`
3. For each merge operation in order (e.g., `release-5.7.0` → `release-5.7.1` → ... → `main`):
   - Checkout the target branch (pull latest)
   - Merge the source branch
   - **If conflict**: Exit with clear instructions for user to resolve
   - **If success**: Push to origin
4. Script is **idempotent** - if a merge is already complete (source is ancestor of target), skip it

### Step 2: Update branch-here Pointers

After all merges complete successfully:

1. For each release branch (not including `main`):
   - Fast-forward `branch-here-{release}` to match `{release}`
   - Push to origin

**Note**: `main` does not have a `branch-here-main` pointer (it IS the terminal branch).

### Step 3: Cleanup

1. Delete all remote `merge-forward-*` branches
2. Delete all remote `merge-conflicts-*` branches
3. Close all open GitHub issues with the `merge conflict` label
   - Use `gh issue list --label "merge conflict"` to find them
   - Use `gh issue close` with a comment explaining manual reset

## Conflict Resolution Flow

When a conflict occurs:

1. Script exits with message like:
   ```text
   CONFLICT: Could not merge release-5.7.1 into release-5.7.2

   Resolve the conflict manually:
     1. You are on branch 'release-5.7.2'
     2. Resolve conflicts in your editor
     3. git add <resolved files>
     4. git commit
     5. Re-run this script
   ```

2. User resolves conflicts manually
3. User commits
4. User re-runs script
5. Script detects merge is complete, skips to next operation

## Usage

```bash
# From Spider Impact repo root
~/git/merge-bot/manual-merge.sh
```

## Config File Format

The script reads `.spider-merge-bot-config.json`:

```json
{
  "mergeOperations": {
    "release-5.7.0": "release-5.7.1",
    "release-5.7.1": "release-5.7.2",
    "release-5.7.2": "release-5.8.0",
    "release-5.8.0": "main"
  }
}
```

The script processes these in the order defined (using jq's `to_entries` which preserves input order).

## Design Decisions

1. **No confirmation prompts** - KISS. Origin provides backups if we need to undo.
2. **Issue identification** - Use the `merge conflict` label (all merge conflict issues have this label).
3. **Merge operation order** - We use jq's `to_entries` to iterate `mergeOperations` in the order defined in the config file.

## Pseudocode

```bash
#!/bin/bash
set -e

CONFIG_FILE=".spider-merge-bot-config.json"

# Validate we're in the right repo
if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "Error: $CONFIG_FILE not found. Run from Spider Impact repo root."
  exit 1
fi

# Step 1: Fetch
echo "Fetching all branches..."
git fetch --all

# Step 1: Merge forward
# Parse mergeOperations with jq (preserves key order)

for each (source, target) in ordered_merge_operations:
  echo "Merging $source into $target..."
  git checkout $target
  git pull origin $target

  # Check if already merged
  if git merge-base --is-ancestor $source $target; then
    echo "  Already merged, skipping."
    continue
  fi

  # Attempt merge
  if ! git merge $source -m "Merge $source into $target"; then
    echo "CONFLICT: Could not merge $source into $target"
    echo "Resolve conflicts, commit, and re-run this script."
    exit 1
  fi

  git push origin $target
done

# Step 2: Update branch-here pointers (fast-forward)
for each release_branch in release_branches (excluding main):
  branch_here="branch-here-$release_branch"
  git checkout $branch_here
  git merge --ff-only $release_branch
  git push origin $branch_here
done

# Step 3: Cleanup
echo "Cleaning up merge-forward branches..."
git branch -r | grep 'origin/merge-forward-' | sed 's|origin/||' | xargs -I {} git push origin --delete {}

echo "Cleaning up merge-conflicts branches..."
git branch -r | grep 'origin/merge-conflicts-' | sed 's|origin/||' | xargs -I {} git push origin --delete {}

echo "Closing merge conflict issues..."
gh issue list --label "merge conflict" --state open --json number -q '.[].number' | xargs -I {} gh issue close {} --comment "Manually reset merge state."

echo "Done!"
```
