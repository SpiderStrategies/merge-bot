const { MB_BRANCH_FAILED_PREFIX, MB_BRANCH_HERE_PREFIX, MB_BRANCH_FORWARD_PREFIX } = require('./constants')

/**
 * Maintains branch-here pointers by updating them to the latest commit that
 * successfully merged all the way to main.
 *
 * See the original issue for more details/links:
 * https://github.com/SpiderStrategies/Scoreboard/issues/42921
 */
class BranchMaintainer {

	/**
	 * @param {Object} options
	 * @param {Object} options.pullRequest - The pull request from the GitHub event
	 * @param {Object} options.config - The parsed merge-bot config
	 * @param {Object} options.core - The @actions/core module for logging
	 * @param {Object} options.shell - Shell instance for executing commands
	 */
	constructor({ pullRequest, config, core, shell }) {
		this.pullRequest = pullRequest
		this.config = config
		this.core = core
		this.shell = shell
		this.terminalBranch = this.determineTerminalBranch()
	}

	/**
	 * Main entry point - handles all branch maintenance responsibilities:
	 * 1. Delete merge-conflicts branches when conflict PRs are merged
	 * 2. Maintain branch-here pointers (only if commits reached main)
	 *
	 * CRITICAL: Only maintains branch-here when commits have merged ALL THE WAY to main.
	 * This ensures branch-here branches only include commits that have successfully
	 * merged through the entire release chain, preventing users from inheriting
	 * conflicts from earlier in the chain.
	 *
	 * @param {Object} options
	 * @param {string} [options.automergeConflictBranch] - The branch where automerge
	 *   encountered conflicts (undefined if automerge succeeded)
	 */
	async run({ automergeConflictBranch } = {}) {
		if (!this.pullRequest.merged) {
			this.core.info('PR was not merged, skipping branch maintenance')
			return
		}

		// Always check if we need to delete a merge-conflicts branch, regardless of
		// which branch the PR was merged into
		await this.cleanupMergeConflictsBranch()

		// Determine if commits reached the terminal branch
		const isTerminalBranch = this.pullRequest.base.ref === this.terminalBranch
		const automergeSucceeded = !automergeConflictBranch
		const commitsReachedMain = !isTerminalBranch && automergeSucceeded

		// Also clean up if a merge-conflicts PR completed the chain by merging to terminal
		const mergeConflictsPRCompleted = this.isMergeConflictsPR() && isTerminalBranch
		const shouldCleanup = commitsReachedMain || mergeConflictsPRCompleted

		if (shouldCleanup) {
			this.core.info(`Running branch maintenance: commits reached main`)
			await this.maintainBranches()
			await this.cleanupMergeForwardBranches()
		} else if (isTerminalBranch) {
			this.core.info(`Skipping branch maintenance: PR was against terminal branch, no merge chain traversed`)
		} else {
			this.core.info(`Skipping branch maintenance: commits blocked at ${automergeConflictBranch}, have not reached main yet`)
		}
	}

	/**
	 * Determines the terminal branch (last branch in the merge chain, typically main).
	 *
	 * @returns {string} The name of the terminal branch
	 */
	determineTerminalBranch() {
		const branches = Object.keys(this.config.branches)
		return branches[branches.length - 1]
	}

	/**
	 * Cleans up the merge-conflicts branch if this PR came from one.
	 */
	async cleanupMergeConflictsBranch() {
		const headRef = this.pullRequest.head.ref ?? ''
		if (headRef.startsWith(MB_BRANCH_FAILED_PREFIX)) {
			await this.shell.execQuietly(`git push origin --delete ${headRef}`)
		}
	}

	/**
	 * Determines whether this PR's head branch is a merge-conflicts branch.
	 */
	isMergeConflictsPR() {
		return (this.pullRequest.head.ref ?? '').startsWith(MB_BRANCH_FAILED_PREFIX)
	}

	/**
	 * Determines the original PR number for merge-forward cleanup.
	 * Extracts from merge-conflicts branch name, or falls back to current PR number.
	 */
	determineOriginalPRNumber() {
		const headRef = this.pullRequest.head?.ref ?? ''

		if (headRef.startsWith(MB_BRANCH_FAILED_PREFIX)) {
			const match = /-pr-(\d+)-/.exec(headRef)
			if (match) return match[1]
		}

		return this.pullRequest.number
	}

	/**
	 * Cleans up all merge-forward branches for this PR's merge chain.
	 * Uses determineOriginalPRNumber() to handle resolution PRs correctly.
	 */
	async cleanupMergeForwardBranches() {
		const prNumber = this.determineOriginalPRNumber()
		if (prNumber) {
			await this.cleanupMergeForwardBranchesForPR(prNumber)
		}
	}

	/**
	 * Cleans up merge-forward branches for a given PR number.
	 * Before deleting each branch, merges it into the corresponding branch-here
	 * to incrementally advance branch-here with completed changes (issue #11).
	 *
	 * @param {string|number} prNumber - The PR number whose merge-forward
	 *   branches to clean up
	 */
	async cleanupMergeForwardBranchesForPR(prNumber) {
		const pattern = `${MB_BRANCH_FORWARD_PREFIX}${prNumber}-`

		const branches = await this.shell.exec(
			`git ls-remote --heads origin '${pattern}*'`)

		if (!branches) {
			return
		}

		// Extract branch names from git ls-remote output
		// Format: <hash>\trefs/heads/<branch-name>
		const branchNames = branches
			.split('\n')
			.filter(line => line.trim())
			.map(line => line.split('refs/heads/')[1])
			.filter(name => name)

		for (const branchName of branchNames) {
			// Merge into branch-here before deleting (issue #11)
			await this.advanceBranchHereFromMergeForward(branchName)

			this.core.info(`Deleting merge-forward branch: ${branchName}`)
			await this.shell.execQuietly(
				`git push origin --delete ${branchName}`)
		}
	}

