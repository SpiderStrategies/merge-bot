const { MB_BRANCH_FAILED_PREFIX, MB_BRANCH_HERE_PREFIX } = require('./constants')

/**
 *
 * @param {BaseAction} action An action instance that can be used to exec commands
 * @param {String} branch A branch to inspect (source branch)
 * @param {String} targetBranch The branch that this source branch merges into (optional for backwards compatibility)
 * @returns {Promise<string>} The ref (branch name or commit) that represents
 * the commit in the history where we know there are no pending merge conflicts.
 * If null, that indicates the branch-here branch can not be advanced any further
 */
async function findCleanMergeRef(action, branch, targetBranch) {
	// This is the point that PRs can be based from
	let cleanMergePoint

	// topo-order so parent commits are grouped w/ their children
	const gitLogCmd = `git log` +
		` origin/${MB_BRANCH_HERE_PREFIX}${branch}...origin/${branch}` + // all of commits with a failure tag
		` --pretty=format:"%H %d" --topo-order` // %d to see refs

	const history = (await action.exec(gitLogCmd)).split('\n')

	// Convert branch names to the format used in merge-conflicts branch names
	// e.g., "release-5.8.0" -> "release-5-8-0"
	const normalizedBranch = branch.replace(/\./g, '-')
	const normalizedTarget = targetBranch ? targetBranch.replace(/\./g, '-') : null

	// Build the pattern for relevant merge-conflicts branches
	// Pattern: merge-conflicts-NNNNN-{sourceBranch}-to-{targetBranch}
	const relevantConflictPattern = normalizedTarget
		? `${MB_BRANCH_FAILED_PREFIX}\\d+-${normalizedBranch}-to-${normalizedTarget}`
		: null

	// Reverse history so oldest commits are first
	const reversedHistory = history.reverse()

	// Find the FIRST (oldest) relevant conflict
	// This ensures we stop before ALL conflicting commits (most conservative)
	const idx = reversedHistory.findIndex(line => isRelevantConflict(line, relevantConflictPattern))

	if (idx != -1) {
		// We have `merge-conflict` branches

		if (idx < 2) {
			// branch-here is already adjacent to a merge-conflicts branch and can't be advanced
			cleanMergePoint = null
		} else {
			// Commits that came before the first `merge-conflicts-*` branch
			let commits = reversedHistory.splice(0, idx).map(commit => commit.split(' ')[0])
			cleanMergePoint = await findValidAncestor(action, commits, branch)
		}
	} else {
		cleanMergePoint = `origin/${branch}`
	}

	return cleanMergePoint
}

/**
 * Checks if a git log line represents a merge conflict relevant to the
 * current merge path.
 *
 * @param {String} line A line from git log output (format: "%H %d")
 * @param {String} relevantConflictPattern Regex pattern for relevant conflicts,
 *        or null to treat all conflicts as relevant (backwards compatibility)
 * @returns {Boolean} True if this line represents a relevant merge conflict
 */
function isRelevantConflict(line, relevantConflictPattern) {
	if (!line.includes(MB_BRANCH_FAILED_PREFIX)) {
		return false
	}

	// If no targetBranch specified (backwards compatibility), treat all merge-conflicts as relevant
	if (!relevantConflictPattern) {
		return true
	}

	// Check if this is an old-format branch (no encoding)
	const oldFormatPattern = new RegExp(`${MB_BRANCH_FAILED_PREFIX}\\d+\\)`)
	if (oldFormatPattern.test(line)) {
		// Old format branch - treat as relevant (conservative approach)
		return true
	}

	// Check if this matches our specific merge path
	const pattern = new RegExp(relevantConflictPattern)
	return pattern.test(line)
}

/**
 * Finds the most recent commit in the provided list that is a valid ancestor
 * of the branch-here branch (can be fast-forwarded).
 *
 * @param {BaseAction} action An action instance that can be used to exec commands
 * @param {String[]} commits Array of commit hashes to search through
 * @param {String} branch The branch being maintained
 * @returns {Promise<string|undefined>} The commit hash of a valid ancestor,
 *          or undefined if none found
 */
async function findValidAncestor(action, commits, branch) {
	let validCommit
	let searching = true

	while (searching && commits.length) {
		const candidateCommit = commits.pop()
		try {
			await action.exec(`git merge-base --is-ancestor origin/${MB_BRANCH_HERE_PREFIX}${branch} ${candidateCommit}`)
			validCommit = candidateCommit
			searching = false
		} catch (e) {
			action.core.info(`${candidateCommit} was not a valid ancestor for origin/${MB_BRANCH_HERE_PREFIX}${branch}, continuing search...`)
		}
	}

	return validCommit
}

module.exports = findCleanMergeRef
module.exports.isRelevantConflict = isRelevantConflict
module.exports.findValidAncestor = findValidAncestor
