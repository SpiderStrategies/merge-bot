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

module.exports = {
	extractPRFromMergeForward,
	extractPRFromMergeConflicts,
	extractTargetFromMergeForward
}
