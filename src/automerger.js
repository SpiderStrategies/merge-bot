const { writeFile } = require('fs/promises')

const { findIssueNumber } = require('gh-action-components')
const IssueResolver = require('./issue-resolver')
const { UP_TO_DATE, MB_BRANCH_FAILED_PREFIX, MB_BRANCH_HERE_PREFIX, MB_BRANCH_FORWARD_PREFIX, ISSUE_COMMENT_FILENAME } = require('./constants')
const { extractPRFromMergeForward, extractTargetFromMergeForward } = require('./branch-name-utils')

/**
 * Handles automatic merging of pull requests forward through the release chain.
 *
 * See the original issue for more details/links:
 * https://github.com/SpiderStrategies/Scoreboard/issues/42921
*/
class AutoMerger {

	/**
	 * @param {Object} options
	 * @param {Object} options.pullRequest - The pull request from GitHub event
	 * @param {Object} options.repository - The repository from GitHub event
	 * @param {Object} options.config - The parsed merge-bot config
	 * @param {number} options.prNumber - Pull request number
	 * @param {string} options.prAuthor - GitHub username of the PR author
	 * @param {string} options.prTitle - Title of the pull request
	 * @param {string} options.prBranch - The head branch of the PR
	 * @param {string} options.baseBranch - The base branch the PR was merged into
	 * @param {string} options.prCommitSha - The SHA of the PR head commit
	 * @param {Object} options.core - The @actions/core module for logging and outputs
	 * @param {Object} options.shell - Shell instance for executing commands
	 * @param {Object} options.gh - GitHubClient instance for GitHub API
	 * @param {Object} options.git - Git instance for git operations
	 */
	constructor({
		pullRequest,
		repository,
		config,
		prNumber,
		prAuthor,
		prTitle,
		prBranch,
		baseBranch,
		prCommitSha,
		core,
		shell,
		gh,
		git
	}) {
		// Business data
		this.pullRequest = pullRequest
		this.repository = repository
		this.config = config
		this.prNumber = prNumber
		this.prAuthor = prAuthor
		this.prTitle = prTitle
		this.prBranch = prBranch
		this.baseBranch = baseBranch
		this.prCommitSha = prCommitSha

		// Infrastructure
		this.core = core
		this.shell = shell
		this.gh = gh
		this.git = git

		// Initialize URLs for status reporting
		const { serverUrl, runId, repo } = this.gh.github.context
		this.repoUrl = `${serverUrl}/${repo.owner}/${repo.repo}`
		this.actionUrl = `${this.repoUrl}/actions/runs/${runId}`

		// State that will be populated during execution
		this.terminalBranch = null
		this.issueNumber = null
		this.conflictBranch = null
		this.issueUrl = null
		this.statusMessage = null
		this.lastSuccessfulMergeRef = null
		this.lastSuccessfulBranch = null
	}

	async run() {
		if (!this.pullRequest.merged) {
			// There is no 'merged' activity type that can be specified in the workflow trigger.
			// So checking if the PR was merged here and aborting the action is the best we can do
			this.core.info('PR was closed without being merged, aborting...')
			return
		}

		await this.initializeState()

		if (!this.terminalBranch) {
			this.core.info('PR was against terminal branch, no merges required.')
			return
		}

		const commits = await this.gh.fetchCommits(this.prNumber)
		this.issueNumber = findIssueNumber(commits, this.pullRequest)

		await this.runMerges()
	}

	/**
	 * Checks if this PR was merged into a merge-forward branch.
	 * @returns {boolean} True if the base branch is a merge-forward branch
	 */
	isMergeForwardPR() {
		return this.baseBranch.startsWith(MB_BRANCH_FORWARD_PREFIX)
	}

	/**
	 * Calculates the remaining merge targets from a given starting point.
	 * @param {string} startBranch The branch to start from (exclusive)
	 * @returns {string[]} The remaining branches to merge into
	 */
	getRemainingMergeTargets(startBranch) {
		const allTargets = this.config.mergeTargets
		const startIndex = allTargets.indexOf(startBranch)

		if (startIndex === -1) {
			// Branch not found in targets, return all targets
			return allTargets
		}

		// Return everything after startBranch
		return allTargets.slice(startIndex + 1)
	}

