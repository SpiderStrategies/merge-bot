const { writeFile } = require('fs/promises')

const { findIssueNumber, configReader, BaseAction } = require('gh-action-components')
const IssueResolver = require('./issue-resolver')
const { UP_TO_DATE, MB_BRANCH_FAILED_PREFIX, MB_BRANCH_HERE_PREFIX } = require('./constants')

/**
 * Invoked by the spider-merge-bot.yml GitHub Action Workflow
 * Runs with the node version shipped with `ubuntu-latest`
 *
 * See the original issue for more details/links:
 * https://github.com/SpiderStrategies/Scoreboard/issues/42921
*/
class AutoMergeAction extends BaseAction {


	constructor(options = {}) {
		super()
		this.options = options
		this.github = require('@actions/github')
	}

	/**
	 * State that is required for the output of the action, even if it is
	 * skipped or fails prematurely.  Not in the constructor so tests can inject
	 * the github context post construction.
	 */
	async postConstruct() {
		const {serverUrl, runId, repo} = this.github.context
		this.repoUrl = `${serverUrl}/${repo.owner}/${repo.repo}`
		this.actionUrl = `${this.repoUrl}/actions/runs/${runId}`

		// If an unexpected failure occurs linking to the action is good enough (for the slack footer)
		// Merge conflicts will generate a more descriptive warning below.
		this.core.setOutput('status-message', `<${this.actionUrl}|Action Run>`)
		this.core.setOutput('status', 'success')
	}

	async runAction() {

		await this.postConstruct()

		const {pullRequest} = this.options
		if (!pullRequest.merged) {
			// There is no 'merged' activity type that can be specified in the workflow trigger.
			// So checking if the PR was merged here and aborting the action is the best we can do
			this.core.info('PR was closed without being merged, aborting...')
			return
		}

		await this.initializeState()

		if (!this.terminalBranch) {
			this.core.info(`PR was against terminal branch, no merges required.`)
			return
		}

		this.issueNumber = await findIssueNumber({action: this, pullRequest})

		await this.runMerges()
	}

	async runMerges() {
		const username = `Spider Merge Bot`
		const userEmail = `merge-bot@spiderstrategies.com`
		this.core.info(`Assigning git identity to ${username} <${userEmail}>`)
		await this.exec(`git config user.email "${userEmail}"`)
		await this.exec(`git config user.name "${username}"`)

		// Attempt to merge each specified branch
		await this.executeMerges(this.config.mergeTargets)
	}

	/**
	 * If the action fails, this method should be invoked and NOT
	 * this.core.setFailed() directly.
	 */
	async onError(err) {
		await super.onError(err);
		// This is required for the slack integration, don't change it
		this.core.setOutput('status', 'failure')
	}

	/**
	 * Reads the config and the event, storing contextual information on this
	 * action instance.
	 */
	async initializeState() {
		const { configFile, prNumber, prBranch, prTitle, pullRequest = {}, baseBranch } = this.options
		const { merge_commit_sha } = pullRequest

		if (configFile) { // let tests bypass this
			this.config = configReader(configFile, { baseBranch })
		}

		if (this.config && this.config.mergeTargets) {
			this.terminalBranch = this.config.mergeTargets[this.config.mergeTargets.length - 1]
			this.core.info(`mergeTargets: ${JSON.stringify(this.config.mergeTargets)}`)
			this.core.info(`terminal branch: ${this.terminalBranch}`)
		}

		const trimmedMessage = await this.exec(`git show -s --format=%B ${merge_commit_sha}`)
		this.setOriginalPrNumber(prBranch, prNumber)
		this.core.info(`PR title: ${prTitle}`)
		this.core.info(`Original PR Number: ${this.originalPrNumber}`)
		this.core.info(`trimmedMessage: ${trimmedMessage}`)
	}

	setOriginalPrNumber(prBranch, prNumber) {
		// Tap tests fail if the regex is a constant
		const prRegexResults = /issue-\w*-pr-(\d*)-conflicts[\w|-]*/g.exec(prBranch)
		this.originalPrNumber = prRegexResults && prRegexResults.length > 1 ? prRegexResults[1] : prNumber
	}

