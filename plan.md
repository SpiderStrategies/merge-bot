# Implementation Plan: merge-forward Branch Architecture

See [Issue #3](https://github.com/SpiderStrategies/merge-bot/issues/3) for detailed background and design rationale.

## Progress

- [x] **Bug #1**: Merge instructions use target branch instead of commit SHA (5d407c4)
- [x] **Bug #2**: merge-conflicts branch points to wrong commit
- [x] **Bug #3**: merge-conflicts branch name uses wrong source branch

## Phase 1: Add merge-forward Branch Constant

- [x] Add `MB_BRANCH_FORWARD_PREFIX = 'merge-forward-pr-'` to `constants.js`

## Phase 2: Track Merge Chain State

- [x] Add `lastSuccessfulMergeRef` property to `AutoMerger` to track the most recent successful merge point
- [x] Initialize `lastSuccessfulMergeRef` to `prCommitSha` before starting the merge chain
- [x] Update `lastSuccessfulMergeRef` after each successful merge (before pushing)

## Phase 3: Create merge-forward Branches During Auto-merge

- [x] After each successful merge, create/update `merge-forward-pr-{prNumber}-{targetBranch}`
- [x] Point it to the merge commit (not the original PR commit)
- [x] This gives us isolated per-PR merge state

## Phase 4: Fix merge-conflicts Branch Creation

- [x] Change branch creation to use `lastSuccessfulMergeRef` instead of `prCommitSha`
- [x] Change source branch in naming from `baseBranch` to the immediate predecessor (derive from merge chain position)
- [x] Create corresponding `merge-forward-pr-{prNumber}-{targetBranch}` pointing to `branch-here-{targetBranch}` as the PR target

## Phase 5: Update Issue Instructions

- [x] Update `writeComment()` to reference the merge-forward target branch for PR creation
- [x] Instructions should tell user to merge `branch-here-{target}` (not the release branch directly)
- [x] PR should target `merge-forward-pr-{prNumber}-{targetBranch}`

## Phase 6: Continue Chain After Conflict Resolution PR Merges

- [x] Detect when a PR merges into a `merge-forward-pr-*` branch
- [x] Resume auto-merge chain from that point toward main
- [x] Track which original PR this belongs to (extract from branch name)

## Phase 7: Update Release Branches on Chain Completion

- [x] Detect when merge-forward chain reaches main successfully
- [x] Fast-forward (or merge) each release branch to its corresponding merge-forward commit
- [x] Advance all `branch-here` pointers

## Phase 8: Cleanup

- [x] Delete all `merge-forward-pr-{prNumber}-*` branches after chain reaches main
- [x] Delete `merge-conflicts-*` branches (existing logic, verify it still works)

## Phase 9: Tests

- [ ] Unit tests for merge-forward branch naming
- [ ] Unit tests for chain continuation after conflict PR merge
- [ ] Unit tests for release branch updates on chain completion
- [ ] Integration test for Scenario Beta (two PRs with conflicts at same point)

## Notes

- `branch-here` pointers only advance after entire chain reaches main (existing behavior, keep it)
- Race conditions: whoever merges first wins, second person sees conflicts (normal Git behavior)
- Fast-forward preferred for release branch updates; merge commit fallback if branch moved