	async runMerges() {
		const username = 'Spider Merge Bot'
		const userEmail = 'merge-bot@spiderstrategies.com'
		this.core.info(`Assigning git identity to ${username} <${userEmail}>`)
		await this.git.configureIdentity(username, userEmail)

		// Determine which branches to merge into
		let targets
		if (this.isMergeForwardPR()) {
			// Resume from where the conflict was resolved
			const targetBranch = extractTargetFromMergeForward(this.baseBranch)
			targets = this.getRemainingMergeTargets(targetBranch)
			this.core.info(`Resuming merge chain from ${targetBranch}, remaining targets: ${targets}`)
		} else {
			// Start normal merge chain
			targets = this.config.mergeTargets
		}

		// Attempt to merge each specified branch
		await this.executeMerges(targets)
	}


	/**
	 * Initializes state needed for merging.
	 */
	async initializeState() {
		const { merge_commit_sha } = this.pullRequest

		if (this.config && this.config.mergeTargets) {
			this.terminalBranch = this.config.mergeTargets[this.config.mergeTargets.length - 1]
			this.core.info(`mergeTargets: ${JSON.stringify(this.config.mergeTargets)}`)
			this.core.info(`terminal branch: ${this.terminalBranch}`)
		}

		// Initialize merge chain tracking to the PR commit and base branch
		this.lastSuccessfulMergeRef = this.prCommitSha
		this.lastSuccessfulBranch = this.baseBranch

		const trimmedMessage = await this.shell.exec(`git show -s --format=%B ${merge_commit_sha}`)
		this.core.info(`PR title: ${this.prTitle}`)
		this.core.info(`trimmedMessage: ${trimmedMessage}`)
	}


	async executeMerges(mergeTargets) {
		const targetMergeCount = mergeTargets.length
		this.core.info(`Merge Targets: ${mergeTargets}`)

		// Track branches we successfully merge into for later updates
		const mergedBranches = []

		let mergeCount = 0
		for (; mergeCount < targetMergeCount; mergeCount++) {
			const branch = mergeTargets[mergeCount]
			this.core.startGroup(`Merging into ${branch}...`)

			await this.git.checkout(branch)
			try {
				if (!await this.merge({ branch })) {
					break
				}
				mergedBranches.push(branch)
			} catch (e) {
				this.core.error(e.message)
				this.core.setFailed(e.message)
				break
			} finally {
				this.core.endGroup()
			}
		}
		const allMergesPassed = mergeCount === targetMergeCount

		if (allMergesPassed) {
			this.core.info('All merges are complete')
			await this.updateTargetBranches(mergedBranches)
			await this.git.deleteBranch(this.prBranch)
		} else if (this.conflictBranch) {
			this.generateMergeConflictNotice()
		}
		return allMergesPassed
	}

	/**
	 * Updates target branches (release branches and main) to match their
	 * merge-forward commits after a successful merge chain completion.
	 *
	 * This method finds ALL merge-forward branches for this PR (not just the
	 * ones merged in this invocation) to handle the case where the chain was
	 * interrupted by conflicts and resumed in a subsequent action invocation.
	 *
	 * @param {string[]} mergedBranches - Branches merged in this invocation
	 *   (unused, kept for compatibility)
	 */
	async updateTargetBranches(mergedBranches) {
		const prNumber = this.isMergeForwardPR()
			? extractPRFromMergeForward(this.baseBranch)
			: this.prNumber
		const branchNames = await this.findMergeForwardBranches(prNumber)

		if (branchNames.length === 0) {
			this.core.info('No merge-forward branches found')
			return
		}

		this.core.info(`Found merge-forward branches: ${branchNames}`)

		for (const mergeForwardBranch of branchNames) {
			const targetBranch = extractTargetFromMergeForward(mergeForwardBranch)

			await this.updateTargetBranch(mergeForwardBranch, targetBranch)
		}
	}

