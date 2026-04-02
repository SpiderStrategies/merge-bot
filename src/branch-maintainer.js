const { MB_BRANCH_FAILED_PREFIX, MB_BRANCH_HERE_PREFIX, MB_BRANCH_FORWARD_PREFIX } = require('./constants')
const {
	extractOriginalPRNumber,
	extractPRFromMergeForward,
	extractSourceFromMergeConflicts,
	extractTargetFromMergeForward
} = require('./branch-name-utils')

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
			await this.cleanupMergeForwardBranches()

			// #71406 - When merging from the last release branch into
			// main, branch-here for that release branch is never
			// advanced (main has no branch-here). Advance it here
			// with the PR's head commit.
			if (commitsReachedMain) {
				await this.advanceBranchHereAfterReleaseMerge()
			} else if (mergeConflictsPRCompleted) {
				await this.advanceBranchHereAfterConflictResolution()
			}
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
	 * Cleans up all merge-forward branches for this PR's merge chain.
	 * Uses extractOriginalPRNumber to trace back through conflict
	 * resolution chains to the original PR.
	 */
	async cleanupMergeForwardBranches() {
		const prNumber = extractOriginalPRNumber({
			baseRef: this.pullRequest.base?.ref,
			headRef: this.pullRequest.head?.ref,
			prNumber: this.pullRequest.number
		})
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
	 * Advances branch-here by merging a completed merge-forward branch
	 * into it, then merges branch-here into the release branch to
	 * preserve the ancestry relationship (issue #19).
	 *
	 * The second merge is critical: without it, branch-here would have
	 * a merge commit that doesn't exist on the release branch, causing
	 * them to diverge. By merging branch-here into the release branch
	 * afterward, branch-here remains an ancestor of the release branch.
	 * This merge is always content-neutral since the release branch
	 * already has the merge-forward content via updateTargetBranch.
	 *
	 * @param {string} mergeForwardBranch - The merge-forward branch name
	 *   (e.g., 'merge-forward-pr-123-release-5.8.0')
	 */
	async advanceBranchHereFromMergeForward(mergeForwardBranch) {
		const targetBranch =
			extractTargetFromMergeForward(mergeForwardBranch)

		// Issue #43 - Terminal branch has no branch-here pointer,
		// but still needs the merge-forward content. Without this,
		// resolved conflicts at the last hop never reach main.
		if (targetBranch === this.terminalBranch) {
			return this.mergeToTerminalBranch(
				mergeForwardBranch, targetBranch)
		}

		const prNumber = extractPRFromMergeForward(mergeForwardBranch)
		await this.advanceBranchHere({
			releaseBranch: targetBranch,
			mergeRef: `origin/${mergeForwardBranch}`,
			prNumber
		})
	}

	/**
	 * #71406 - Advances branch-here for the release branch the PR
	 * was merged into. When merging from the last release branch
	 * into main, that release branch's branch-here is missed
	 * because main has no branch-here.
	 */
	async advanceBranchHereAfterReleaseMerge() {
		const releaseBranch = this.pullRequest.base.ref
		if (releaseBranch === this.terminalBranch) {
			return
		}

		const mergeRef = this.pullRequest.head?.sha
		if (!mergeRef) {
			return
		}

		await this.advanceBranchHere({
			releaseBranch,
			mergeRef,
			prNumber: this.pullRequest.number
		})
	}

	/**
	 * Same as advanceBranchHereAfterReleaseMerge, but for the
	 * conflict-resolution path where this.pullRequest is the
	 * resolution PR (base: main), not the original. Recovers the
	 * original PR's release branch from the merge-conflicts branch
	 * name and its head SHA from the GitHub API.
	 */
	async advanceBranchHereAfterConflictResolution() {
		const headRef = this.pullRequest.head?.ref ?? ''
		const releaseBranch =
			extractSourceFromMergeConflicts(headRef)
		if (!releaseBranch ||
				releaseBranch === this.terminalBranch) {
			return
		}

		const prNumber = extractOriginalPRNumber({
			baseRef: this.pullRequest.base?.ref,
			headRef,
			prNumber: this.pullRequest.number
		})
		const branchHere = MB_BRANCH_HERE_PREFIX + releaseBranch

		let mergeRef
		try {
			mergeRef = await this.shell.exec(
				`gh pr view ${prNumber}` +
				` --json headRefOid --jq '.headRefOid'`)
		} catch (e) {
			this.core.info(
				`Could not fetch head SHA for PR` +
				` #${prNumber}, skipping` +
				` ${branchHere} advancement`)
			return
		}
		if (!mergeRef) {
			return
		}

		await this.advanceBranchHere({
			releaseBranch, mergeRef, prNumber
		})
	}

	/**
	 * Advances branch-here for a release branch by merging mergeRef
	 * into it, then merges branch-here back into the release branch
	 * to preserve ancestry (issue #19).
	 *
	 * The ancestry merge is critical: without it, branch-here would
	 * have a merge commit that doesn't exist on the release branch,
	 * causing them to diverge.
	 */
	async advanceBranchHere({ releaseBranch, mergeRef, prNumber }) {
		const branchHere = MB_BRANCH_HERE_PREFIX + releaseBranch
		this.core.info(
			`Advancing ${branchHere} with PR #${prNumber}`)

		await this.shell.exec(`git checkout ${branchHere}`)
		await this.shell.exec(`git pull`)
		await this.shell.exec(
			`git merge ${mergeRef} --no-ff ` +
			`-m "Merge #${prNumber} into ${branchHere}"`)
		await this.shell.exec(`git push origin ${branchHere}`)

		// Issue #19 - Preserve ancestry
		await this.shell.exec(`git checkout ${releaseBranch}`)
		await this.shell.exec(`git pull`)
		await this.shell.exec(
			`git merge ${branchHere} --no-ff ` +
			`-m "Merge #${prNumber} from ${branchHere}` +
			` to ${releaseBranch}"`)
		await this.shell.exec(`git push origin ${releaseBranch}`)
	}

	/**
	 * Merges a merge-forward branch into the terminal branch.
	 *
	 * In the happy path (no conflicts), AutoMerger.updateTargetBranch
	 * handles this. But when conflicts occur at the terminal branch,
	 * the automerger exits early and this method fills the gap.
	 *
	 * Always creates a merge commit (--no-ff) because other PRs may
	 * have merged into main while the developer was resolving
	 * conflicts (making fast-forward impossible).
	 */
	async mergeToTerminalBranch(mergeForwardBranch, targetBranch) {
		this.core.info(
			`Updating ${targetBranch} from ${mergeForwardBranch}`)

		await this.shell.exec(`git checkout ${targetBranch}`)
		await this.shell.exec(`git pull`)
		await this.shell.exec(
			`git merge origin/${mergeForwardBranch} --no-ff ` +
			`-m "Merge ${mergeForwardBranch} into ` +
			`${targetBranch}"`)
		await this.shell.exec(`git push origin ${targetBranch}`)
	}

}

module.exports = BranchMaintainer
