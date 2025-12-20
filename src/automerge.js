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
		options = `--no-commit`
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

		// If already up to date, nothing was merged
		const mergePerformed = !mergeResult.includes(UP_TO_DATE)
		if (mergePerformed) {
			// Run linters before committing the merge
			const lintingPassed = await this.runLinters(branch)
			if (!lintingPassed) {
				return false
			}

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
	 * Runs linting checks on the merged code before committing
	 * Auto-fixes ESLint violations when possible, only creates issue if manual fixes needed
	 * @param {String} branch The branch being merged into
	 * @returns {Promise<Boolean>} true if linting passed, false if violations found
	 */
	async runLinters(branch) {
		this.core.info('Running linters on merged code...')

		// Check if config files exist (older branches might not have them)
		const hasSemgrepConfig = await this.fileExists('semgrep.yml')
		const hasEslintConfig = await this.fileExists('cms/web/static/.eslintrc.js')

		let lintingFailed = false
		const violations = []

		// Run ESLint with auto-fix if configuration exists
		if (hasEslintConfig) {
			this.core.info('Running ESLint with auto-fix...')
			try {
				await this.exec('cd cms/web/static && npm install --no-save 2>&1')
				// Use the standardized lintfix task (auto-fixes, then checks)
				await this.exec('npm --prefix cms/web/static run lintfix 2>&1 || true')
				// Stage any auto-fixes
				await this.exec('git add -A')
				// Now check if any violations remain using the standard lint task
				await this.exec('npm --prefix cms/web/static run lintfull')
				this.core.info('✅ ESLint passed (all violations auto-fixed)')
			} catch (e) {
				lintingFailed = true
				violations.push('ESLint')
				this.core.warning('❌ ESLint found violations that require manual fixes')
			}
		}

		// Run semgrep if configuration exists (uses Gradle task)
		if (hasSemgrepConfig) {
			this.core.info('Running semgrep...')
			try {
				// Use the standardized Gradle semgrep task
				await this.exec('cd cms && ./gradlew semgrep')
				this.core.info('✅ Semgrep passed')
			} catch (e) {
				lintingFailed = true
				violations.push('Semgrep')
				this.core.warning('❌ Semgrep found violations')
			}
		}

		if (lintingFailed) {
			await this.handleLintingFailure(branch, violations)
			return false
		}

		return true
	}

	async handleLintingFailure(branch, violations) {
		this.core.warning(`Linting failed: ${violations.join(', ')}`)
		this.conflictBranch = branch

		// Reset the merge - developer will redo it
		await this.exec(`git reset --hard ${branch}`)

		// Create issue for developer to fix violations
		await this.createLintingIssue({ branch, violations })
	}

	async createLintingIssue({branch, violations}) {
		const issueNumber = this.issueNumber
		const branchObj = this.config.branches[branch] || {}
		const title = `Linting violations in merge${issueNumber ? ' #' + issueNumber : ''} (${this.options.prCommitSha.substring(0,9)}) into ${branch}`

		const newIssueResponse = await this.execRest(
			(api, opts) => api.issues.create(opts),
			{
				title,
				milestone: branchObj.milestoneNumber,
				labels: [`high priority`, 'merge conflict']
			},
			'to create linting issue'
		)
		const { number: conflictIssueNumber, html_url } = newIssueResponse.data

		const bodyFile = await this.writeLintingComment({branch, issueNumber, violations, conflictIssueNumber})
		await this.exec(`gh issue edit ${conflictIssueNumber} --body-file ${bodyFile} --add-assignee "${this.options.prAuthor}"`)

		this.issueUrl = html_url
		this.core.info(`Created linting issue: ${html_url}`)

		return conflictIssueNumber
	}

	async writeLintingComment({branch, issueNumber, violations, conflictIssueNumber}) {
		const sourceBranch = this.options.baseBranch
		const newBranch = this.createMergeConflictsBranchName(conflictIssueNumber, sourceBranch, branch)
		const { prNumber, prAuthor } = this.options
		const issueText = issueNumber ? `for issue #${issueNumber}` : ``

		// Build linting steps dynamically based on which linters failed
		const lintSteps = []

		// Plain English step explaining what to do
		lintSteps.push(`4. Resolve the linting violations:`)

		let stepNum = 5

		// Only add ESLint step if ESLint found violations
		if (violations.includes('ESLint')) {
			lintSteps.push(`   - \`npm --prefix cms/web/static run lintfix\` (auto-fixes what it can, then shows remaining violations)`)
			lintSteps.push(`   - Fix any remaining ESLint violations`)
		}

		// Only add semgrep step if semgrep found violations
		if (violations.includes('Semgrep')) {
			lintSteps.push(`   - \`./cms/gradlew semgrep\` (shows violations requiring manual fixes)`)
			lintSteps.push(`   - Fix any remaining semgrep violations`)
		}

		lintSteps.push(`${stepNum}. \`git add -A && git commit -m "Fix linting violations - Fixes #${conflictIssueNumber}"\``)

		let lines = [`## Automatic Merge Failed - Linting Violations`,
			`@${prAuthor} changes from pull request #${prNumber} ${issueText} couldn't be [merged forward automatically](${this.actionUrl}) due to linting violations.`,
			``,
			`### Violations Found`,
			violations.join(', '),
			``,
			`### Fix Instructions`,
			`Run these commands to fix the violations and submit a new pull request against the \`${branch}\` branch:`,
			``,
			`1. \`git fetch\``,
			`2. \`git checkout --no-track -b ${newBranch} ${this.getOriginBranchForConflict(branch)}\``,
			`3. \`${this.getMergeCommitMessage(newBranch, conflictIssueNumber)}\``,
			...lintSteps,
			`${stepNum + 1}. \`git push --set-upstream origin ${newBranch}\``,
			`${stepNum + 2}. Create a PR against \`${branch}\` (use \`createPR -b ${branch}\` if you have [Spider Shell](https://github.com/SpiderStrategies/spider-shell))`,
			``
		]

		const filename = '.linting-issue-comment.txt'
		await writeFile(filename, lines.join('\n'))
		return filename
	}

	async fileExists(filepath) {
		try {
			await this.exec(`test -f ${filepath}`)
			return true
		} catch (e) {
			return false
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
		const sourceBranch = this.options.baseBranch
		const newBranch = this.createMergeConflictsBranchName(conflictIssueNumber, sourceBranch, branch)
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
			`1. \`${this.getMergeCommitMessage(newBranch, conflictIssueNumber)}\``,
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

	/**
	 * Generates the merge commit message for resolving conflicts/linting issues
	 * DRY: Used by both merge conflict and linting issue instructions
	 */
	getMergeCommitMessage(newBranch, conflictIssueNumber) {
		const { prCommitSha } = this.options
		return `git merge ${prCommitSha} -m "Merge commit ${prCommitSha} into ${newBranch} Fixes #${conflictIssueNumber}"`
	}
}

module.exports = AutoMergeAction
