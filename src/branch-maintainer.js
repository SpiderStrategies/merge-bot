const { MB_BRANCH_FAILED_PREFIX, MB_BRANCH_HERE_PREFIX, MB_BRANCH_FORWARD_PREFIX } = require('./constants')
const {
	extractOriginalPRNumber,
	extractPRFromMergeForward,
	extractTargetFromMergeForward
} = require('./branch-name-utils')
const pushWithRetry = require('./push-with-retry')

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
	 * Main entry point - orchestrates branch maintenance:
	 * 1. Delete merge-conflicts branches when conflict PRs are merged
	 * 2. Skip the rest when the base isn't a configured branch
	 * 3. Maintain branch-here pointers (only if commits reached main)
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

		// #72734 - The workflow fires for every closed PR, but
		// branch-here maintenance only makes sense when the base is
		// a configured release branch or a merge-forward branch
		// (the legitimate conflict-resolution target). Without this
		// guard, a PR merged into a stray feature branch crashes
		// the maintainer trying to advance `branch-here-<feature>`.
		const baseRef = this.pullRequest.base.ref
		const isConfiguredBase = baseRef in this.config.branches
		const isMergeForwardBase =
			baseRef.startsWith(MB_BRANCH_FORWARD_PREFIX)
		if (!isConfiguredBase && !isMergeForwardBase) {
			this.core.info(
				`Skipping branch maintenance: base '${baseRef}'` +
				` is not a configured branch`)
			return
		}

		await this.maintainBranchHere({ automergeConflictBranch })
	}

	/**
	 * Cleans up merge-forward branches and advances branch-here
	 * pointers when commits successfully reached the terminal branch.
	 *
	 * CRITICAL: Only advances branch-here when commits have merged ALL THE
	 * WAY to main. This ensures branch-here branches only include commits
	 * that have successfully merged through the entire release chain,
	 * preventing users from inheriting conflicts from earlier in the chain.
	 *
	 * @param {Object} options
	 * @param {string} [options.automergeConflictBranch] - The branch where
	 *   automerge encountered conflicts (undefined if automerge succeeded)
	 */
	async maintainBranchHere({ automergeConflictBranch }) {
		// Determine if commits reached the terminal branch. A
		// merge-conflicts PR's merge implies the chain completed
		// (AutoMerger ran first and drove remaining hops; if it
		// had hit another conflict, automergeConflictBranch would
		// be set).
		const isTerminalBranch = this.pullRequest.base.ref === this.terminalBranch
		const automergeSucceeded = !automergeConflictBranch
		const mergeConflictsPRCompleted = this.isMergeConflictsPR() && automergeSucceeded
		const commitsReachedMain = !isTerminalBranch && automergeSucceeded && !mergeConflictsPRCompleted
		const shouldCleanup = commitsReachedMain || mergeConflictsPRCompleted

		if (shouldCleanup) {
			this.core.info(`Running branch maintenance: commits reached main`)
			await this.cleanupMergeForwardBranches()

			// #71406 - When merging from the last release branch into
			// main, branch-here for that release branch is never
			// advanced (main has no branch-here). Advance it here
			// with the PR's head commit. For merge-conflicts PRs
			// the "release branch" must be recovered from the
			// merge-conflicts branch name - base.ref is typically
			// a merge-forward branch, not a release branch.
			if (mergeConflictsPRCompleted) {
				await this.advanceBranchHereAfterConflictResolution()
			} else if (commitsReachedMain) {
				await this.advanceBranchHereAfterReleaseMerge()
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
			throw new Error(
				`Cannot advance branch-here for` +
				` '${releaseBranch}': PR is missing` +
				` head SHA`)
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
	 * resolution PR, not the original. Asks GitHub for the
	 * original PR's base branch and head SHA.
	 *
	 * #74973 - The merge-conflicts branch name encodes the hop
	 * that conflicted, not the branch the work started on, so
	 * it cannot supply the base. That base is the one
	 * branch-here the merge-forward cleanup never reaches: it
	 * has no merge-forward branch of its own.
	 */
	async advanceBranchHereAfterConflictResolution() {
		const prNumber = extractOriginalPRNumber({
			baseRef: this.pullRequest.base?.ref,
			headRef: this.pullRequest.head?.ref,
			prNumber: this.pullRequest.number
		})

		const { baseRefName: releaseBranch, headRefOid: mergeRef } =
			await this.fetchOriginalPR(prNumber)

		// The terminal branch has no branch-here pointer
		if (releaseBranch === this.terminalBranch) {
			return
		}

		// A release line that left the config is one nobody
		// branches from, so leaving its pointer behind blocks
		// no one - warn instead of failing the run.
		if (!(releaseBranch in this.config.branches)) {
			this.core.warning(
				`Not advancing branch-here: PR #${prNumber}` +
				` was based on '${releaseBranch}', which is` +
				` not a configured branch. Check whether that` +
				` PR should have merged forward at all`)
			return
		}

		await this.advanceBranchHere({
			releaseBranch, mergeRef, prNumber
		})
	}

	/**
	 * Reads the base branch and head SHA of the pull request that
	 * started this merge chain, which is not the one that
	 * triggered this run.
	 *
	 * #74973 - Throws rather than skipping. Developers must
	 * branch from branch-here, so a pointer left behind blocks
	 * every later PR on that release line until someone
	 * advances it by hand - and nobody will know to unless this
	 * run goes red.
	 *
	 * @param {string|number} prNumber - The PR to read
	 * @returns {Promise<Object>} The PR's baseRefName and headRefOid
	 */
	async fetchOriginalPR(prNumber) {
		const repair =
			`Advance ${MB_BRANCH_HERE_PREFIX}<base branch> to the` +
			` head of PR #${prNumber} by hand; until then` +
			` developers cannot branch from it`

		let originalPR
		try {
			originalPR = JSON.parse(await this.shell.exec(
				`gh pr view ${prNumber}` +
				` --json baseRefName,headRefOid`))
		} catch (e) {
			throw new Error(
				`Cannot advance branch-here: PR #${prNumber}` +
				` could not be read (${e.message}). ${repair}`)
		}

		if (!originalPR.baseRefName || !originalPR.headRefOid) {
			throw new Error(
				`Cannot advance branch-here: PR #${prNumber}` +
				` reported no base branch or head SHA.` +
				` ${repair}`)
		}

		return originalPR
	}

	/**
	 * Advances branch-here for a release branch by merging mergeRef
	 * into it, then merges branch-here back into the release branch
	 * to preserve ancestry (issue #19).
	 *
	 * The ancestry merge is critical: without it, branch-here would
	 * have a merge commit that doesn't exist on the release branch,
	 * causing them to diverge.
	 *
	 * Both pushes go through pushWithRetry because a concurrent
	 * merge-bot run can advance either branch while we work (#74377).
	 */
	async advanceBranchHere({ releaseBranch, mergeRef, prNumber }) {
		if (!(releaseBranch in this.config.branches)) {
			throw new Error(
				`Cannot advance branch-here: '${releaseBranch}'` +
				` is not a configured branch (PR #${prNumber}).` +
				` ${MB_BRANCH_HERE_PREFIX}${releaseBranch} was` +
				` not advanced to ${mergeRef}`)
		}

		const branchHere = MB_BRANCH_HERE_PREFIX + releaseBranch
		this.core.info(
			`Advancing ${branchHere} with PR #${prNumber}`)

		await pushWithRetry({
			shell: this.shell,
			core: this.core,
			branch: branchHere,
			merge: () => this.shell.exec(
				`git merge ${mergeRef} --no-ff ` +
				`-m "Merge #${prNumber} into ${branchHere}"`)
		})

		// Issue #19 - Preserve ancestry
		await pushWithRetry({
			shell: this.shell,
			core: this.core,
			branch: releaseBranch,
			merge: () => this.shell.exec(
				`git merge ${branchHere} --no-ff ` +
				`-m "Merge #${prNumber} from ${branchHere}` +
				` to ${releaseBranch}"`)
		})
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

		await pushWithRetry({
			shell: this.shell,
			core: this.core,
			branch: targetBranch,
			merge: () => this.shell.exec(
				`git merge origin/${mergeForwardBranch} --no-ff ` +
				`-m "Merge ${mergeForwardBranch} into ` +
				`${targetBranch}"`)
		})
	}

}

module.exports = BranchMaintainer
