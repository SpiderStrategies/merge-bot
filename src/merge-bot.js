const core = require('@actions/core')
const github = require('@actions/github')

const AutoMergeAction = require('./automerge')
const BranchMaintainerAction = require('./maintain-branches')
const { configReader } = require('gh-action-components')

const { pull_request, repository } = github.context.payload
const configFile = core.getInput('config-file', { required: true })

const { number: prNumber, title, base, head, user } = pull_request

async function run() {
	// Build options for both phases
	const options = {
		configFile,
		pullRequest: pull_request,
		repository,
		prNumber,
		prAuthor: user.login,
		prTitle: title,
		prBranch: head.ref,
		baseBranch: base.ref,
		prCommitSha: head.sha,
	}

	// Determine terminal branch to know when commits reach the end
	const config = configReader(configFile, { baseBranch: base.ref })
	const terminalBranch = determineTerminalBranch(config)

	// Phase 1: Merge forward
	const automerge = new AutoMergeAction(options)
	await automerge.run()

	// Phase 2: Maintain branch-here pointers
	await maintainBranchHerePointers(automerge, terminalBranch)
}

/**
 * Determines the terminal branch (last branch in the merge chain, typically main).
 *
 * @param {Object} config The configuration object containing branch definitions
 * @returns {string} The name of the terminal branch
 */
function determineTerminalBranch(config) {
	const branches = Object.keys(config.branches)
	return branches[branches.length - 1]
}

/**
 * Maintains branch-here pointers by updating them to the latest commit that
 * successfully merged all the way to main.
 *
 * CRITICAL: Only runs when commits have merged ALL THE WAY to main.
 * This ensures branch-here branches only include commits that have successfully
 * merged through the entire release chain, preventing users from inheriting
 * conflicts from earlier in the chain.
 *
 * Run conditions:
 * 1. PR was merged directly to main (terminal branch)
 * 2. Conflict resolution PR merged to main
 * 3. Automerge completed successfully all the way to main
 *
 * @param {AutoMergeAction} automerge The automerge action instance
 * @param {string} terminalBranch The terminal branch (typically main)
 */
async function maintainBranchHerePointers(automerge, terminalBranch) {
	if (!pull_request.merged) {
		core.info('PR was not merged, skipping branch maintenance')
		return
	}

	const isTerminalBranch = base.ref === terminalBranch
	const automergeSucceeded = automerge.conflictBranch === undefined
	const commitsReachedMain = isTerminalBranch || automergeSucceeded

	if (commitsReachedMain) {
		core.info(`Running branch maintenance: commits reached main (isTerminalBranch=${isTerminalBranch}, automergeSucceeded=${automergeSucceeded})`)
		const maintainer = new BranchMaintainerAction({
			configFile,
			pullRequest: pull_request,
		})
		await maintainer.run()
	} else {
		core.info(`Skipping branch maintenance: commits blocked at ${automerge.conflictBranch}, have not reached main yet`)
	}
}

run()