	async executeMerges(mergeTargets) {
		const targetMergeCount = mergeTargets.length
		this.core.info(`Merge Targets: ${mergeTargets}`)

		let mergeCount = 0
		for (; mergeCount < targetMergeCount; mergeCount++){
			const branch = mergeTargets[mergeCount]
			this.startGroup(`Merging into ${branch}...`)

			await this.exec(`git checkout ${branch}`)
			try {
				if(!await this.merge({branch})) {
					break;
				}
			} catch (e) {
				await this.onError(e)
				break;
			} finally {
				this.endGroup()
			}
		}
		const allMergesPassed = mergeCount === targetMergeCount

		if (allMergesPassed) {
			this.core.info(`All merges are complete`)
			await this.deleteBranch(this.options.prBranch)
		} else if (this.conflictBranch) {
			this.generateMergeConflictWarning()
		}
		return allMergesPassed
	}

	// This will be displayed in the warning annotation on the workflow run
	// AND included in the slack message
	generateMergeConflictWarning() {
		const { prNumber} = this.options
		// Slack is "special" https://api.slack.com/reference/surfaces/formatting#linking-urls
		this.statusMessage = `<${this.repoUrl}/issues/${prNumber}|PR #${prNumber}> ` +
			`<${this.issueUrl}|Issue> ` +
			`<${this.actionUrl}|Action Run>`
		this.core.warning(this.statusMessage)
		// This becomes the footer in slack notifications
		this.core.setOutput('status-message', this.statusMessage)
		// This is used to detect error vs warning for slack notifications
		this.core.setOutput('status', 'warning')
	}

	/**
	 * Attempts the merge the PR branch into [branch]
	 *
	 * @returns {Promise<Boolean>} Whether or not to continue merging into
	 *     other branches true if the merge was successful or skipped false if
	 *     there were conflicts
	 */
	async merge({branch,
		// Use "no fastforward" flag to make sure there are always changes to commit;
		// otherwise, this will break when a new release branch has been created, but
		// is still identical to the previous release branch. Example:
		// https://github.com/SpiderStrategies/Scoreboard/actions/runs/19943416287/job/57186800013
		options = `--no-commit --no-ff`
	}) {
		const { pullRequest, baseBranch, prNumber, prBranch } = this.options
		const sha = pullRequest.head.sha // This is the commit that was just merged into the PRs base
		const commitMessage = `auto-merge of ${sha} into \`${branch}\` from \`${prBranch}\` ` +
			`triggered by (#${prNumber}) on \`${baseBranch}\``

		this.core.info(commitMessage)

		let mergeResult
		try {
			await this.exec(`git pull`) // Try to minimize chances of repo being out of date with origin (because of concurrent actions)
			mergeResult = await this.exec(`git merge ${sha} ${options}`)
			this.core.info(mergeResult)
		} catch(e) {
			await this.handleConflicts(branch)
			return false
		}

		// Already merged into this branch (not expected, but lets handle it (and just skip over))
		const alreadyMerged = mergeResult.includes(UP_TO_DATE)
		if (!alreadyMerged) {
			const commits = await this.fetchCommits(this.options.prNumber)
			const lastCommit = commits.data.map(c => c.commit).pop()
			await this.commit(commitMessage, lastCommit.author)
		}
		return true
	}

	async handleConflicts(branch) {
		const conflicts = await this.exec(`git diff --name-only --diff-filter=U`)
		if (conflicts.length > 0) {
			console.log(`Conflicts found:\n`, conflicts)
			this.conflictBranch = branch
			const newIssueNumber = await this.createIssue({ branch, conflicts })
			await this.exec(`git reset --hard ${branch}`) // must wipe out any local changes from merge
			
			// Create merge-conflicts branch with encoded source and target
			// Format: merge-conflicts-NNNNN-{sourceBranch}-to-{targetBranch}
			const sourceBranch = this.options.baseBranch
			const encodedBranchName = this.createMergeConflictsBranchName(newIssueNumber, sourceBranch, branch)
			await this.createBranch(encodedBranchName, this.options.prCommitSha)
			await new IssueResolver(this).resolveIssues()
		}
	}

