#!/bin/bash
#
# manual-merge.sh
#
# Recovery script for when the merge bot breaks down or branches get out of sync.
# Manually performs merge-forward operations, updates branch-here pointers,
# and cleans up stale branches.
#
# Usage: Run from Spider Impact repo root
#   ~/git/merge-bot/manual-merge.sh
#

set -e

CONFIG_FILE=".spider-merge-bot-config.json"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
  echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
  echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
  echo -e "${RED}[ERROR]${NC} $1"
}

# Validate we're in the right repo
if [[ ! -f "$CONFIG_FILE" ]]; then
  log_error "$CONFIG_FILE not found. Run from Spider Impact repo root."
  exit 1
fi

# Check for required tools
if ! command -v jq &> /dev/null; then
  log_error "jq is required but not installed."
  exit 1
fi

if ! command -v gh &> /dev/null; then
  log_error "gh CLI is required but not installed."
  exit 1
fi

# Step 1: Fetch all branches
log_info "Fetching all branches..."
git fetch --all --prune

# Always read config from origin/main — it's the authoritative, most up-to-date version.
# Reading from the working tree is unreliable because older branches may not yet have
# the latest merge chain entries.
CONFIG_JSON=$(git show "origin/main:$CONFIG_FILE")

# Parse merge operations from config (jq preserves key order)
MERGE_OPS=$(echo "$CONFIG_JSON" | jq -r '.mergeOperations | to_entries[] | "\(.key) \(.value)"')

# Get all release branches (keys from mergeOperations — these are the
# source/left-hand side of each merge pair)
RELEASE_BRANCHES=$(echo "$CONFIG_JSON" | jq -r '.mergeOperations | keys[]')

# Get all branches involved in merge operations (both sources and targets),
# deduplicated. Used in Step 1 to flush any locally-resolved commits before merging.
ALL_MERGE_BRANCHES=$(echo "$CONFIG_JSON" | jq -r '.mergeOperations | to_entries[] | (.key, .value)' | sort -u)

# Step 1: Push any branches that are ahead of origin.
# Do this before merging forward so that origin reflects any locally-resolved
# commits from a previous interrupted run, ensuring origin/$source is up to date
# when used as the merge source below.
log_info "Pushing any unpushed branches..."
while IFS= read -r branch; do
  if git show-ref --verify --quiet "refs/heads/$branch" && \
     git show-ref --verify --quiet "refs/remotes/origin/$branch"; then
    local_sha=$(git rev-parse "$branch")
    origin_sha=$(git rev-parse "origin/$branch")
    if [[ "$local_sha" != "$origin_sha" ]]; then
      # Only push if local is ahead of origin; if behind, skip to avoid rejection
      if git merge-base --is-ancestor "$origin_sha" "$local_sha"; then
        log_info "  Pushing $branch..."
        git checkout "$branch"
        git push origin "$branch"
        log_info "  Pushed successfully."
      else
        log_warn "  $branch is behind or diverged from origin — skipping push. Manual intervention may be needed."
      fi
    fi
  fi
done <<< "$ALL_MERGE_BRANCHES"

# Step 2: Merge forward
log_info "Starting merge forward operations..."

while IFS=' ' read -r source target; do
  log_info "Processing: $source → $target"

  # Checkout target branch
  git checkout "$target"
  git pull origin "$target"

  # Check if already merged (source is ancestor of target)
  if git merge-base --is-ancestor "origin/$source" HEAD; then
    log_info "  Already merged."
  else
    # Attempt merge
    if ! git merge "origin/$source" -m "Merge $source into $target"; then
      echo ""
      log_error "CONFLICT: Could not merge $source into $target"
      echo ""
      echo "Resolve the conflict manually:"
      echo "  1. You are on branch '$target'"
      echo "  2. Resolve conflicts in your editor"
      echo "  3. git add <resolved files>"
      echo "  4. git commit"
      echo "  5. Re-run this script"
      exit 1
    fi
  fi

  # Push if there are unpushed commits
  if [[ "$(git rev-parse HEAD)" != "$(git rev-parse "origin/$target")" ]]; then
    git push origin "$target"
    log_info "  Pushed successfully."
  else
    log_info "  Already up to date with origin."
  fi

done <<< "$MERGE_OPS"

# Step 3: Update branch-here pointers (fast-forward)
log_info "Updating branch-here pointers..."

while IFS= read -r release_branch; do
  branch_here="branch-here-$release_branch"

  log_info "Fast-forwarding $branch_here to match $release_branch"

  # Checkout branch-here (create if doesn't exist)
  if git show-ref --verify --quiet "refs/remotes/origin/$branch_here"; then
    git checkout "$branch_here"
    git pull origin "$branch_here"
  else
    log_warn "  $branch_here doesn't exist, creating it."
    git checkout -b "$branch_here" "origin/$release_branch"
    git push origin "$branch_here"
    continue
  fi

  # Fast-forward to release branch
  if ! git merge --ff-only "origin/$release_branch"; then
    log_error "  Could not fast-forward $branch_here. This may require manual intervention."
    exit 1
  fi

  git push origin "$branch_here"
  log_info "  Updated successfully."

done <<< "$RELEASE_BRANCHES"

# Step 4: Cleanup
log_info "Starting cleanup..."

# Delete merge-forward branches
log_info "Deleting merge-forward branches..."
MERGE_FORWARD_BRANCHES=$(git branch -r | grep 'origin/merge-forward-' | sed 's|origin/||' | xargs || true)
if [[ -n "$MERGE_FORWARD_BRANCHES" ]]; then
  for branch in $MERGE_FORWARD_BRANCHES; do
    log_info "  Deleting $branch"
    git push origin --delete "$branch" || log_warn "  Failed to delete $branch"
  done
else
  log_info "  No merge-forward branches to delete."
fi

# Delete merge-conflicts branches
log_info "Deleting merge-conflicts branches..."
MERGE_CONFLICTS_BRANCHES=$(git branch -r | grep 'origin/merge-conflicts-' | sed 's|origin/||' | xargs || true)
if [[ -n "$MERGE_CONFLICTS_BRANCHES" ]]; then
  for branch in $MERGE_CONFLICTS_BRANCHES; do
    log_info "  Deleting $branch"
    git push origin --delete "$branch" || log_warn "  Failed to delete $branch"
  done
else
  log_info "  No merge-conflicts branches to delete."
fi

# Close merge conflict issues
log_info "Closing merge conflict issues..."
ISSUE_NUMBERS=$(gh issue list --label "merge conflict" --state open --json number -q '.[].number')
if [[ -n "$ISSUE_NUMBERS" ]]; then
  for issue in $ISSUE_NUMBERS; do
    log_info "  Closing issue #$issue"
    gh issue close "$issue" --comment "Manually reset merge state." || log_warn "  Failed to close issue #$issue"
  done
else
  log_info "  No open merge conflict issues to close."
fi

echo ""
log_info "Done! All branches are now in sync."
