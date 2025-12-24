const { MB_BRANCH_FAILED_PREFIX, MB_BRANCH_HERE_PREFIX } = require('./constants')
const findCleanMergeRef = require('./find-clean-merge-ref')

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
		const automergeSucceeded = automergeConflictBranch === undefined
		const commitsReachedMain = !isTerminalBranch && automergeSucceeded

		if (commitsReachedMain) {
			this.core.info(`Running branch maintenance: commits reached main (isTerminalBranch=${isTerminalBranch}, automergeSucceeded=${automergeSucceeded})`)
			await this.maintainBranches()
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
	 * Cleans up the merge-conflicts branch associated with a closed PR, if applicable.
	 * Only acts on PRs that came from merge-conflicts branches. The issue number
	 * is extracted directly from the branch name (e.g., merge-conflicts-12345).
	 */
	async cleanupMergeConflictsBranch() {
		const match = /^merge-conflicts-(\d+)/
			.exec(this.pullRequest.head.ref ?? '')
		if (match) {
			const issue = match[1]
			await this.shell.execQuietly(
				`git push origin --delete ${MB_BRANCH_FAILED_PREFIX}${issue}`)
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
			this.core.info(`\nMaintaining branch-here pointers for branch: ${branch}\n===============================================\n`)
			try {
				await this.shell.exec( `git checkout ${branch}`)
				const downstreamChain = buildDownstreamBranchChain(this.config.mergeOperations, branch)
				this.core.info(`Checking for conflicts from ${branch} through chain: ${downstreamChain.join(' -> ')}`)

				const targetBranch = this.config.mergeOperations?.[branch]
				await this.updateBranchHerePointer(branch, targetBranch, downstreamChain)
			} catch (e) {
				this.core.error(e)
				throw e
			}
		}
	}

	/**
	 * Updates the branch-here pointer for a given branch by finding a clean
	 * merge point and fast-forwarding to it. If no clean merge point is found,
	 * the branch-here pointer is left unchanged.
	 *
	 * @param {string} branch - The source branch being maintained
	 * @param {string} targetBranch - The immediate target branch for this merge
	 * @param {Array<string>} downstreamChain - The full chain of downstream branches
	 *   to check for conflicts
	 */
	async updateBranchHerePointer(branch, targetBranch, downstreamChain) {
		const cleanMergePoint = await findCleanMergeRef({
			branch,
			targetBranch,
			allBranchesInChain: downstreamChain,
			core: this.core,
			shell: this.shell
		})
		if (cleanMergePoint) {
			await this.fastForward(MB_BRANCH_HERE_PREFIX + branch, cleanMergePoint)
		} else {
			this.core.info(`No clean merge point found for ${branch}, branch-here cannot be advanced`)
		}
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

/**
 * Builds the chain of downstream branches from a starting branch to the
 * terminal branch. This chain is used to check for conflicts at all points
 * in the merge path.
 *
 * @param {Object} mergeOperations - Map of branch -> targetBranch
 * @param {string} startBranch - The branch to start building the chain from
 * @returns {Array<string>} An ordered array of branch names representing
 *   the downstream merge path (e.g., ['release/23.12', 'release/24.01', 'main'])
 */
function buildDownstreamBranchChain(mergeOperations, startBranch) {
	const chain = []
	let currentBranch = startBranch
	while (mergeOperations[currentBranch]) {
		const nextBranch = mergeOperations[currentBranch]
		chain.push(nextBranch)
		currentBranch = nextBranch
	}
	return chain
}

module.exports = BranchMaintainer
module.exports.buildDownstreamBranchChain = buildDownstreamBranchChain

