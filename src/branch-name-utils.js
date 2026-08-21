const { MB_BRANCH_FORWARD_PREFIX, MB_BRANCH_FAILED_PREFIX } = require('./constants')

/**
 * Utilities for parsing merge-bot branch names to extract metadata.
 * Branch name formats:
 * - merge-forward: merge-forward-pr-{prNumber}-{targetBranch}
 * - merge-conflicts: merge-conflicts-{issueNumber}-pr-{prNumber}-{source}-to-{target}
 */

/**
 * Shared helper to extract PR number from merge-bot branch names.
 * Both merge-forward and merge-conflicts branches use -pr-{prNumber}- format.
 *
 * @param {string} branchName - The branch name to parse
 * @returns {string|null} The PR number, or null if no match
 */
function extractPRNumber(branchName) {
	const match = branchName.match(/-pr-(\d+)-/)
	return match ? match[1] : null
}

/**
 * Extracts the PR number from a merge-forward branch name.
 * Format: merge-forward-pr-{prNumber}-{targetBranch}
 * Example: merge-forward-pr-12345-release-5.8.0 -> '12345'
 *
 * @param {string} branchName - The branch name to parse
 * @returns {string|null} The PR number, or null if not a merge-forward branch
 */
function extractPRFromMergeForward(branchName) {
	if (!branchName.startsWith(MB_BRANCH_FORWARD_PREFIX)) {
		return null
	}
	return extractPRNumber(branchName)
}

/**
 * Extracts the PR number from a merge-conflicts branch name.
 * Format: merge-conflicts-{issueNumber}-pr-{prNumber}-{source}-to-{target}
 * Example: merge-conflicts-68586-pr-12345-release-5.8.0-to-main -> '12345'
 *
 * @param {string} branchName - The branch name to parse
 * @returns {string|null} The PR number, or null if not a merge-conflicts branch
 */
function extractPRFromMergeConflicts(branchName) {
	if (!branchName.startsWith(MB_BRANCH_FAILED_PREFIX)) {
		return null
	}
	return extractPRNumber(branchName)
}

/**
 * Extracts the target branch name from a merge-forward branch.
 * Format: merge-forward-pr-{prNumber}-{targetBranch}
 * Example: merge-forward-pr-123-release-5.8.0 -> 'release-5.8.0'
 *
 * @param {string} branchName - The merge-forward branch name
 * @returns {string} The target branch name
 */
function extractTargetFromMergeForward(branchName) {
	return branchName.replace(new RegExp(`^${MB_BRANCH_FORWARD_PREFIX}\\d+-`), '')
}

/**
 * Determines the original PR number that started this merge
 * chain. Checks the base ref for a merge-forward branch name,
 * then the head ref for a merge-conflicts branch name, and
 * falls back to the PR's own number.
 *
 * @param {Object} options
 * @param {string} options.baseRef - The PR's base branch name
 * @param {string} options.headRef - The PR's head branch name
 * @param {number|string} options.prNumber - The PR's own number
 * @returns {string|number} The original PR number
 */
function extractOriginalPRNumber({ baseRef, headRef, prNumber }) {
	return extractPRFromMergeForward(baseRef ?? '')
		?? extractPRFromMergeConflicts(headRef ?? '')
		?? prNumber
}

/**
 * Extracts the source branch from a merge-conflicts branch name.
 * Format: merge-conflicts-{issueNumber}-pr-{prNumber}-{source}-to-{target}
 * Example: merge-conflicts-71392-pr-71347-release-5.8.0-to-main -> 'release-5.8.0'
 *
 * @param {string} branchName - The merge-conflicts branch name
 * @returns {string|null} The source branch name, or null if not parseable
 */
function extractSourceFromMergeConflicts(branchName) {
	const match = branchName.match(
		/^merge-conflicts-\d+-pr-\d+-(.+)-to-(.+)$/)
	return match ? match[1] : null
}

/**
 * Extracts the PR number a merge commit's subject line claims to have
 * merged. The merge commit is the only record of which PR actually put a
 * commit on a branch, so this is what decides forward-merge ownership
 * (#74510).
 *
 * Recognizes the three attributed subjects that reach Impact's release
 * branches:
 * - `Merge pull request #N from owner/branch` (GitHub UI and spider-shell)
 * - `auto-merge of <sha> ... triggered by (#N) on \`branch\`` (merge-bot)
 * - `Merge #N into branch-here-release-5.8.0` (branch-here sync)
 *
 * Anything else returns null so callers can fail open: a hand-rolled
 * `Merge release-5.8.1 into main` from manual-merge.sh claims no PR, and
 * `Merge #73891 (22ab4bd97) into main` is merge-bot's conflict issue title,
 * which names an ISSUE rather than a PR.
 *
 * @param {string} subject - The merge commit's subject line
 * @returns {string|null} The PR number, or null if the subject names none
 */
function extractMergedPRNumber(subject) {
	const patterns = [
		/^Merge pull request #(\d+)\b/,
		/\btriggered by \(#(\d+)\)/,
		/^Merge #(\d+) into \S/
	]
	for (const pattern of patterns) {
		const match = (subject ?? '').match(pattern)
		if (match) {
			return match[1]
		}
	}
	return null
}

module.exports = {
	extractPRFromMergeForward,
	extractPRFromMergeConflicts,
	extractTargetFromMergeForward,
	extractSourceFromMergeConflicts,
	extractOriginalPRNumber,
	extractMergedPRNumber
}