	/**
	 * Creates a merge-conflicts branch name that encodes the source and target branches
	 * Format: merge-conflicts-NNNNN-{sourceBranch}-to-{targetBranch}
	 * Example: merge-conflicts-68586-release-5-8-0-to-main
	 */
	createMergeConflictsBranchName(issueNumber, sourceBranch, targetBranch) {
		const normalizeForBranchName = (branch) => branch.replace(/\./g, '-')
		const normalizedSource = normalizeForBranchName(sourceBranch)
		const normalizedTarget = normalizeForBranchName(targetBranch)
		return `${MB_BRANCH_FAILED_PREFIX}${issueNumber}-${normalizedSource}-to-${normalizedTarget}`
	}

	async createIssue({branch, conflicts}) {
		const issueNumber = this.issueNumber
		const branchObj = this.config.branches[branch] || {}
		const title = `Merge${issueNumber ? ' #' + issueNumber : ''} (${this.options.prCommitSha.substring(0,9)}) into ${branch}`

		// https://docs.github.com/en/rest/issues/issues#create-an-issue
		const newIssueResponse = await this.execRest(
			(api, opts) => api.issues.create(opts),
			{
				title,
				milestone: branchObj.milestoneNumber,
				labels: [`high priority`, 'merge conflict']
			},
			'to create issue'
		)
		const { number: conflictIssueNumber, html_url } = newIssueResponse.data
		// Have to write comment and update after issue is created because
		// we need to reference the issue number in the comment
		const bodyFile = await this.writeComment({branch, issueNumber, conflicts, conflictIssueNumber})
		await this.exec(`gh issue edit ${conflictIssueNumber} --body-file ${bodyFile} --add-assignee "${this.options.prAuthor}"`)

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
	 * @returns {Promise<string>}
	 */
	async writeComment({branch, issueNumber, conflicts, conflictIssueNumber}) {
		const branchAlias = this.config.getBranchAlias(branch)
		const newBranch = this.conflictsBranchName(issueNumber, branchAlias, this.originalPrNumber)
		const { prNumber, prAuthor, prCommitSha } = this.options
		const issueText = issueNumber ? `for issue #${issueNumber}` : ``
		let lines = [`## Automatic Merge Failed`,
			`@${prAuthor} changes from pull request #${prNumber} ${issueText} couldn't be [merged forward automatically](${this.actionUrl}). `,
			`Please submit a new pull request against the \`${branch}\` branch that includes the changes. `,
			`The sooner you have a chance to do this the fewer conflicts you'll run into, so you may want to tackle this soon.`,
			`### Details`,
			`Run these commands to perform the merge, then open a new pull request against the \`${branch}\` branch.`,
			`1. \`git fetch\``,
			`1. \`git checkout --no-track -b ${newBranch} ${this.getOriginBranchForConflict(branch)}\``,
			`1. \`git merge ${prCommitSha} -m "Merge commit ${prCommitSha} into ${newBranch} Fixes #${conflictIssueNumber}"\``,
			`1. \`git push --set-upstream origin ${newBranch}\``,
			`1. \`createPR -b ${branch}\` (Optional; requires [Spider Shell](https://github.com/SpiderStrategies/spider-shell))`,
			``,
			`#### There were conflicts in these files:`,
			conflicts.split(`\n`).map(c => `- ${c}`).join('\n') + `\n`
		]

		const filename = '.issue-comment.txt'
		await writeFile(filename, lines.join('\n'))
		return filename
	}

	/**
	 * We don't use a branch-here branch for the terminalBranch.
	 * This function figures out the origin branch to reference
	 * in the merge instructions based on this rule.
	 */
	getOriginBranchForConflict(branchName) {
		let branch = branchName
		if (this.terminalBranch !== branchName) {
			branch = MB_BRANCH_HERE_PREFIX + branch
		}
		return `origin/${branch}`
	}

	conflictsBranchName(issueNumber, branchAlias, originalPrNumber) {
		return `issue-${issueNumber}-pr-${originalPrNumber}-conflicts-${branchAlias.replaceAll(' ', '-')}`
	}
}

module.exports = AutoMergeAction
