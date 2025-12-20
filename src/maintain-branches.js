const { findIssueNumber, configReader, BaseAction } = require('gh-action-components')
const { MB_BRANCH_FAILED_PREFIX, MB_BRANCH_HERE_PREFIX } = require('./constants')
const findCleanMergeRef = require('./find-clean-merge-ref')

/**
 * Invoked by the spider-merge-bot.yml GitHub Action Workflow
 * Runs with the node version shipped with `ubuntu-latest`
 *
 * See the original issue for more details/links:
 * https://github.com/SpiderStrategies/Scoreboard/issues/42921
*/
class BranchMaintainerAction extends BaseAction {

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

	/**
	 * Preconditions:
	 * 1. The issue is tagged with `merge-conflict`
	 * 2. The issue is closed.
	 *
	 * Given a closed issue, delete it's merge-conflict branch and initiate
	 * branch maintenance.
	 */
	async runAction() {
		await this.postConstruct()
		await this.readConfig()
		await this.deleteBranch()
		await this.maintainBranches()
	}

	async deleteBranch() {
		// Only delete this branch if it's a merge-conflict branch
		const branch = this.options.pullRequest.head.ref || ''
		const regex = /issue-\d*-pr-\d*-conflicts-*/g.exec(branch)

		if (regex?.length) {
			// Conflicts PR was just closed. Extract the "fixes issue" from this pull request
			const issue = await findIssueNumber({action: this, pullRequest: this.options.pullRequest})
			if (issue) {
				await super.deleteBranch(MB_BRANCH_FAILED_PREFIX + issue)
			}
		}
	}

	/**
	 * Reads the config and the event, storing contextual information on this
	 * action instance.
	 */
	async readConfig() {
		const { configFile, baseBranch } = this.options
		if (configFile) { // let tests bypass this
			this.config = configReader(configFile, { baseBranch })
		}
	}

	async maintainBranches() {
		const branches = Object.keys(this.config.branches)
		this.terminalBranch = branches[branches.length - 1]
		this.core.info(`branches: ${JSON.stringify(branches)}`)
		this.core.info(`terminal branch: ${this.terminalBranch}`)
		for (const branch of branches) {
			// We're at the end of the line, we don't use branch-here for this one
			if (branch === this.terminalBranch) {
				this.core.info(`At terminal branch (${branch}), no maintenance required`)
				break
			}
			this.startGroup(`Maintaining branch-here pointers for branch: ${branch}`)
			try {
				await this.exec(`git checkout ${branch}`)
				// Get the target branch this source branch merges into
				const targetBranch = this.config.mergeOperations?.[branch]
				let cleanMergePoint = await findCleanMergeRef(this, branch, targetBranch)
				if (cleanMergePoint) {
					await this.fastForward(MB_BRANCH_HERE_PREFIX + branch, cleanMergePoint)
				}
			} catch (e) {
				await this.onError(e)
				break
			}finally {
				this.endGroup()
			}
		}
	}

	/**
	 * The action failed, report it.
	 */
	async onError(err) {
		await super.onError(err)
		// Needed for slack integration
		this.core.setOutput('status', 'failure')
	}

	/**
	 * Fast-forwards a branch to a new commit
	 */
	async fastForward(branch, cleanMergePoint) {
		const branchExists = await this.exec(`git ls-remote --heads origin ${branch}`)
		if (branchExists) {
			await this.exec(`git checkout ${branch}`)
			await this.exec(`git pull`)
			await this.exec(`git merge --ff-only ${cleanMergePoint}`)
		} else {
			await this.exec(`git checkout -b ${branch} ${cleanMergePoint}`)
		}
		await this.exec(`git push --set-upstream origin ${branch}`)
	}
}

module.exports = BranchMaintainerAction