	/**
	 * Finds all merge-forward branches for a given PR number by querying remote.
	 *
	 * @param {string} prNumber - The PR number to search for
	 * @returns {Promise<string[]>} Array of merge-forward branch names (e.g., ['merge-forward-pr-123-release-5.8.0'])
	 */
	async findMergeForwardBranches(prNumber) {
		this.core.info(`Finding all merge-forward branches for PR #${prNumber}`)

		const mergeForwardPattern = `${MB_BRANCH_FORWARD_PREFIX}${prNumber}-`
		const remoteBranches = await this.shell.exec(`git ls-remote --heads origin '${mergeForwardPattern}*'`)

		if (!remoteBranches) {
			return []
		}

		const branchNames = remoteBranches.split('\n')
			.filter(line => line.trim())
			.map(line => {
				const parts = line.split('\t')
				return parts.length > 1 ? parts[1] : null
			})
			.filter(ref => ref !== null)
			.map(ref => ref.replace('refs/heads/', ''))

		return branchNames
	}

	/**
	 * Updates a single target branch to match its merge-forward commit.
	 * Attempts fast-forward first, falls back to merge commit if needed.
	 *
	 * @param {string} mergeForwardBranch - The merge-forward branch name
	 *   (e.g., 'merge-forward-pr-123-release-5.8.0' or 'merge-forward-pr-123-main')
	 * @param {string} targetBranch - The target branch to update
	 *   (e.g., 'release-5.8.0' or 'main')
	 */
	async updateTargetBranch(mergeForwardBranch, targetBranch) {
		this.core.info(`Fast-forwarding ${targetBranch} to ${mergeForwardBranch}`)
		await this.git.checkout(targetBranch)

		const mergeForwardCommit = await this.shell.exec(`git rev-parse origin/${mergeForwardBranch}`)

		try {
			await this.git.merge(mergeForwardCommit, '--ff-only')
			this.core.info(`Fast-forwarded ${targetBranch}`)
		} catch (e) {
			this.core.info(`Fast-forward failed, creating merge commit for ${targetBranch}`)
			await this.git.merge(mergeForwardCommit, '--no-ff')
		}

		await this.git.push(`origin ${targetBranch}`)
	}

	/**
	 * Logs a notice about the merge conflict that was detected and handled.
	 * This is NOT a warning - merge conflicts are expected behavior.
	 * An issue has been created for the developer to resolve.
	 * The status message is formatted for Slack and included in notifications.
	 */
	generateMergeConflictNotice() {
		// Slack is "special" https://api.slack.com/reference/surfaces/formatting#linking-urls
		this.statusMessage = `<${this.repoUrl}/issues/${this.prNumber}|PR #${this.prNumber}> ` +
			`<${this.issueUrl}|Issue> ` +
			`<${this.actionUrl}|Action Run>`
		this.core.info(`Merge conflict detected and issue created: ${this.statusMessage}`)
	}

	/**
	 * Attempts the merge the PR branch into [branch]
	 *
	 * @returns {Promise<Boolean>} Whether or not to continue merging into
	 *     other branches true if the merge was successful or skipped false if
	 *     there were conflicts
	 */
	async merge({
		branch,
		// Use "no fastforward" flag to make sure there are always changes to commit;
		// otherwise, this will break when a new release branch has been created, but
		// is still identical to the previous release branch. Example:
		// https://github.com/SpiderStrategies/Scoreboard/actions/runs/19943416287/job/57186800013
		options = '--no-commit --no-ff'
	}) {
		// Create merge-forward based on the TARGET's branch-here, not the PR's progress.
		// This ensures we merge FORWARD (few commits) not backward (thousands).
		// The merge direction is: PR changes -> into -> target branch
		const currentMergeForward = this.createMergeForwardBranchName(branch)
		const targetRef = this.getBranchHereRef(branch)
		await this.git.createBranch(currentMergeForward, `origin/${targetRef}`)
		await this.git.push(`--force origin ${currentMergeForward}`)

		// Switch to the merge-forward branch to perform the merge there
		await this.git.checkout(currentMergeForward)

		// Merge the PR's progress (lastSuccessfulMergeRef) INTO the target-based branch.
		// This is the forward direction: few PR commits merged into the target.
		const commitMessage = `auto-merge of ${this.lastSuccessfulMergeRef} into \`${branch}\` from \`${this.prBranch}\` ` +
			`triggered by (#${this.prNumber}) on \`${this.baseBranch}\``

		this.core.info(commitMessage)

		let mergeResult
		try {
			await this.git.pull() // Try to minimize chances of repo being out of date with origin (because of concurrent actions)
			mergeResult = await this.git.merge(this.lastSuccessfulMergeRef, options)
			this.core.info(mergeResult)
		} catch (e) {
			await this.handleConflicts(branch)
			return false
		}

		// Already merged into this branch (not expected, but lets handle it (and just skip over))
		const alreadyMerged = mergeResult.includes(UP_TO_DATE)
		if (!alreadyMerged) {
			const commits = await this.gh.fetchCommits(this.prNumber)
			const lastCommit = commits.data.map(c => c.commit).pop()
			await this.git.commit(commitMessage, lastCommit.author)

			// Update tracking to point to the new merge commit and branch
			this.lastSuccessfulMergeRef = await this.shell.exec('git rev-parse HEAD')
			this.lastSuccessfulBranch = branch

			// Push the merge-forward branch with the new commit
			// (We're already on it after checkout + commit, so just push)
			const mergeForwardBranch = this.createMergeForwardBranchName(branch)
			await this.git.push(`--force origin ${mergeForwardBranch}`)
		}
		return true
	}

