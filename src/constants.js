/**
 * Git merge output when no changes need to be merged
 */
const UP_TO_DATE = `Already up to date.`

/**
 * Prefix for branches created when merge conflicts occur
 */
const MB_BRANCH_FAILED_PREFIX = `merge-conflicts-`

/**
 * Prefix for branch pointers that mark safe branching points
 */
const MB_BRANCH_HERE_PREFIX = `branch-here-`

/**
 * Prefix for per-PR merge chain tracking branches
 */
const MB_BRANCH_FORWARD_PREFIX = `merge-forward-pr-`

/**
 * Temporary file used for issue comment body
 */
const ISSUE_COMMENT_FILENAME = `.issue-comment.txt`

module.exports = {
	UP_TO_DATE,
	MB_BRANCH_FAILED_PREFIX,
	MB_BRANCH_HERE_PREFIX,
	MB_BRANCH_FORWARD_PREFIX,
	ISSUE_COMMENT_FILENAME
}