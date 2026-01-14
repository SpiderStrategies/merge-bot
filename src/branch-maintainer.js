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
	 *
	 * The PR number depends on what kind of PR this is:
	 * 1. Resolution PR to merge-forward branch: parse from base branch name
	 * 2. merge-conflicts PR: look up issue to find original PR
	 * 3. Normal PR: use current PR number
	 */
	async determineOriginalPRNumber() {
		const baseRef = this.pullRequest.base.ref ?? ''
		const headRef = this.pullRequest.head.ref ?? ''

		// Case 1: PR merged to merge-forward branch - parse PR number from branch name
		const mfMatch = /^merge-forward-pr-(\d+)-/.exec(baseRef)
		if (mfMatch) {
			return mfMatch[1]
		}

		// Case 2: merge-conflicts PR - look up issue to find original PR
		const mcMatch = /^merge-conflicts-(\d+)/.exec(headRef)
		if (mcMatch) {
			try {
				const body = await this.shell.exec(
					`gh issue view ${mcMatch[1]} --json body -q .body`)
				const prMatch = /pull request #(\d+)/.exec(body)
				if (prMatch) {
					this.core.info(`Found original PR #${prMatch[1]} from issue #${mcMatch[1]}`)
					return prMatch[1]
				}
				this.core.info(`Could not find original PR in issue #${mcMatch[1]}`)
			} catch (e) {
				this.core.info(`Error looking up issue #${mcMatch[1]}: ${e.message}`)
			}
			return null
		}

		// Case 3: Normal PR - use current PR number
		return this.pullRequest.number
	}

	/**
	 * Cleans up all merge-forward branches for this PR's merge chain.
	 * Uses determineOriginalPRNumber() to handle resolution PRs correctly.
	 */
	async cleanupMergeForwardBranches() {
		const prNumber = await this.determineOriginalPRNumber()
		if (prNumber) {
			await this.cleanupMergeForwardBranchesForPR(prNumber)
		}
	}

	/**
	 * Deletes all merge-forward branches for a given PR number.
	 * Deletes all branches matching the pattern: merge-forward-pr-{prNumber}-*
	 *
	 * @param {string|number} prNumber - The PR number whose merge-forward branches to delete
	 */
	async cleanupMergeForwardBranchesForPR(prNumber) {
		const pattern = `${MB_BRANCH_FORWARD_PREFIX}${prNumber}-`

		const branches = await this.shell.exec(
			`git ls-remote --heads origin ${pattern}*`)

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
			this.core.info(`Deleting merge-forward branch: ${branchName}`)
			await this.shell.execQuietly(
				`git push origin --delete ${branchName}`)
		}
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
	 * Updates the branch-here pointer for a given branch by fast-forwarding
	 * it to the release branch tip.
	 *
	 * In the merge-forward architecture (issue #3), we always advance to the
	 * branch tip. Conflicts are isolated in merge-forward chains, not release
	 * branches, so branch-here stays much more up-to-date.
	 *
	 * @param {string} branch - The source branch being maintained
	 */
	async updateBranchHerePointer(branch) {
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