	async handleConflicts(branch) {
		const conflicts = await this.shell.exec('git diff --name-only --diff-filter=U')
		if (conflicts.length > 0) {
			console.log('Conflicts found:\n', conflicts)
			this.conflictBranch = branch

			// Create issue first to get the issue number, then create the branch
			// We'll use a placeholder in the branch name template, then recreate it with the actual issue number
			const newIssueNumber = await this.createIssue({ branch, conflicts })
			await this.git.reset(branch, '--hard') // must wipe out any local changes from merge

			// Create merge-conflicts based on branch-here (the target), not the PR's progress.
			// Developer merges the previous merge-forward INTO merge-conflicts.
			// This pulls just the PR's few commits forward, not thousands backward.
			const encodedBranchName = this.createMergeConflictsBranchName(
				newIssueNumber, this.lastSuccessfulBranch, branch)
			await this.git.createBranch(encodedBranchName, this.getBranchHereRef(branch))
			await this.git.push(`origin ${encodedBranchName}`)

			// Note: merge-forward branch for the target was already created by merge()
			// at the start of the merge attempt, so we don't create it here.

			await new IssueResolver({
				prNumber: this.prNumber,
				core: this.core,
				shell: this.shell,
				gh: this.gh
			}).resolveIssues()
		}
	}

	/**
	 * Creates a merge-conflicts branch name that encodes the PR, source, and target branches
	 * Format: merge-conflicts-{issueNumber}-pr-{prNumber}-{sourceBranch}-to-{targetBranch}
	 * Example: merge-conflicts-68586-pr-123-release-5.8.0-to-main
	 */
	createMergeConflictsBranchName(issueNumber, sourceBranch, targetBranch) {
		return `${MB_BRANCH_FAILED_PREFIX}${issueNumber}-pr-${this.prNumber}-${sourceBranch}-to-${targetBranch}`
	}

	/**
	 * Creates a merge-forward branch name for tracking this PR's isolated merge chain
	 * Format: merge-forward-pr-{prNumber}-{targetBranch}
	 * Example: merge-forward-pr-123-release-5.8.0
	 */
	createMergeForwardBranchName(targetBranch) {
		return `${MB_BRANCH_FORWARD_PREFIX}${this.prNumber}-${targetBranch}`
	}

	/**
	 * Gets the appropriate ref for a branch, handling the terminal branch case.
	 * Terminal branch (main) doesn't have a branch-here pointer, so use branch directly.
	 * Other branches use their branch-here pointer.
	 *
	 * @param {string} branch - The target branch name
	 * @returns {string} Either the branch name itself (for terminal) or branch-here-{branch}
	 */
	getBranchHereRef(branch) {
		return branch === this.terminalBranch ? branch : `${MB_BRANCH_HERE_PREFIX}${branch}`
	}

