const { MB_BRANCH_FAILED_PREFIX, MB_BRANCH_HERE_PREFIX } = require('./constants')

/**
 * Builds regex patterns for detecting merge conflicts across the entire branch chain.
 *
 * This function creates patterns to match merge-conflict branch names for all relevant
 * merge paths from the source branch all the way to main. It handles three scenarios:
 * 1. Full chain mode: checks conflicts from source to all downstream branches, plus
 *    conflicts between intermediate branches in the chain
 * 2. Backwards compatibility with targetBranch: checks only immediate next hop
 * 3. Backwards compatibility without targetBranch: returns empty array to match all conflicts
 *
 * @param {String} normalizedBranch The source branch name with dots replaced by dashes
 * @param {String} targetBranch The immediate target branch (optional, for backwards compatibility)
 * @param {Array<String>} allBranchesInChain All branches from source to main, in order
 * @returns {Array<String>} Array of regex pattern strings for matching conflict branch names
 */
function buildConflictPatterns(normalizedBranch, targetBranch, allBranchesInChain) {
	const conflictPatterns = []

	if (allBranchesInChain.length > 0) {
		// Check for conflicts from THIS branch to any downstream branch
		for (const downstreamBranch of allBranchesInChain) {
			const normalizedDownstream = downstreamBranch.replace(/\./g, '-')
			conflictPatterns.push(`${MB_BRANCH_FAILED_PREFIX}\\d+-${normalizedBranch}-to-${normalizedDownstream}`)
		}

		// ALSO check for conflicts from ANY intermediate branch in the chain
		// Example: if maintaining release-5.7.2 which goes through [5.8.0, main]:
		// - Check conflicts FROM 5.7.2 to anywhere (already done above)
		// - Check conflicts FROM 5.8.0 to main (commits that made it to 5.8.0 but not main)
		for (let i = 0; i < allBranchesInChain.length - 1; i++) {
			const sourceBranch = allBranchesInChain[i]
			const normalizedSource = sourceBranch.replace(/\./g, '-')
			// Check conflicts from this intermediate branch to anything downstream
			for (let j = i + 1; j < allBranchesInChain.length; j++) {
				const targetBranch = allBranchesInChain[j]
				const normalizedTarget = targetBranch.replace(/\./g, '-')
				conflictPatterns.push(`${MB_BRANCH_FAILED_PREFIX}\\d+-${normalizedSource}-to-${normalizedTarget}`)
			}
		}
	} else if (targetBranch) {
		// Backwards compatibility: just check the immediate next hop
		const normalizedTarget = targetBranch.replace(/\./g, '-')
		conflictPatterns.push(`${MB_BRANCH_FAILED_PREFIX}\\d+-${normalizedBranch}-to-${normalizedTarget}`)
	}
	// else: no patterns, fall back to checking ANY merge-conflicts branch (backwards compatibility)

	return conflictPatterns
}

/**
 * Finds the latest commit on a branch that has merged cleanly ALL THE WAY to main.
 *
 * CRITICAL: This function should only be called when commits have reached main,
 * as it's used to determine which commits are safe to include in branch-here pointers.
 *
 * @param {BaseAction} action An action instance that can be used to exec commands
 * @param {String} branch A branch to inspect (source branch)
 * @param {String} targetBranch The branch that this source branch merges into (optional for backwards compatibility)
 * @param {Array<String>} allBranchesInChain All branches from this branch to main, in order
 * @returns {Promise<string>} The ref (branch name or commit) that represents
 * the commit in the history where we know there are no pending merge conflicts.
 * If null, that indicates the branch-here branch can not be advanced any further
 */
async function findCleanMergeRef(action, branch, targetBranch, allBranchesInChain = []) {
	// topo-order so parent commits are grouped w/ their children
	const gitLogCmd = `git log` +
		` origin/${MB_BRANCH_HERE_PREFIX}${branch}...origin/${branch}` + // all commits since last branch-here update
		` --pretty=format:"%H %d" --topo-order` // %d to see refs

	const history = (await action.exec(gitLogCmd)).split('\n')

	const normalizedBranch = branch.replace(/\./g, '-')
	const conflictPatterns = buildConflictPatterns(normalizedBranch, targetBranch, allBranchesInChain)

	// Reverse history so oldest commits are first
	const reversedHistory = history.reverse()

	// Find the FIRST (oldest) relevant conflict
	// This ensures we stop before ALL conflicting commits (most conservative)
	const conflictIdx = reversedHistory.findIndex(line => {
		// If no patterns specified, treat ANY merge-conflicts branch as relevant (backwards compat)
		if (conflictPatterns.length === 0) {
			return isRelevantConflict(line, null)
		}
		// Otherwise, check if line matches any of our patterns
		return conflictPatterns.some(pattern => isRelevantConflict(line, pattern))
	})

	return await determineCleanMergePoint(action, branch, reversedHistory, conflictIdx)
}


/**
 * Determines the clean merge point based on the location of merge conflicts in history.
 *
 * This function takes the index of the first (oldest) conflict in the reversed history
 * and decides where the branch-here pointer can safely be advanced to. Three outcomes:
 * 1. No conflicts found: can advance to the tip of the branch
 * 2. Conflicts too close to current branch-here: cannot advance (returns null)
 * 3. Conflicts found with safe distance: advance to most recent valid ancestor before conflicts
 *
 * @param {BaseAction} action An action instance that can be used to exec commands
 * @param {String} branch The branch being maintained
 * @param {Array<String>} reversedHistory Git log history with oldest commits first
 * @param {Number} conflictIdx Index of first conflict in reversedHistory, or -1 if none
 * @returns {Promise<string|null>} The ref to advance to, or null if cannot advance
 */
async function determineCleanMergePoint(action, branch, reversedHistory, conflictIdx) {
	if (conflictIdx === -1) {
		return `origin/${branch}`
	}

	// We have merge-conflict branches
	if (conflictIdx < 2) {
		// branch-here is already adjacent to a merge-conflicts branch and can't be advanced
		return null
	}

	// Commits that came before the first merge-conflicts-* branch
	const commits = reversedHistory.splice(0, conflictIdx).map(commit => commit.split(' ')[0])
	return await findValidAncestor(action, commits, branch)
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
module.exports.buildConflictPatterns = buildConflictPatterns
module.exports.determineCleanMergePoint = determineCleanMergePoint
module.exports.isRelevantConflict = isRelevantConflict
module.exports.findValidAncestor = findValidAncestor