	/**
	 * Advances branch-here by merging a completed merge-forward branch into it.
	 * This enables incremental advancement as each PR's chain completes (issue #11).
	 *
	 * @param {string} mergeForwardBranch - The merge-forward branch name
	 *   (e.g., 'merge-forward-pr-123-release-5-8-0')
	 */
	async advanceBranchHereFromMergeForward(mergeForwardBranch) {
		// Extract target branch from merge-forward name
		// Format: merge-forward-pr-{prNumber}-{normalizedTarget}
		const normalizedTarget = mergeForwardBranch.replace(
			/^merge-forward-pr-\d+-/, '')
		const targetBranch = this.denormalizeBranchName(normalizedTarget)

		// Skip terminal branch (no branch-here for main)
		if (targetBranch === this.terminalBranch) {
			return
		}

		const branchHere = MB_BRANCH_HERE_PREFIX + targetBranch
		this.core.info(
			`Advancing ${branchHere} from ${mergeForwardBranch}`)

		try {
			await this.shell.exec(`git checkout ${branchHere}`)
			await this.shell.exec(`git pull`)
			await this.shell.exec(
				`git merge origin/${mergeForwardBranch} --no-ff ` +
				`-m "Advance branch-here from completed merge-forward"`)
			await this.shell.exec(`git push origin ${branchHere}`)
		} catch (e) {
			// If merge fails, log and continue - don't block cleanup
			this.core.info(
				`Could not advance ${branchHere}: ${e.message}`)
		}
	}

	/**
	 * Converts a normalized branch name back to the actual branch name.
	 * E.g., "release-5-8-0" -> "release-5.8.0"
	 *
	 * @param {string} normalized - Normalized branch name
	 * @returns {string} Actual branch name
	 */
	denormalizeBranchName(normalized) {
		const branches = Object.keys(this.config.branches)
		for (const branch of branches) {
			if (branch.replace(/\./g, '-') === normalized) {
				return branch
			}
		}
		// Fallback: return as-is (e.g., for 'main')
		return normalized
	}

	/**
	 * Maintains branch-here pointers for all branches in the config.
	 */
	async maintainBranches() {
		const branches = Object.keys(this.config.branches)
		this.core.info(`branches: ${JSON.stringify(branches)}`)
		this.core.info(`terminal branch: ${this.terminalBranch}`)

		for (const branch of branches) {
			if (branch === this.terminalBranch) {
				this.core.info(`At terminal branch (${branch}), no maintenance required`)
				break
			}
			this.core.info(`Maintaining branch-here pointer for: ${branch}`)
			try {
				await this.shell.exec(`git checkout ${branch}`)
				await this.updateBranchHerePointer(branch)
			} catch (e) {
				this.core.error(e)
				throw e
			}
		}
	}

	/**
	 * Updates the branch-here pointer for a given branch.
	 *
	 * CRITICAL: Only advances branch-here if there are NO blocked commits from
	 * this branch. A commit is "blocked" if its merge-forward chain hasn't
	 * completed to main yet (indicated by merge-conflicts-* branches).
	 *
	 * If blocked commits exist, advancing branch-here would cause other
	 * developers to inherit those conflicts (the bug from issue #69842).
	 *
	 * @param {string} branch - The source branch being maintained
	 */
	async updateBranchHerePointer(branch) {
		// Check if there are any blocked merge-conflicts branches FROM this branch
		// Format: merge-conflicts-{issue}-pr-{pr}-{source}-to-{target}
		const normalizedBranch = branch.replace(/\./g, '-')
		const blockedBranches = await this.shell.exec(
			`git ls-remote --heads origin 'merge-conflicts-*-${normalizedBranch}-to-*'`)

		if (blockedBranches) {
			this.core.info(
				`Blocked commits exist from ${branch}, not advancing branch-here`)
			return
		}

		await this.fastForward(MB_BRANCH_HERE_PREFIX + branch, `origin/${branch}`)
	}

	/**
	 * Fast-forwards a branch to a new commit.
	 *
	 * @param {string} branch - The branch name to fast-forward
	 * @param {string} cleanMergePoint - The commit/ref to fast-forward to
	 */
	async fastForward(branch, cleanMergePoint) {
		const branchExists = await this.shell.exec(`git ls-remote --heads origin ${branch}`)
		if (branchExists) {
			await this.shell.exec(`git checkout ${branch}`)
			await this.shell.exec(`git pull`)
			await this.shell.exec(`git merge --ff-only ${cleanMergePoint}`)
		} else {
			await this.shell.exec(`git checkout -b ${branch} ${cleanMergePoint}`)
		}
		await this.shell.exec(`git push --set-upstream origin ${branch}`)
	}
}

module.exports = BranchMaintainer