	async createIssue({ branch, conflicts }) {
		const issueNumber = this.issueNumber
		const branchObj = this.config.branches[branch] || {}
		const title = `Merge${issueNumber ? ' #' + issueNumber : ''} (${this.prCommitSha.substring(0, 9)}) into ${branch}`

		// https://docs.github.com/en/rest/issues/issues#create-an-issue
		const newIssueResponse = await this.gh.createIssue({
			title,
			milestone: branchObj.milestoneNumber,
			labels: ['highest priority', 'merge conflict']
		})

		const { number: conflictIssueNumber, html_url } = newIssueResponse.data

		// Create the merge-conflicts branch name that users will checkout
		// Use lastSuccessfulBranch (immediate predecessor) not baseBranch (original PR base)
		const conflictBranchName = this.createMergeConflictsBranchName(
			conflictIssueNumber, this.lastSuccessfulBranch, branch)

		// Have to write comment and update after issue is created because
		// we need to reference the issue number in the comment
		const bodyFile = await this.writeComment({
			branch,
			issueNumber,
			conflicts,
			conflictIssueNumber,
			conflictBranchName
		})
		await this.shell.exec(`gh issue edit ${conflictIssueNumber} --body-file ${bodyFile} --add-assignee "${this.prAuthor}"`)

		this.issueUrl = html_url
		this.core.info(`Created issue: ${html_url}`)

		return conflictIssueNumber
	}

	/**
	 * Writes the comment to a file so we don't have to worry about quotes in bash
	 *
	 * @param {String} branch The name of the branch that has conflicts with the PR merge commit.
	 *
	 * @param {String} issueNumber The issue number the PR is resolving
	 *
	 * @param {String} conflicts A list of conflicting files separated by \n
	 *
	 * @param {String} conflictIssueNumber The issue number of the new issue
	 * created for the PR author to resolve the conflicts.  This is the number
	 * used for the `merge-conflicts-` branch so we can delete it when the issue
	 * is closed.
	 *
	 * @param {String} conflictBranchName The name of the merge-conflicts branch
	 * that was created automatically and points to the conflicting commit.
	 *
	 * @returns {Promise<string>}
	 */
	async writeComment({ branch, issueNumber, conflicts, conflictIssueNumber, conflictBranchName }) {
		const issueText = issueNumber ? `for issue #${issueNumber}` : ''
		const mergeForwardBranch = this.createMergeForwardBranchName(branch)

		// Developer merges the previous step's changes INTO merge-conflicts.
		// This pulls the PR's few commits forward, not thousands from the target.
		//
		// If the conflict is at the first merge target (lastSuccessfulBranch == baseBranch),
		// there is no prior merge-forward branch - we merge the PR commit directly.
		// Otherwise, we merge the previous merge-forward branch.
		const isFirstTarget = this.lastSuccessfulBranch === this.baseBranch
		const previousMergeForward = this.createMergeForwardBranchName(this.lastSuccessfulBranch)
		const mergeRef = isFirstTarget ? this.prCommitSha : `origin/${previousMergeForward}`
		const mergeRefDisplay = isFirstTarget ? this.prCommitSha : previousMergeForward

		let lines = [`## Automatic Merge Failed`,
			`@${this.prAuthor} changes from pull request #${this.prNumber} ${issueText} couldn't be [merged forward automatically](${this.actionUrl}). `,
			`Please submit a new pull request against the \`${mergeForwardBranch}\` branch that includes the changes. `,
			`The sooner you have a chance to do this the fewer conflicts you'll run into, so you may want to tackle this soon.`,
			'### Details',
			'Run these commands to perform the merge, then open a new pull request against the `' + mergeForwardBranch + '` branch.',
			'1. `git fetch`',
			`1. \`git checkout ${conflictBranchName}\``,
			`1. \`git merge ${mergeRef} -m "Merge ${mergeRefDisplay} Fixes #${conflictIssueNumber}"\``,
			`1. \`git push\``,
			`1. \`createPR -b ${mergeForwardBranch}\` (Optional; requires [Spider Shell](https://github.com/SpiderStrategies/spider-shell))`,
			'',
			'#### There were conflicts in these files:',
			conflicts.split('\n').map(c => `- ${c}`).join('\n') + '\n'
		]

		await writeFile(ISSUE_COMMENT_FILENAME, lines.join('\n'))
		return ISSUE_COMMENT_FILENAME
	}

}

module.exports = AutoMerger
